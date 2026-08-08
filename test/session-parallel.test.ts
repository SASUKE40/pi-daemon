import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PushService } from "../src/push.js";
import type { ClientCommand, ServerEvent } from "../src/protocol.js";
import {
  SessionDaemon,
  type SessionDaemonDependencies,
  type SessionDaemonHandle,
  type SessionInfo,
} from "../src/sessiond.js";

let root: string | undefined;
let daemon: SessionDaemonHandle | undefined;
const clients: IpcTestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await daemon?.close().catch(() => undefined);
  daemon = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  delete process.env.PI_DAEMON_HOME;
});

describe("parallel session dispatch", () => {
  it("runs different sessions concurrently and isolates success from failure", async () => {
    const { client, harness, push } = await startHarness();
    const firstId = await createTask(client, join(root as string, "first"), "create-first");
    const secondId = await createTask(client, join(root as string, "second"), "create-second");

    client.send(command({ type: "session.prompt", requestId: "prompt-first", sessionId: firstId, text: "First task" }));
    client.send(command({ type: "session.prompt", requestId: "prompt-second", sessionId: secondId, text: "Second task" }));

    await Promise.all([
      client.waitFor((item) => item.type === "session.status" && item.sessionId === firstId && item.status === "running"),
      client.waitFor((item) => item.type === "session.status" && item.sessionId === secondId && item.status === "running"),
    ]);
    expect(harness.session(firstId).promptTexts).toEqual(["First task"]);
    expect(harness.session(secondId).promptTexts).toEqual(["Second task"]);

    const observer = await connectClient(daemon?.socketPath as string);
    const ready = await observer.waitFor((item) => item.type === "ready");
    expect(ready).toMatchObject({
      type: "ready",
      activeSessionId: secondId,
      activeSessionIds: [firstId, secondId],
    });

    harness.session(secondId).fail(new Error("Second provider failed"));
    await client.waitFor((item) => item.type === "session.status" && item.sessionId === secondId && item.status === "error");
    await client.waitFor((item) => item.type === "session.status" && item.sessionId === secondId && item.status === "idle");
    expect(harness.session(firstId).isStreaming).toBe(true);

    harness.session(firstId).complete("First task finished");
    await client.waitFor((item) => item.type === "session.status" && item.sessionId === firstId && item.status === "idle");
    await vi.waitFor(() => expect(push.send).toHaveBeenCalledTimes(2));
    expect(push.send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: secondId,
      outcome: "failed",
      body: "Second provider failed",
    }), expect.any(String));
    expect(push.send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: firstId,
      outcome: "completed",
      body: "First task finished",
    }), expect.any(String));
    expect(client.events.some((item) => item.type === "error" && item.code === "daemon_busy")).toBe(false);
  });

  it("rejects a second run only for the same session and routes controls independently", async () => {
    const { client, harness } = await startHarness();
    const firstId = await createTask(client, join(root as string, "first"), "create-first");
    const secondId = await createTask(client, join(root as string, "second"), "create-second");

    client.send(command({ type: "session.prompt", requestId: "prompt-first", sessionId: firstId, text: "First task" }));
    client.send(command({ type: "session.prompt", requestId: "prompt-second", sessionId: secondId, text: "Second task" }));
    await Promise.all([
      client.waitFor((item) => item.type === "session.status" && item.sessionId === firstId && item.status === "running"),
      client.waitFor((item) => item.type === "session.status" && item.sessionId === secondId && item.status === "running"),
    ]);

    client.send(command({ type: "session.prompt", requestId: "duplicate", sessionId: firstId, text: "Do not start twice" }));
    const duplicate = await client.waitFor((item) => item.type === "error" && item.requestId === "duplicate");
    expect(duplicate).toMatchObject({ code: "session_busy" });
    expect(duplicate).not.toHaveProperty("activeSessionId");
    expect(harness.session(firstId).promptTexts).toEqual(["First task"]);

    client.send(command({ type: "session.steer", requestId: "steer-first", sessionId: firstId, text: "Change first" }));
    client.send(command({ type: "session.followUp", requestId: "follow-second", sessionId: secondId, text: "Then do this" }));
    await Promise.all([
      client.waitFor((item) => item.type === "queue.update" && item.sessionId === firstId && item.steering.includes("Change first")),
      client.waitFor((item) => item.type === "queue.update" && item.sessionId === secondId && item.followUp.includes("Then do this")),
    ]);
    expect(harness.session(firstId).steering).toEqual(["Change first"]);
    expect(harness.session(secondId).followUps).toEqual(["Then do this"]);

    client.send(command({ type: "session.abort", requestId: "abort-first", sessionId: firstId }));
    await client.waitFor((item) => item.type === "session.status" && item.sessionId === firstId && item.status === "aborting");
    await client.waitFor((item) => item.type === "session.status" && item.sessionId === firstId && item.status === "idle");
    expect(harness.session(firstId).abortCalls).toBe(1);
    expect(harness.session(secondId).isStreaming).toBe(true);

    const observer = await connectClient(daemon?.socketPath as string);
    await expect(observer.waitFor((item) => item.type === "ready")).resolves.toMatchObject({
      activeSessionId: secondId,
      activeSessionIds: [secondId],
    });
    harness.session(secondId).complete("Second task finished");
    await client.waitFor((item) => item.type === "session.status" && item.sessionId === secondId && item.status === "idle");
  });

  it("creates one runtime when simultaneous commands open the same unloaded session", async () => {
    const { client, harness } = await startHarness();
    const sessionId = harness.addStoredSession(join(root as string, "stored"));
    const release = harness.delaySessionCreation(sessionId);

    client.send(command({ type: "session.open", requestId: "open-one", sessionId }));
    client.send(command({ type: "session.open", requestId: "open-two", sessionId }));
    await vi.waitFor(() => expect(harness.createCalls.get(sessionId)).toBe(1));
    release();

    await Promise.all([
      client.waitFor((item) => item.type === "session.snapshot" && item.requestId === "open-one"),
      client.waitFor((item) => item.type === "session.snapshot" && item.requestId === "open-two"),
    ]);
    expect(harness.createCalls.get(sessionId)).toBe(1);
  });
});

