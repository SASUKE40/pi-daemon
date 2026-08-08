#!/usr/bin/env node
import { chmod, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { marked, Renderer, type Tokens } from "marked";
import { activeRelay, loadConfig } from "./config.js";
import { log } from "./log.js";
import { getAppPaths, safeSocketFallback } from "./paths.js";
import { PushService, type PushNotification } from "./push.js";
import { getSlashCommands } from "./slash-commands.js";
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
  runActive: boolean;
  unsubscribe: () => void;
  notifications: SessionNotificationTracker;
}

export type SessionInfo = Awaited<ReturnType<typeof SessionManager.listAll>>[number];

export interface SessionDaemonDependencies {
  listSessions(): Promise<SessionInfo[]>;
  createManager(cwd: string): SessionManager;
  openManager(path: string): SessionManager;
  createSession(manager: SessionManager): Promise<AgentSession>;
}

const defaultDependencies: SessionDaemonDependencies = {
  listSessions: () => SessionManager.listAll(),
  createManager: (cwd) => SessionManager.create(cwd),
  openManager: (path) => SessionManager.open(path),
  createSession: createRuntimeSession,
};

export interface SessionDaemonHandle {
  socketPath: string;
  close(): Promise<void>;
}

export class SessionDaemon {
  private readonly clients = new Set<Socket>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly sessionLoads = new Map<string, Promise<RuntimeSession>>();
  private server?: Server;
  private socketPath: string;
  private readonly push: PushService;

  constructor(
    socketPath = getAppPaths().socketPath,
    push = new PushService(),
    private readonly dependencies = defaultDependencies,
  ) {
    this.socketPath = socketPath;
    this.push = push;
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
    const runtimes = [...this.sessions.values()];
    for (const runtime of runtimes) runtime.unsubscribe();
    await Promise.all(runtimes.filter(isRuntimeRunning).map((runtime) => runtime.session.abort().catch(() => undefined)));
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
    const activeSessionIds = this.activeSessionIds();
    this.write(socket, event({
      type: "ready",
      ...(activeSessionIds.length ? {
        activeSessionIds,
        activeSessionId: activeSessionIds[activeSessionIds.length - 1] as string,
      } : {}),
    }));
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
        const sessions = (await this.dependencies.listSessions()).map(toSummary);
        this.write(socket, event({ type: "session.list", requestId: command.requestId, sessions }));
        return;
      }
      case "session.create": {
        const cwd = await ensureWorkingDirectory(command.cwd);
        const manager = this.dependencies.createManager(cwd);
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
        if (isRuntimeRunning(runtime)) {
          this.write(socket, event({
            type: "error", requestId: command.requestId, code: "session_busy",
            message: "This Pi session is already running",
          }));
          return;
        }
        const images = toImages(command.attachments);
        runtime.runActive = true;
        runtime.notifications.begin();
        this.emitStatus(runtime, "running");
        void runtime.session.prompt(command.text, images ? { images } : {}).then(() => {
          const notification = runtime.notifications.complete(runtime.session.sessionId);
          if (notification) void this.notify(notification);
        }).catch((error) => {
          const message = error instanceof Error ? error.message : "Session failed";
          const notification = runtime.notifications.fail(runtime.session.sessionId, message);
          if (!notification) return;
          this.emitStatus(runtime, "error", message);
          void this.notify(notification);
        }).finally(() => {
          runtime.runActive = false;
          this.emitStatus(runtime, "idle");
        });
        return;
      }
      case "session.steer":
      case "session.followUp": {
        const runtime = await this.getOrOpen(command.sessionId);
        if (!runtime.runActive || !runtime.session.isStreaming) throw new Error("Session is not currently running");
        const images = toImages(command.attachments);
        if (command.type === "session.steer") await runtime.session.steer(command.text, images);
        else await runtime.session.followUp(command.text, images);
        this.emitQueue(runtime);
        return;
      }
      case "session.abort": {
        const runtime = await this.getOrOpen(command.sessionId);
        if (isRuntimeRunning(runtime)) {
          runtime.notifications.abort();
          this.emitStatus(runtime, "aborting");
          await runtime.session.abort();
        }
        return;
      }
      case "session.setModel": {
        const runtime = await this.getOrOpen(command.sessionId);
        if (isRuntimeRunning(runtime)) throw new Error("Cannot change model while running");
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
    const info = (await this.dependencies.listSessions()).find((item) => item.id === id || item.path === id);
    if (!info) throw new Error(`Session not found: ${id}`);
    return this.loadRuntime(this.dependencies.openManager(info.path));
  }

