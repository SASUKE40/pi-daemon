#!/usr/bin/env node
import { chmod, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { getAppPaths, safeSocketFallback } from "./paths.js";
import {
  event,
  parseClientCommand,
  type ClientCommand,
  type ImageAttachment,
  type ServerEvent,
  type SessionSnapshot,
  type SessionSummary,
  type ThinkingLevel,
} from "./protocol.js";

interface RuntimeSession {
  session: AgentSession;
  seq: number;
  unsubscribe: () => void;
}

export interface SessionDaemonHandle {
  socketPath: string;
  close(): Promise<void>;
}

export class SessionDaemon {
  private readonly clients = new Set<Socket>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private server?: Server;
  private activeSessionId: string | undefined;
  private socketPath: string;

  constructor(socketPath = getAppPaths().socketPath) {
    this.socketPath = socketPath;
  }

  async start(): Promise<SessionDaemonHandle> {
    await mkdir(getAppPaths().runtimeDir, { recursive: true, mode: 0o700 });
    await this.removeStaleSocket();
    try {
      await this.listen();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw error;
      this.socketPath = safeSocketFallback();
      await this.removeStaleSocket();
      await this.listen();
    }
    await chmod(this.socketPath, 0o600);
    log.info("session daemon listening", { socketPath: this.socketPath });
    return { socketPath: this.socketPath, close: () => this.close() };
  }

  async close(): Promise<void> {
    for (const runtime of this.sessions.values()) {
      runtime.unsubscribe();
      if (runtime.session.isStreaming) await runtime.session.abort().catch(() => undefined);
    }
    for (const client of this.clients) client.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    await unlink(this.socketPath).catch(() => undefined);
  }

  private async listen(): Promise<void> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const info = await stat(this.socketPath);
      if (!info.isSocket()) throw new Error(`Refusing to replace non-socket path: ${this.socketPath}`);
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    this.write(socket, event({ type: "ready", ...(this.activeSessionId ? { activeSessionId: this.activeSessionId } : {}) }));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", (error) => log.warn("IPC client error", { message: error.message }));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let command: ClientCommand | undefined;
    try {
      command = parseClientCommand(JSON.parse(line));
      await this.handleCommand(socket, command);
    } catch (error) {
      this.write(socket, event({
        type: "error",
        ...(command ? { requestId: command.requestId } : {}),
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async handleCommand(socket: Socket, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "session.list": {
        const sessions = (await SessionManager.listAll()).map(toSummary);
        this.write(socket, event({ type: "session.list", requestId: command.requestId, sessions }));
        return;
      }
      case "session.create": {
        const cwd = await validateCwd(command.cwd);
        const manager = SessionManager.create(cwd);
        const runtime = await this.loadRuntime(manager);
        if (command.name?.trim()) runtime.session.sessionManager.appendSessionInfo(command.name.trim());
        if (command.model) await this.setModel(runtime, command.model.provider, command.model.id);
        if (command.thinking) runtime.session.setThinkingLevel(command.thinking);
        this.write(socket, event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        return;
      }
      case "session.open": {
        const runtime = await this.getOrOpen(command.sessionId);
        this.write(socket, event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        return;
      }
      case "session.rename": {
        const runtime = await this.getOrOpen(command.sessionId);
        runtime.session.sessionManager.appendSessionInfo(command.name.trim());
        this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        return;
      }
      case "session.prompt": {
        const runtime = await this.getOrOpen(command.sessionId);
        if (this.activeSessionId) {
          this.write(socket, event({
            type: "error", requestId: command.requestId, code: "daemon_busy",
            message: "Another Pi session is currently running", activeSessionId: this.activeSessionId,
          }));
          return;
        }
        this.activeSessionId = runtime.session.sessionId;
        this.emitStatus(runtime, "running");
        const images = toImages(command.attachments);
        void runtime.session.prompt(command.text, images ? { images } : {}).catch((error) => {
          this.emitStatus(runtime, "error", error instanceof Error ? error.message : String(error));
        }).finally(() => {
          if (this.activeSessionId === runtime.session.sessionId) this.activeSessionId = undefined;
          this.emitStatus(runtime, "idle");
        });
        return;
      }
      case "session.steer":
      case "session.followUp": {
        const runtime = await this.getOrOpen(command.sessionId);
        if (this.activeSessionId !== runtime.session.sessionId || !runtime.session.isStreaming) throw new Error("Session is not currently running");
        const images = toImages(command.attachments);
        if (command.type === "session.steer") await runtime.session.steer(command.text, images);
        else await runtime.session.followUp(command.text, images);
        this.emitQueue(runtime);
        return;
      }
      case "session.abort": {
        const runtime = await this.getOrOpen(command.sessionId);
        if (runtime.session.isStreaming) {
          this.emitStatus(runtime, "aborting");
          await runtime.session.abort();
        }
        return;
      }
      case "session.setModel": {
        const runtime = await this.getOrOpen(command.sessionId);
        if (runtime.session.isStreaming) throw new Error("Cannot change model while running");
        await this.setModel(runtime, command.provider, command.modelId);
        this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        return;
      }
      case "session.setThinking": {
        const runtime = await this.getOrOpen(command.sessionId);
        runtime.session.setThinkingLevel(command.thinking);
        this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
      }
    }
  }

  private async getOrOpen(id: string): Promise<RuntimeSession> {
    const loaded = this.sessions.get(id);
    if (loaded) return loaded;
    const info = (await SessionManager.listAll()).find((item) => item.id === id || item.path === id);
    if (!info) throw new Error(`Session not found: ${id}`);
    return this.loadRuntime(SessionManager.open(info.path));
  }

  private async loadRuntime(manager: SessionManager): Promise<RuntimeSession> {
    const existing = this.sessions.get(manager.getSessionId());
    if (existing) return existing;
    const config = await loadConfig();
    const settingsManager = SettingsManager.create(manager.getCwd(), config.agentDir);
    const extensionPath = createRequire(import.meta.url).resolve("@edward40/pi-computer-use");
    const resourceLoader = new DefaultResourceLoader({
      cwd: manager.getCwd(),
      agentDir: config.agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      noExtensions: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: manager.getCwd(),
      agentDir: config.agentDir,
      sessionManager: manager,
      settingsManager,
      resourceLoader,
    });
    const runtime: RuntimeSession = { session, seq: 0, unsubscribe: () => undefined };
    runtime.unsubscribe = session.subscribe((agentEvent) => this.onAgentEvent(runtime, agentEvent));
    this.sessions.set(session.sessionId, runtime);
    return runtime;
  }

  private onAgentEvent(runtime: RuntimeSession, agentEvent: AgentSessionEvent): void {
    this.broadcast(event({ type: "session.event", sessionId: runtime.session.sessionId, seq: ++runtime.seq, event: agentEvent }));
    if (agentEvent.type === "queue_update") this.emitQueue(runtime);
  }

  private emitQueue(runtime: RuntimeSession): void {
    this.broadcast(event({
      type: "queue.update", sessionId: runtime.session.sessionId, seq: ++runtime.seq,
      steering: runtime.session.getSteeringMessages(), followUp: runtime.session.getFollowUpMessages(),
    }));
  }

  private emitStatus(runtime: RuntimeSession, status: "idle" | "running" | "aborting" | "error", message?: string): void {
    this.broadcast(event({
      type: "session.status", sessionId: runtime.session.sessionId, seq: ++runtime.seq, status,
      ...(message ? { message } : {}),
    }));
  }

  private async setModel(runtime: RuntimeSession, provider: string, modelId: string): Promise<void> {
    const model = runtime.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    await runtime.session.setModel(model);
  }

  private write(socket: Socket, serverEvent: ServerEvent): void {
    if (socket.writable) socket.write(`${JSON.stringify(serverEvent)}\n`);
  }

  private broadcast(serverEvent: ServerEvent): void {
    for (const socket of this.clients) this.write(socket, serverEvent);
  }
}

function snapshot(runtime: RuntimeSession): SessionSnapshot {
  const { session } = runtime;
  const model = session.model;
  return {
    id: session.sessionId,
    cwd: session.sessionManager.getCwd(),
    ...(session.sessionName ? { name: session.sessionName } : {}),
    ...(session.sessionFile ? { path: session.sessionFile } : {}),
    ...(model ? { model: { provider: model.provider, id: model.id, ...(model.name ? { name: model.name } : {}) } } : {}),
    thinking: session.thinkingLevel as ThinkingLevel,
    streaming: session.isStreaming,
    messages: session.state.messages,
    availableModels: session.modelRuntime.getAvailableSnapshot().map((item) => ({
      provider: item.provider,
      id: item.id,
      ...(item.name ? { name: item.name } : {}),
    })),
  };
}

function toSummary(info: Awaited<ReturnType<typeof SessionManager.listAll>>[number]): SessionSummary {
  return {
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    ...(info.name ? { name: info.name } : {}),
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
  };
}

function toImages(attachments?: ImageAttachment[]): ImageContent[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment) => {
    if (!attachment.data) throw new Error(`Attachment data missing: ${attachment.id ?? "unknown"}`);
    return { type: "image", mimeType: attachment.mimeType, data: attachment.data };
  });
}

async function validateCwd(input: string): Promise<string> {
  const cwd = await realpath(input);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory");
  return cwd;
}

export async function startSessionDaemon(socketPath?: string): Promise<SessionDaemonHandle> {
  return new SessionDaemon(socketPath).start();
}

async function main(): Promise<void> {
  const handle = await startSessionDaemon();
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    log.error("session daemon failed", { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