async function startHarness(): Promise<{ client: IpcTestClient; harness: FakeSessionHarness; push: { send: ReturnType<typeof vi.fn> } }> {
  root = await mkdtemp(join(tmpdir(), "pi-daemon-parallel-"));
  process.env.PI_DAEMON_HOME = root;
  await mkdir(root, { recursive: true });
  const socketPath = join(root, "sessiond.sock");
  const harness = new FakeSessionHarness();
  const push = { send: vi.fn(async () => ({ sent: 1, removed: 0, failed: 0 })) };
  daemon = await new SessionDaemon(socketPath, push as unknown as PushService, harness.dependencies).start();
  const client = await connectClient(socketPath);
  await client.waitFor((item) => item.type === "ready");
  return { client, harness, push };
}

async function createTask(client: IpcTestClient, cwd: string, requestId: string): Promise<string> {
  client.send(command({ type: "session.create", requestId, cwd }));
  const created = await client.waitFor((item) => item.type === "session.snapshot" && item.requestId === requestId);
  if (created.type !== "session.snapshot") throw new Error("Expected a session snapshot");
  return created.session.id;
}

function command(value: Record<string, unknown>): ClientCommand {
  return { protocolVersion: 1, ...value } as ClientCommand;
}

async function connectClient(socketPath: string): Promise<IpcTestClient> {
  const client = await IpcTestClient.connect(socketPath);
  clients.push(client);
  return client;
}

class IpcTestClient {
  readonly events: ServerEvent[] = [];
  private buffer = "";
  private readonly waiters = new Set<{
    predicate: (event: ServerEvent) => boolean;
    resolve: (event: ServerEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
  }

  static async connect(socketPath: string): Promise<IpcTestClient> {
    const socket = createConnection(socketPath);
    const client = new IpcTestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  send(value: ClientCommand): void {
    this.socket.write(`${JSON.stringify(value)}\n`);
  }

  waitFor(predicate: (event: ServerEvent) => boolean, timeoutMs = 2_000): Promise<ServerEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ServerEvent>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (event: ServerEvent) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(event);
        },
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("Timed out waiting for daemon event"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("IPC client closed"));
    }
    this.waiters.clear();
    this.socket.destroy();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const serverEvent = JSON.parse(line) as ServerEvent;
      this.events.push(serverEvent);
      for (const waiter of [...this.waiters]) if (waiter.predicate(serverEvent)) waiter.resolve(serverEvent);
    }
  }
}