  private async loadRuntime(manager: SessionManager): Promise<RuntimeSession> {
    const sessionId = manager.getSessionId();
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.sessionLoads.get(sessionId);
    if (pending) return pending;
    const loading = this.initializeRuntime(manager);
    this.sessionLoads.set(sessionId, loading);
    try {
      return await loading;
    } finally {
      if (this.sessionLoads.get(sessionId) === loading) this.sessionLoads.delete(sessionId);
    }
  }

  private async initializeRuntime(manager: SessionManager): Promise<RuntimeSession> {
    const session = await this.dependencies.createSession(manager);
    const runtime: RuntimeSession = {
      session,
      seq: 0,
      runActive: session.isStreaming,
      unsubscribe: () => undefined,
      notifications: new SessionNotificationTracker(),
    };
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) => this.broadcast(event({
        type: "error",
        code: "extension_error",
        message: `Extension ${error.event} failed: ${error.error}`,
      })),
    });
    runtime.unsubscribe = session.subscribe((agentEvent) => this.onAgentEvent(runtime, agentEvent));
    this.sessions.set(session.sessionId, runtime);
    return runtime;
  }

  private activeSessionIds(): string[] {
    return [...this.sessions.values()].filter(isRuntimeRunning).map((runtime) => runtime.session.sessionId);
  }

  private onAgentEvent(runtime: RuntimeSession, agentEvent: AgentSessionEvent): void {
    if (agentEvent.type === "message_end") {
      runtime.notifications.capture(agentEvent.message);
    }
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

  private async notify(notification: PushNotification): Promise<void> {
    try {
      const config = await loadConfig();
      const subject = activeRelay(config) === "cloudflare" && config.cloudflare?.allowedEmail
        ? `mailto:${config.cloudflare.allowedEmail}`
        : activeRelay(config) === "cloudflare" && config.cloudflare?.hostname
          ? `https://${config.cloudflare.hostname}`
          : activeRelay(config) === "tailscale" && config.tailscale?.hostname
            ? `https://${config.tailscale.hostname}`
            : "https://localhost";
      await this.push.send(notification, subject);
    } catch (error) {
      log.warn("unable to send session notification", { message: error instanceof Error ? error.message : String(error) });
    }
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
    streaming: isRuntimeRunning(runtime),
    messages: session.state.messages,
    availableModels: session.modelRuntime.getAvailableSnapshot().map((item) => ({
      provider: item.provider,
      id: item.id,
      ...(item.name ? { name: item.name } : {}),
    })),
    slashCommands: getSlashCommands(session),
  };
}

function isRuntimeRunning(runtime: RuntimeSession): boolean {
  return runtime.runActive || runtime.session.isStreaming;
}

async function createRuntimeSession(manager: SessionManager): Promise<AgentSession> {
  const config = await loadConfig();
  const settingsManager = SettingsManager.create(manager.getCwd(), config.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: manager.getCwd(),
    agentDir: config.agentDir,
    settingsManager,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: manager.getCwd(),
    agentDir: config.agentDir,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
  });
  return session;
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

export async function ensureWorkingDirectory(input: string): Promise<string> {
  let cwd: string;
  try {
    cwd = await realpath(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(input, { recursive: true });
    cwd = await realpath(input);
  }
  if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory");
  return cwd;
}

export async function startSessionDaemon(socketPath?: string): Promise<SessionDaemonHandle> {
  return new SessionDaemon(socketPath).start();
}

export function assistantNotificationPreview(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) return undefined;
  const text = record.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const content = part as Record<string, unknown>;
    return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
  }).join(" ");
  const preview = notificationExcerpt(markdownNotificationText(text), "");
  return preview || undefined;
}

