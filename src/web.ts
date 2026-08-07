#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { AccessAuthorizer, allowedOrigins, isLoopbackHost, hostnameFromHeaders } from "./auth.js";
import { loadConfig, type PiDaemonConfig } from "./config.js";
import { IpcClient } from "./ipc.js";
import { log } from "./log.js";
import { getAppPaths } from "./paths.js";
import { event, parseClientCommand, type ClientCommand, type ImageAttachment, type ServerEvent } from "./protocol.js";
import { PushService, PushSubscriptionLimitError } from "./push.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ACCEPTED_IMAGES = new Set<ImageAttachment["mimeType"]>(["image/png", "image/jpeg", "image/webp", "image/gif"]);

interface PendingAttachment {
  attachment: ImageAttachment;
  expires: number;
}

export interface WebServerHandle {
  address: string;
  close(): Promise<void>;
}

export async function startWebServer(overrides: Partial<PiDaemonConfig> = {}): Promise<WebServerHandle> {
  const config = { ...(await loadConfig()), ...overrides } as PiDaemonConfig;
  const authorizer = new AccessAuthorizer(config);
  const app = Fastify({ logger: false, bodyLimit: MAX_ATTACHMENT_BYTES + 1024 });
  const ipc = new IpcClient(getAppPaths().socketPath);
  const sockets = new Set<WebSocket>();
  const attachments = new Map<string, PendingAttachment>();
  const push = new PushService();
  const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

  await app.register(multipart, { limits: { files: 4, fileSize: MAX_ATTACHMENT_BYTES } });
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
    setHeaders: (response, path) => {
      if (path.endsWith("sw.js") || path.endsWith("manifest.webmanifest")) response.header("Cache-Control", "no-cache");
      else if (path.includes("/assets/")) response.header("Cache-Control", "public, max-age=31536000, immutable");
    },
  });

  app.addHook("onRequest", async (request, reply) => authorize(request, reply, authorizer));
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });

  app.get("/healthz", async () => ({ ok: true, version: VERSION, daemonConnected: ipc.connected }));
  app.get("/api/bootstrap", async (request) => ({
    protocolVersion: PROTOCOL_VERSION,
    version: VERSION,
    defaultCwd: config.defaultCwd,
    hostname: config.cloudflare?.hostname,
    local: isLoopbackHost(hostnameFromHeaders(request.headers)),
    pushPublicKey: await push.getPublicKey(),
  }));

  app.put("/api/push/subscription", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      const subscription = await push.subscribe(request.body);
      return { ok: true, endpoint: subscription.endpoint };
    } catch (error) {
      const status = error instanceof PushSubscriptionLimitError ? 409 : 400;
      return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/push/subscription", { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const endpoint = request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>).endpoint
      : undefined;
    try {
      return { ok: true, removed: await push.unsubscribe(endpoint) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/attachments", async (request, reply) => {
    const uploaded: Array<{ id: string; name: string; mimeType: string; size: number }> = [];
    for await (const part of request.files()) {
      const mimeType = part.mimetype as ImageAttachment["mimeType"];
      if (!ACCEPTED_IMAGES.has(mimeType)) {
        await part.toBuffer().catch(() => undefined);
        return reply.code(415).send({ error: "Only PNG, JPEG, WebP, and GIF images are accepted" });
      }
      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch {
        return reply.code(413).send({ error: "Image exceeds 10 MB" });
      }
      if (buffer.length > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: "Image exceeds 10 MB" });
      if (!matchesImageSignature(buffer, mimeType)) return reply.code(415).send({ error: "Uploaded file does not match its image type" });
      const id = randomUUID();
      attachments.set(id, {
        attachment: { id, mimeType, data: buffer.toString("base64"), name: part.filename },
        expires: Date.now() + 15 * 60_000,
      });
      uploaded.push({ id, name: part.filename, mimeType, size: buffer.length });
    }
    return { attachments: uploaded };
  });

  app.get("/api/ws", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (!origin || !allowedOrigins(config).has(origin)) {
      socket.close(1008, "Invalid Origin");
      return;
    }
    sockets.add(socket);
    socket.send(JSON.stringify(event({ type: "ready" })));
    socket.on("message", (raw) => {
      try {
        const command = parseClientCommand(JSON.parse(raw.toString()));
        ipc.send(resolveAttachments(command, attachments));
      } catch (error) {
        socket.send(JSON.stringify(event({ type: "error", code: "invalid_request", message: error instanceof Error ? error.message : String(error) })));
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  ipc.onEvent((serverEvent) => broadcast(sockets, serverEvent));
  ipc.onState((connected) => {
    if (!connected) broadcast(sockets, event({ type: "error", code: "daemon_unavailable", message: "Session daemon disconnected" }));
  });
  ipc.start();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, item] of attachments) if (item.expires < now) attachments.delete(id);
  }, 60_000);
  cleanup.unref();

  await app.listen({ host: config.listenHost, port: config.port });
  const address = `http://${config.listenHost}:${config.port}`;
  log.info("web server listening", { address });
  return {
    address,
    close: async () => {
      clearInterval(cleanup);
      ipc.stop();
      for (const socket of sockets) socket.close(1001, "Server shutting down");
      await app.close();
    },
  };
}

function matchesImageSignature(buffer: Buffer, mimeType: ImageAttachment["mimeType"]): boolean {
  if (mimeType === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/gif") return buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

async function authorize(request: FastifyRequest, reply: FastifyReply, authorizer: AccessAuthorizer): Promise<void> {
  try {
    await authorizer.authorize(request.headers);
  } catch {
    await reply.code(403).send({ error: "Forbidden" });
  }
}

function resolveAttachments(command: ClientCommand, pending: Map<string, PendingAttachment>): ClientCommand {
  if (!("attachments" in command) || !command.attachments?.length) return command;
  const resolved = command.attachments.map((item) => {
    if (!item.id) throw new Error("Attachment id is required");
    const found = pending.get(item.id);
    if (!found || found.expires < Date.now()) throw new Error(`Attachment expired or missing: ${item.id}`);
    pending.delete(item.id);
    return found.attachment;
  });
  return { ...command, attachments: resolved };
}

function broadcast(sockets: Set<WebSocket>, serverEvent: ServerEvent): void {
  const encoded = JSON.stringify(serverEvent);
  for (const socket of sockets) if (socket.readyState === 1) socket.send(encoded);
}

async function main(): Promise<void> {
  const handle = await startWebServer();
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    log.error("web server failed", { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