class FakeSessionHarness {
  readonly createCalls = new Map<string, number>();
  readonly dependencies: SessionDaemonDependencies;
  private readonly managers = new Map<string, FakeManager>();
  private readonly sessions = new Map<string, FakeAgentSession>();
  private readonly creationGates = new Map<string, Promise<void>>();
  private nextId = 1;

  constructor() {
    this.dependencies = {
      listSessions: async () => [...this.managers.values()].map((manager) => manager.info()),
      createManager: (cwd) => this.manager(this.addStoredSession(cwd)) as unknown as SessionManager,
      openManager: (path) => {
        const manager = [...this.managers.values()].find((item) => item.path === path);
        if (!manager) throw new Error(`Unknown fake session path: ${path}`);
        return manager as unknown as SessionManager;
      },
      createSession: async (manager) => {
        const sessionId = manager.getSessionId();
        this.createCalls.set(sessionId, (this.createCalls.get(sessionId) || 0) + 1);
        await this.creationGates.get(sessionId);
        let session = this.sessions.get(sessionId);
        if (!session) {
          session = new FakeAgentSession(manager as unknown as FakeManager);
          this.sessions.set(sessionId, session);
        }
        return session as unknown as AgentSession;
      },
    };
  }

  addStoredSession(cwd: string): string {
    const id = `session-${this.nextId++}`;
    this.managers.set(id, new FakeManager(id, cwd));
    return id;
  }

  delaySessionCreation(sessionId: string): () => void {
    let release: () => void = () => undefined;
    this.creationGates.set(sessionId, new Promise<void>((resolve) => { release = resolve; }));
    return release;
  }

  manager(sessionId: string): FakeManager {
    const manager = this.managers.get(sessionId);
    if (!manager) throw new Error(`Unknown fake manager: ${sessionId}`);
    return manager;
  }

  session(sessionId: string): FakeAgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown fake agent session: ${sessionId}`);
    return session;
  }
}

class FakeManager {
  readonly path: string;
  private name: string | undefined;

  constructor(readonly id: string, private readonly cwd: string) {
    this.path = `/sessions/${id}.jsonl`;
  }

  getSessionId(): string { return this.id; }
  getCwd(): string { return this.cwd; }
  getSessionFile(): string { return this.path; }
  getSessionName(): string | undefined { return this.name; }
  appendSessionInfo(name: string): void { this.name = name; }

  info(): SessionInfo {
    const timestamp = new Date("2026-08-07T00:00:00.000Z");
    return {
      id: this.id,
      path: this.path,
      cwd: this.cwd,
      ...(this.name ? { name: this.name } : {}),
      created: timestamp,
      modified: timestamp,
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
    };
  }
}

class FakeAgentSession {
  isStreaming = false;
  thinkingLevel = "medium";
  readonly promptTexts: string[] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  abortCalls = 0;
  readonly state = { messages: [] as unknown[] };
  readonly model = undefined;
  readonly promptTemplates = [];
  readonly modelRuntime = {
    getAvailableSnapshot: () => [],
    getModel: () => undefined,
  };
  readonly extensionRunner = { getRegisteredCommands: () => [] };
  readonly settingsManager = { getEnableSkillCommands: () => false };
  readonly resourceLoader = { getSkills: () => ({ skills: [] }) };
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private pending: Deferred<void> | undefined;

  constructor(readonly sessionManager: FakeManager) {}

  get sessionId(): string { return this.sessionManager.getSessionId(); }
  get sessionFile(): string { return this.sessionManager.getSessionFile(); }
  get sessionName(): string | undefined { return this.sessionManager.getSessionName(); }

  async bindExtensions(): Promise<void> {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string): Promise<void> {
    this.promptTexts.push(text);
    this.isStreaming = true;
    this.pending = deferred<void>();
    return this.pending.promise.finally(() => { this.isStreaming = false; });
  }

  async steer(text: string): Promise<void> { this.steering.push(text); }
  async followUp(text: string): Promise<void> { this.followUps.push(text); }
  getSteeringMessages(): readonly string[] { return this.steering; }
  getFollowUpMessages(): readonly string[] { return this.followUps; }
  setThinkingLevel(level: string): void { this.thinkingLevel = level; }
  async setModel(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.pending?.resolve();
  }

  complete(text: string): void {
    this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } as AgentSessionEvent);
    this.pending?.resolve();
  }

  fail(error: Error): void {
    this.pending?.reject(error);
  }

  private emit(agentEvent: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(agentEvent);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
