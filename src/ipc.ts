import { createConnection, type Socket } from "node:net";
import type { ClientCommand, ServerEvent } from "./protocol.js";

export class IpcClient {
  private socket: Socket | undefined;
  private buffer = "";
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly stateListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly socketPath: string) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = undefined;
  }

  send(command: ClientCommand): void {
    if (!this.socket?.writable) throw new Error("Session daemon is unavailable");
    this.socket.write(`${JSON.stringify(command)}\n`);
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (connected: boolean) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  get connected(): boolean {
    return Boolean(this.socket?.writable);
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => this.emitState(true));
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.buffer = "";
      this.emitState(false);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 1_000);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ServerEvent;
        for (const listener of this.listeners) listener(parsed);
      } catch {
        // Ignore a malformed daemon frame; the daemon will log its source.
      }
    }
  }

  private emitState(connected: boolean): void {
    for (const listener of this.stateListeners) listener(connected);
  }
}
