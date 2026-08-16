#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  createAgentSession,
  DefaultResourceLoader,
  getPackageDir,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { marked, Renderer, type Tokens } from "marked";
import { activeRelay, loadConfig } from "./config.js";
import { log } from "./log.js";
import { createModelRuntime, refreshModels } from "./models.js";
import { getAppPaths, safeSocketFallback } from "./paths.js";
import { PushService, type PushNotification } from "./push.js";
import { getSlashCommands } from "./slash-commands.js";
import {
  event,
  parseClientCommand,
  type ClientCommand,
  type BuiltinCommandResult,
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
  private readonly pendingAuthPrompts = new Map<string, { sessionId: string; resolve(value: string): void; reject(error: Error): void }>();
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
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
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
      if (await this.socketIsActive()) throw new Error(`Session daemon is already running at ${this.socketPath}`);
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private socketIsActive(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;
      const finish = (error: Error | undefined, active = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(active);
      };
      const timeout = setTimeout(() => finish(new Error(`Timed out checking existing session daemon at ${this.socketPath}`)), 500);
      socket.once("connect", () => finish(undefined, true));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(undefined, false);
        else finish(error);
      });
    });
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
        void Promise.resolve().then(() => runtime.session.prompt(command.text, images ? { images } : {})).then(() => {
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
        await this.refreshModels(runtime);
        await this.setModel(runtime, command.provider, command.modelId);
        this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        return;
      }
      case "session.refreshModels": {
        const runtime = await this.getOrOpen(command.sessionId);
        await this.refreshModels(runtime);
        this.broadcast(event({
          type: "session.models",
          requestId: command.requestId,
          sessionId: runtime.session.sessionId,
          models: availableModels(runtime.session),
        }));
        return;
      }
      case "session.setThinking": {
        const runtime = await this.getOrOpen(command.sessionId);
        runtime.session.setThinkingLevel(command.thinking);
        this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        return;
      }
      case "session.command": {
        const runtime = await this.getOrOpen(command.sessionId);
        await this.handleBuiltinCommand(socket, runtime, command);
        return;
      }
    }
  }

  private async handleBuiltinCommand(
    socket: Socket,
    runtime: RuntimeSession,
    command: Extract<ClientCommand, { type: "session.command" }>,
  ): Promise<void> {
    const { session } = runtime;
    const reply = (result: BuiltinCommandResult) => this.write(socket, event({
      type: "command.result",
      requestId: command.requestId,
      sessionId: session.sessionId,
      command: command.command,
      result,
    }));

    switch (command.command) {
      case "settings": {
        const values = command.payload?.values;
        if (values) {
          if (typeof values.autoCompaction === "boolean") session.setAutoCompactionEnabled(values.autoCompaction);
          if (typeof values.autoRetry === "boolean") session.setAutoRetryEnabled(values.autoRetry);
          if (values.steeringMode === "all" || values.steeringMode === "one-at-a-time") session.setSteeringMode(values.steeringMode);
          if (values.followUpMode === "all" || values.followUpMode === "one-at-a-time") session.setFollowUpMode(values.followUpMode);
          if (typeof values.skillCommands === "boolean") session.settingsManager.setEnableSkillCommands(values.skillCommands);
          await session.settingsManager.flush();
        }
        reply({
          kind: "settings",
          settings: {
            autoCompaction: session.autoCompactionEnabled,
            autoRetry: session.autoRetryEnabled,
            steeringMode: session.steeringMode,
            followUpMode: session.followUpMode,
            skillCommands: session.settingsManager.getEnableSkillCommands(),
          },
        });
        return;
      }
      case "scoped-models": {
        await this.refreshModels(runtime);
        if (command.payload?.modelIds) {
          const selected = command.payload.modelIds.flatMap((id) => {
            const separator = id.indexOf("/");
            if (separator < 1) return [];
            const model = session.modelRuntime.getModel(id.slice(0, separator), id.slice(separator + 1));
            return model ? [{ model }] : [];
          });
          session.setScopedModels(selected);
          session.settingsManager.setEnabledModels(command.payload.modelIds.length ? command.payload.modelIds : undefined);
          await session.settingsManager.flush();
        }
        reply({
          kind: "scoped-models",
          models: session.modelRuntime.getAvailableSnapshot().map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
          selected: session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`),
        });
        return;
      }
      case "export": {
        const outputPath = commandPathArgument(command.arguments);
        const jsonl = outputPath?.toLocaleLowerCase().endsWith(".jsonl") ?? false;
        const filePath = jsonl ? session.exportToJsonl(outputPath) : await session.exportToHtml(outputPath);
        const contents = await readFile(filePath);
        reply({
          kind: "download",
          message: `Session exported to ${filePath}`,
          fileName: basename(filePath),
          mimeType: jsonl ? "application/x-ndjson" : "text/html",
          fileData: contents.toString("base64"),
          path: filePath,
        });
        return;
      }
      case "import": {
        const imported = await this.importSession(runtime, command);
        this.write(socket, event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(imported) }));
        reply({ kind: "message", message: `Session imported as ${imported.session.sessionId}` });
        return;
      }
      case "share": {
        const result = await shareSession(session);
        reply({ kind: "share", message: `Share URL: ${result.shareUrl}`, ...result });
        return;
      }
      case "copy": {
        reply({ kind: "copy", text: session.getLastAssistantText() || "" });
        return;
      }
      case "session": {
        reply({ kind: "session", name: session.sessionName, stats: session.getSessionStats() });
        return;
      }
      case "changelog": {
        const changelog = await readFile(join(getPackageDir(), "CHANGELOG.md"), "utf8");
        reply({ kind: "markdown", title: "What's New", markdown: changelog.slice(0, 250_000) });
        return;
      }
      case "hotkeys": {
        reply({ kind: "markdown", title: "Keyboard Shortcuts", markdown: WEB_HOTKEYS_MARKDOWN });
        return;
      }
      case "fork": {
        if (!command.payload?.targetId) {
          reply({ kind: "fork", messages: session.getUserMessagesForForking() });
          return;
        }
        const forked = await this.forkRuntime(runtime, command.payload.targetId, false);
        this.write(socket, event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(forked.runtime) }));
        reply({ kind: "forked", message: "Forked to a new session", editorText: forked.editorText });
        return;
      }
      case "clone": {
        const leafId = session.sessionManager.getLeafId();
        if (!leafId) throw new Error("Nothing to clone yet");
        const cloned = await this.forkRuntime(runtime, leafId, true);
        this.write(socket, event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(cloned.runtime) }));
        reply({ kind: "message", message: "Cloned to a new session" });
        return;
      }
      case "tree": {
        if (!command.payload?.targetId) {
          reply({ kind: "tree", leafId: session.sessionManager.getLeafId(), entries: session.sessionManager.getEntries().map(toTreeCommandEntry) });
          return;
        }
        const result = await session.navigateTree(command.payload.targetId, { summarize: false });
        if (result.cancelled) throw new Error("Tree navigation was cancelled");
        this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        reply({ kind: "tree-navigated", message: "Navigated to the selected point", editorText: result.editorText });
        return;
      }
      case "trust": {
        const config = await loadConfig();
        const store = new ProjectTrustStore(config.agentDir);
        if (typeof command.payload?.trusted === "boolean") store.set(session.sessionManager.getCwd(), command.payload.trusted);
        reply({ kind: "trust", cwd: session.sessionManager.getCwd(), trusted: store.get(session.sessionManager.getCwd()) });
        return;
      }
      case "login": {
        if (command.payload?.action === "respond" && command.payload.targetId) {
          const pending = this.pendingAuthPrompts.get(command.payload.targetId);
          if (!pending || pending.sessionId !== session.sessionId) throw new Error("Authentication prompt expired");
          this.pendingAuthPrompts.delete(command.payload.targetId);
          pending.resolve(command.payload.apiKey || "");
          reply({ kind: "auth-response", message: "Authentication response sent" });
          return;
        }
        if (command.payload?.action === "login" && command.payload.provider && command.payload.authType) {
          this.startLogin(socket, runtime, command, reply);
          return;
        }
        reply({ kind: "login", providers: authProviderOptions(session) });
        return;
      }
      case "logout": {
        if (command.payload?.provider) {
          await session.modelRuntime.logout(command.payload.provider, { signal: AbortSignal.timeout(30_000) });
          reply({ kind: "message", message: `Logged out of ${command.payload.provider}` });
          return;
        }
        const credentials = await session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) });
        reply({ kind: "logout", credentials });
        return;
      }
      case "compact": {
        if (isRuntimeRunning(runtime)) throw new Error("Wait for the current response to finish before compacting");
        this.emitStatus(runtime, "running");
        try {
          await session.compact(command.arguments?.trim() || undefined);
          reply({ kind: "message", message: "Session context compacted" });
        } finally {
          this.emitStatus(runtime, "idle");
        }
        return;
      }
      case "reload": {
        if (isRuntimeRunning(runtime) || session.isCompacting) throw new Error("Wait for the current operation to finish before reloading");
        await session.reload();
        await this.refreshModels(runtime);
        this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
        reply({ kind: "message", message: "Reloaded models, extensions, skills, prompts, settings, themes, and context files" });
        return;
      }
      case "quit": {
        if (isRuntimeRunning(runtime)) await session.abort();
        runtime.unsubscribe();
        session.dispose();
        this.sessions.delete(session.sessionId);
        reply({ kind: "quit", message: "Pi runtime closed; the saved session remains available in Resume" });
        return;
      }
      case "model":
      case "name":
      case "new":
      case "resume":
        throw new Error(`/${command.command} is handled by the web client`);
    }
  }

  private startLogin(
    socket: Socket,
    runtime: RuntimeSession,
    command: Extract<ClientCommand, { type: "session.command" }>,
    reply: (result: BuiltinCommandResult) => void,
  ): void {
    const provider = command.payload?.provider;
    const authType = command.payload?.authType;
    if (!provider || !authType) throw new Error("Provider and authentication type are required");
    reply({ kind: "auth-progress", message: `Starting ${provider} authentication` });
    void runtime.session.modelRuntime.login(provider, authType, {
      notify: (authEvent) => reply({ kind: "auth-event", authEvent }),
      prompt: (prompt) => new Promise<string>((resolvePrompt, rejectPrompt) => {
        const promptId = randomUUID();
        this.pendingAuthPrompts.set(promptId, { sessionId: runtime.session.sessionId, resolve: resolvePrompt, reject: rejectPrompt });
        const onAbort = () => {
          this.pendingAuthPrompts.delete(promptId);
          rejectPrompt(new Error("Authentication cancelled"));
        };
        prompt.signal?.addEventListener("abort", onAbort, { once: true });
        reply({
          kind: "auth-prompt",
          promptId,
          prompt: {
            type: prompt.type,
            message: prompt.message,
            ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
            ...("options" in prompt ? { options: prompt.options } : {}),
          },
        });
      }),
    }).then(async () => {
      await runtime.session.modelRuntime.refresh({ signal: AbortSignal.timeout(15_000) });
      reply({ kind: "auth-complete", message: `Logged in to ${provider}` });
      this.broadcast(event({ type: "session.snapshot", requestId: command.requestId, session: snapshot(runtime) }));
    }).catch((error) => {
      reply({ kind: "auth-error", message: error instanceof Error ? error.message : String(error) });
    });
  }

  private async importSession(
    runtime: RuntimeSession,
    command: Extract<ClientCommand, { type: "session.command" }>,
  ): Promise<RuntimeSession> {
    let sourcePath: string | undefined;
    let temporaryDirectory: string | undefined;
    if (command.payload?.fileData) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-daemon-import-"));
      sourcePath = join(temporaryDirectory, safeFileName(command.payload.fileName || "session.jsonl"));
      await writeFile(sourcePath, Buffer.from(command.payload.fileData, "base64"));
    } else if (command.arguments?.trim()) {
      const argument = commandPathArgument(command.arguments);
      if (argument) sourcePath = isAbsolute(argument) ? argument : resolve(runtime.session.sessionManager.getCwd(), argument);
    }
    if (!sourcePath) throw new Error("Choose a JSONL file or use /import <path.jsonl>");
    try {
      const sessionDir = runtime.session.sessionManager.getSessionDir();
      await mkdir(sessionDir, { recursive: true });
      const destination = join(sessionDir, `import-${Date.now()}-${safeFileName(basename(sourcePath))}`);
      await copyFile(sourcePath, destination);
      let manager = SessionManager.open(destination, sessionDir, command.payload?.cwd);
      try {
        await ensureWorkingDirectory(manager.getCwd());
      } catch {
        manager = SessionManager.open(destination, sessionDir, runtime.session.sessionManager.getCwd());
      }
      return await this.loadRuntime(manager);
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async forkRuntime(runtime: RuntimeSession, entryId: string, atEntry: boolean): Promise<{ runtime: RuntimeSession; editorText?: string }> {
    const selected = runtime.session.sessionManager.getEntry(entryId);
    if (!selected) throw new Error("Invalid entry ID for forking");
    if (!atEntry && (selected.type !== "message" || selected.message.role !== "user")) throw new Error("Choose a user message to fork from");
    const targetId = atEntry ? selected.id : selected.parentId;
    const editorText = atEntry ? undefined : sessionEntryText(selected);
    let manager: SessionManager;
    if (!targetId) {
      manager = this.dependencies.createManager(runtime.session.sessionManager.getCwd());
      manager.newSession(runtime.session.sessionFile ? { parentSession: runtime.session.sessionFile } : undefined);
    } else {
      if (!runtime.session.sessionFile) throw new Error("This session has not been saved yet");
      manager = this.dependencies.openManager(runtime.session.sessionFile);
      if (!manager.createBranchedSession(targetId)) throw new Error("Failed to create forked session");
    }
    return { runtime: await this.loadRuntime(manager), ...(editorText ? { editorText } : {}) };
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
    const baseUIContext = session.extensionRunner.getUIContext?.();
    const uiContext = new Proxy((baseUIContext || {}) as ExtensionUIContext, {
      get: (target, property, receiver) => {
        if (property === "notify") {
          return (message: string, level: "info" | "warning" | "error" = "info") => this.broadcast(event({
            type: "extension.notification",
            sessionId: session.sessionId,
            level,
            message,
          }));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await session.bindExtensions({
      mode: "rpc",
      uiContext,
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

  private async refreshModels(runtime: RuntimeSession): Promise<void> {
    await refreshModels(runtime.session.modelRuntime);
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
    availableModels: availableModels(session),
    slashCommands: getSlashCommands(session),
  };
}

function availableModels(session: AgentSession): SessionSnapshot["availableModels"] {
  return session.modelRuntime.getAvailableSnapshot().map((item) => ({
    provider: item.provider,
    id: item.id,
    ...(item.name ? { name: item.name } : {}),
  }));
}

function commandPathArgument(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const first = text[0];
  if (first === '"' || first === "'") {
    const closing = text.indexOf(first, 1);
    return closing < 0 ? undefined : text.slice(1, closing);
  }
  return text.split(/\s/u, 1)[0];
}

function safeFileName(value: string): string {
  const normalized = basename(value).replace(/[^A-Za-z0-9._-]/gu, "-");
  return normalized || "session.jsonl";
}

function sessionEntryText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  if (!("content" in entry.message)) return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((item) => item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item
    ? [String(item.text)]
    : []).join("\n").trim();
  return text || undefined;
}

function toTreeCommandEntry(entry: SessionEntry): Record<string, unknown> {
  return {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    ...(sessionEntryText(entry) ? { text: sessionEntryText(entry) } : {}),
    timestamp: entry.timestamp,
  };
}

function authProviderOptions(session: AgentSession): Array<Record<string, unknown>> {
  return session.modelRuntime.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    apiKey: Boolean(provider.auth.apiKey?.login),
    oauth: Boolean(provider.auth.oauth),
    configured: session.modelRuntime.hasConfiguredAuth(provider.id),
    apiKeyLabel: provider.auth.apiKey?.name,
    oauthLabel: provider.auth.oauth?.loginLabel || provider.auth.oauth?.name,
  })).filter((provider) => provider.apiKey || provider.oauth);
}

async function shareSession(session: AgentSession): Promise<{ shareUrl: string; gistUrl: string }> {
  const auth = await runProcess("gh", ["auth", "status"]);
  if (auth.code !== 0) throw new Error("GitHub CLI is not logged in. Run `gh auth login` on the host first.");
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-share-"));
  const outputPath = join(directory, "session.html");
  try {
    await session.exportToHtml(outputPath);
    const gist = await runProcess("gh", ["gist", "create", "--public=false", outputPath]);
    if (gist.code !== 0) throw new Error(gist.stderr.trim() || "Failed to create GitHub gist");
    const gistUrl = gist.stdout.trim();
    const gistId = gistUrl.split("/").filter(Boolean).at(-1);
    if (!gistId) throw new Error("GitHub returned an unreadable gist URL");
    return { gistUrl, shareUrl: `https://pi.dev/session/#${gistId}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runProcess(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => rejectProcess(error));
    child.once("close", (code) => resolveProcess({ code: code ?? 1, stdout, stderr }));
  });
}

const WEB_HOTKEYS_MARKDOWN = `
| Key | Action |
| --- | --- |
| \`Enter\` | Send a message or run the selected slash command |
| \`Shift+Enter\` | Insert a new line |
| \`Up / Down\` | Move through slash-command results |
| \`Tab\` | Insert the selected command so arguments can be added |
| \`Escape\` | Close command menus and dialogs |
| \`/\` | Open all Pi slash commands |
`;

function isRuntimeRunning(runtime: RuntimeSession): boolean {
  return runtime.runActive || runtime.session.isStreaming;
}

async function createRuntimeSession(manager: SessionManager): Promise<AgentSession> {
  const config = await loadConfig();
  const modelRuntime = await createModelRuntime(config);
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
    modelRuntime,
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
