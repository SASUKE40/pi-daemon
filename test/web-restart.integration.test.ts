import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTcpServer } from "node:net";
import WebSocket from "ws";
import { startWebServer, type WebServerHandle } from "../src/web.js";

let root: string | undefined;
let fakeDaemon: Server | undefined;
let web: WebServerHandle | undefined;

afterEach(async () => {
  await web?.close().catch(() => undefined);
  if (fakeDaemon) await new Promise<void>((resolve) => fakeDaemon?.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  delete process.env.PI_DAEMON_HOME;
  delete process.env.PI_DAEMON_SOCKET;
});

describe("web process boundary", () => {
  it("reconnects to a still-running session daemon after a web restart", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-test-"));
    const socketPath = join(root, "sessiond.sock");
    process.env.PI_DAEMON_HOME = root;
    process.env.PI_DAEMON_SOCKET = socketPath;
    await mkdir(join(root, ".config", "pi-daemon"), { recursive: true });
    fakeDaemon = await startFakeDaemon(socketPath);
    const port = await freePort();

    web = await startWebServer({ port, defaultCwd: root, agentDir: join(root, ".pi", "agent") });
    await expectAttachmentGuards(port);
    const pushPublicKey = await expectPushSubscriptionRoutes(port);
    await expectSessionList(port);
    await web.close();
    web = undefined;

    web = await startWebServer({ port, defaultCwd: root, agentDir: join(root, ".pi", "agent") });
    expect(await bootstrapPushPublicKey(port)).toBe(pushPublicKey);
    await expectSessionList(port);
  });
});

async function startFakeDaemon(socketPath: string): Promise<Server> {
  const server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify({
      type: "ready",
      protocolVersion: 1,
      activeSessionId: "session-2",
      activeSessionIds: ["session-1", "session-2"],
    })}\n`);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        const command = JSON.parse(line) as { type: string; requestId: string };
        if (command.type === "session.list") socket.write(`${JSON.stringify({ type: "session.list", protocolVersion: 1, requestId: command.requestId, sessions: [] })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  return server;
}

async function expectPushSubscriptionRoutes(port: number): Promise<string> {
  const publicKey = await bootstrapPushPublicKey(port);
  expect(publicKey.length).toBeGreaterThan(40);
  const invalid = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://push.example.test/device", keys: { p256dh: "public", auth: "auth" } }),
  });
  expect(invalid.status).toBe(400);
  const subscription = { endpoint: "https://push.example.test/device", expirationTime: null, keys: { p256dh: "public", auth: "auth" } };
  const added = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
  });
  expect(added.status).toBe(200);
  const removed = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ ok: true, removed: true });
  return publicKey;
}

async function bootstrapPushPublicKey(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { pushPublicKey: string }).pushPublicKey;
}

async function expectAttachmentGuards(port: number): Promise<void> {
  const disguised = new FormData();
  disguised.append("file", new Blob(["not an image"], { type: "image/png" }), "fake.png");
  expect((await fetch(`http://127.0.0.1:${port}/api/attachments`, { method: "POST", body: disguised })).status).toBe(415);

  const oversized = new FormData();
  oversized.append("file", new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
  expect((await fetch(`http://127.0.0.1:${port}/api/attachments`, { method: "POST", body: oversized })).status).toBe(413);
}

async function expectSessionList(port: number): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { origin: `http://127.0.0.1:${port}` });
  const result = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for session list")), 5_000);
    let receivedActiveSessions = false;
    let receivedSessionList = false;
    socket.on("open", () => socket.send(JSON.stringify({ protocolVersion: 1, requestId: "list", type: "session.list" })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; activeSessionIds?: string[] };
      if (message.type === "ready" && message.activeSessionIds?.join(",") === "session-1,session-2") receivedActiveSessions = true;
      if (message.type === "session.list") receivedSessionList = true;
      if (receivedActiveSessions && receivedSessionList) {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.on("error", reject);
  });
  await result;
  socket.close();
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
