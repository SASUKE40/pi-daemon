import { PROTOCOL_VERSION } from "./version.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageAttachment {
  id?: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data?: string;
  name?: string;
}

interface CommandBase {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
}

export type ClientCommand =
  | (CommandBase & { type: "session.list" })
  | (CommandBase & { type: "session.create"; cwd: string; name?: string; model?: { provider: string; id: string }; thinking?: ThinkingLevel })
  | (CommandBase & { type: "session.open"; sessionId: string })
  | (CommandBase & { type: "session.rename"; sessionId: string; name: string })
  | (CommandBase & { type: "session.prompt" | "session.steer" | "session.followUp"; sessionId: string; text: string; attachments?: ImageAttachment[] })
  | (CommandBase & { type: "session.abort"; sessionId: string })
  | (CommandBase & { type: "session.setModel"; sessionId: string; provider: string; modelId: string })
  | (CommandBase & { type: "session.setThinking"; sessionId: string; thinking: ThinkingLevel });

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface SessionSnapshot {
  id: string;
  cwd: string;
  name?: string;
  path?: string;
  model?: { provider: string; id: string; name?: string };
  thinking: ThinkingLevel;
  streaming: boolean;
  messages: unknown[];
  availableModels: Array<{ provider: string; id: string; name?: string }>;
}

export type ServerEvent =
  | { type: "ready"; protocolVersion: typeof PROTOCOL_VERSION; requestId?: string; activeSessionId?: string }
  | { type: "session.list"; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; sessions: SessionSummary[] }
  | { type: "session.snapshot"; protocolVersion: typeof PROTOCOL_VERSION; requestId?: string; session: SessionSnapshot }
  | { type: "session.event"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; seq: number; event: unknown }
  | { type: "session.status"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; seq: number; status: "idle" | "running" | "aborting" | "error"; message?: string }
  | { type: "queue.update"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; seq: number; steering: readonly string[]; followUp: readonly string[] }
  | { type: "error"; protocolVersion: typeof PROTOCOL_VERSION; requestId?: string; code: string; message: string; activeSessionId?: string };

const commandTypes = new Set([
  "session.list", "session.create", "session.open", "session.rename", "session.prompt", "session.steer",
  "session.followUp", "session.abort", "session.setModel", "session.setThinking",
]);

export function parseClientCommand(value: unknown): ClientCommand {
  if (!value || typeof value !== "object") throw new Error("Command must be an object");
  const command = value as Record<string, unknown>;
  if (command.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${String(command.protocolVersion)}`);
  if (typeof command.requestId !== "string" || command.requestId.length < 1 || command.requestId.length > 128) throw new Error("Invalid requestId");
  if (typeof command.type !== "string" || !commandTypes.has(command.type)) throw new Error("Unknown command type");
  if (command.type !== "session.list" && command.type !== "session.create") {
    if (typeof command.sessionId !== "string" || !command.sessionId) throw new Error("sessionId is required");
  }
  if (["session.prompt", "session.steer", "session.followUp"].includes(command.type) && typeof command.text !== "string") throw new Error("text is required");
  if (command.type === "session.create" && (typeof command.cwd !== "string" || !command.cwd)) throw new Error("cwd is required");
  if (command.type === "session.rename" && (typeof command.name !== "string" || !command.name.trim())) throw new Error("name is required");
  if (command.type === "session.setThinking" && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(command.thinking))) throw new Error("Invalid thinking level");
  return value as ClientCommand;
}

type WithoutProtocol<T> = T extends { protocolVersion: unknown } ? Omit<T, "protocolVersion"> : never;

export function event(value: WithoutProtocol<ServerEvent>): ServerEvent {
  return { protocolVersion: PROTOCOL_VERSION, ...value } as ServerEvent;
}