class NotificationTextRenderer extends Renderer {
  override space(): string { return " "; }
  override code({ text }: Tokens.Code): string { return `${text} `; }
  override blockquote({ tokens }: Tokens.Blockquote): string { return `${this.parser.parse(tokens)} `; }
  override html({ text }: Tokens.HTML | Tokens.Tag): string { return `${decodeHtmlEntities(text.replace(/<!--[\s\S]*?-->|<[^>]*>/gu, " "))} `; }
  override def(): string { return ""; }
  override heading({ tokens }: Tokens.Heading): string { return `${this.parser.parseInline(tokens)} `; }
  override hr(): string { return " "; }
  override list({ items }: Tokens.List): string { return `${items.map((item) => this.listitem(item)).join(" ")} `; }
  override listitem({ tokens }: Tokens.ListItem): string { return `${this.parser.parse(tokens)} `; }
  override checkbox({ checked }: Tokens.Checkbox): string { return checked ? "checked " : "unchecked "; }
  override paragraph({ tokens }: Tokens.Paragraph): string { return `${this.parser.parseInline(tokens)} `; }
  override table({ header, rows }: Tokens.Table): string {
    return `${[header, ...rows].flatMap((row) => row.map((cell) => this.tablecell(cell))).join(" ")} `;
  }
  override tablerow({ text }: Tokens.TableRow): string { return `${text} `; }
  override tablecell({ tokens }: Tokens.TableCell): string { return this.parser.parseInline(tokens); }
  override strong({ tokens }: Tokens.Strong): string { return this.parser.parseInline(tokens); }
  override em({ tokens }: Tokens.Em): string { return this.parser.parseInline(tokens); }
  override codespan({ text }: Tokens.Codespan): string { return decodeHtmlEntities(text); }
  override br(): string { return " "; }
  override del({ tokens }: Tokens.Del): string { return this.parser.parseInline(tokens); }
  override link({ tokens }: Tokens.Link): string { return this.parser.parseInline(tokens); }
  override image({ text, tokens }: Tokens.Image): string {
    return tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : decodeHtmlEntities(text);
  }
  override text(token: Tokens.Text | Tokens.Escape): string {
    return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : decodeHtmlEntities(token.text);
  }
}

const notificationTextRenderer = new NotificationTextRenderer();

export function markdownNotificationText(value: string): string {
  return marked.parse(value, { renderer: notificationTextRenderer, async: false });
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|nbsp|quot));/giu, (entity, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
    const codePoint = decimal ? Number.parseInt(decimal, 10) : hexadecimal ? Number.parseInt(hexadecimal, 16) : undefined;
    if (codePoint !== undefined && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)) return String.fromCodePoint(codePoint);
    return named[name?.toLocaleLowerCase() || ""] || entity;
  });
}

export class SessionNotificationTracker {
  private state: "idle" | "running" | "aborted" | "settled" = "idle";
  private preview: string | undefined;

  begin(): void {
    this.state = "running";
    this.preview = undefined;
  }

  capture(message: unknown): void {
    if (this.state !== "running") return;
    const preview = assistantNotificationPreview(message);
    if (preview) this.preview = preview;
  }

  abort(): void {
    if (this.state === "running") this.state = "aborted";
  }

  complete(sessionId: string): PushNotification | undefined {
    if (this.state !== "running") return undefined;
    this.state = "settled";
    return { sessionId, outcome: "completed", body: this.preview || "Your Pi task is ready to review." };
  }

  fail(sessionId: string, message: string): PushNotification | undefined {
    if (this.state !== "running") return undefined;
    this.state = "settled";
    return {
      sessionId,
      outcome: "failed",
      body: notificationExcerpt(message, "Open Pi Daemon to review the failure."),
    };
  }
}

export function notificationExcerpt(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return fallback;
  const characters = Array.from(normalized);
  if (characters.length <= 160) return normalized;
  const clipped = characters.slice(0, 159).join("");
  const wordBoundary = clipped.lastIndexOf(" ");
  const shortened = wordBoundary >= 96 ? clipped.slice(0, wordBoundary) : clipped;
  return `${shortened.trimEnd()}…`;
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
