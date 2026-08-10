import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcClient } from "../src/ipc.js";
import type { ClientCommand, ServerEvent } from "../src/protocol.js";

let root: string | undefined;
let server: Server | undefined;
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("IpcClient", () => {
  it("does not report or buffer commands while its socket is still connecting", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-ipc-"));
    const client = new IpcClient(join(root, "missing.sock"));
    client.start();

    expect(client.connected).toBe(false);
    expect(() => client.send(command({ type: "session.list" }))).toThrow("unavailable");
    client.stop();
  });

  it("frames commands and events, ignores malformed frames, and cleans up listeners", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-ipc-"));
    const socketPath = join(root, "sessiond.sock");
    let peer: Socket | undefined;
    let received = "";
    server = createServer((socket) => {
      peer = socket;
      sockets.add(socket);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { received += chunk; });
    });
    await new Promise<void>((resolve, reject) => server?.once("error", reject).listen(socketPath, resolve));

    const client = new IpcClient(socketPath);
    const states: boolean[] = [];
    const events: ServerEvent[] = [];
    const removeState = client.onState((connected) => states.push(connected));
    const removeEvent = client.onEvent((item) => events.push(item));
    client.start();
    await vi.waitFor(() => expect(client.connected).toBe(true));

    client.send(command({ type: "session.list" }));
    await vi.waitFor(() => expect(received).toContain('"type":"session.list"}\n'));
    peer?.write("not-json\n");
    peer?.write('{"protocolVersion":1,"type":"ready"');
    peer?.write("}\n");
    await vi.waitFor(() => expect(events).toEqual([{ protocolVersion: 1, type: "ready" }]));

    removeEvent();
    removeState();
    peer?.write('{"protocolVersion":1,"type":"ready"}\n');
    client.stop();
    expect(states).toEqual([true]);
    expect(events).toHaveLength(1);
  });
});

function command(value: Record<string, unknown>): ClientCommand {
  return { protocolVersion: 1, requestId: "request", ...value } as ClientCommand;
}
