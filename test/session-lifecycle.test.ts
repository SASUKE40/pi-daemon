import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushService } from "../src/push.js";
import { SessionDaemon, type SessionDaemonHandle } from "../src/sessiond.js";
import type { ServerEvent } from "../src/protocol.js";

let root: string | undefined;
const handles: SessionDaemonHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SessionDaemon lifecycle", () => {
  it("creates a custom socket parent without touching an existing live daemon", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-lifecycle-"));
    const socketPath = join(root, "nested", "runtime", "sessiond.sock");
    const push = { send: async () => ({ sent: 0, removed: 0, failed: 0 }) } as unknown as PushService;
    const first = await new SessionDaemon(socketPath, push).start();
    handles.push(first);

    await expect(new SessionDaemon(socketPath, push).start()).rejects.toThrow("already running");
    await expect(readReady(socketPath)).resolves.toMatchObject({ type: "ready", protocolVersion: 1 });
  });

  it("refuses to replace a non-socket path", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-lifecycle-"));
    const socketPath = join(root, "sessiond.sock");
    await writeFile(socketPath, "do not remove");

    await expect(new SessionDaemon(socketPath).start()).rejects.toThrow("Refusing to replace non-socket path");
    await expect(readFile(socketPath, "utf8")).resolves.toBe("do not remove");
  });
});

async function readReady(socketPath: string): Promise<ServerEvent> {
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  try {
    return await new Promise<ServerEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for ready frame")), 2_000);
      socket.once("data", (chunk: string) => {
        clearTimeout(timeout);
        resolve(JSON.parse(chunk.trim()) as ServerEvent);
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    socket.destroy();
  }
}
