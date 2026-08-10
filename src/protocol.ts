import { PROTOCOL_VERSION } from "./version.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageAttachment {
  id?: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data?: string;
  name?: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export type BuiltinSlashCommandName =
  | "settings"
  | "model"
  | "scoped-models"
  | "export"
  | "import"
  | "share"
  | "copy"
  | "name"
  | "session"
  | "changelog"
  | "hotkeys"
  | "fork"
  | "clone"
  | "tree"
  | "trust"
  | "login"
  | "logout"
  | "new"
  | "compact"
  | "resume"
  | "reload"
  | "quit";

export interface BuiltinCommandPayload {
  action?: string;
  targetId?: string;
  provider?: string;
  authType?: "api_key" | "oauth";
  apiKey?: string;
  trusted?: boolean;
  enabled?: boolean;
  values?: Record<string, string | boolean | string[] | undefined>;
  modelIds?: string[];
  fileName?: string;
  fileData?: string;
  cwd?: string;
}

export interface BuiltinCommandResult {
  kind: string;
  message?: string;
  [key: string]: unknown;
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
  | (CommandBase & { type: "session.setThinking"; sessionId: string; thinking: ThinkingLevel })
  | (CommandBase & { type: "session.command"; sessionId: string; command: BuiltinSlashCommandName; arguments?: string; payload?: BuiltinCommandPayload });

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
  slashCommands: SlashCommand[];
}

export type ServerEvent =
  | { type: "ready"; protocolVersion: typeof PROTOCOL_VERSION; requestId?: string; activeSessionId?: string; activeSessionIds?: string[] }
  | { type: "session.list"; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; sessions: SessionSummary[] }
  | { type: "session.snapshot"; protocolVersion: typeof PROTOCOL_VERSION; requestId?: string; session: SessionSnapshot }
  | { type: "session.event"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; seq: number; event: unknown }
  | { type: "session.status"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; seq: number; status: "idle" | "running" | "aborting" | "error"; message?: string }
  | { type: "queue.update"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; seq: number; steering: readonly string[]; followUp: readonly string[] }
  | { type: "extension.notification"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; level: "info" | "warning" | "error"; message: string }
  | { type: "command.result"; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; sessionId: string; command: BuiltinSlashCommandName; result: BuiltinCommandResult }
  | { type: "error"; protocolVersion: typeof PROTOCOL_VERSION; requestId?: string; code: string; message: string; activeSessionId?: string };

const commandTypes = new Set([
  "session.list", "session.create", "session.open", "session.rename", "session.prompt", "session.steer",
  "session.followUp", "session.abort", "session.setModel", "session.setThinking", "session.command",
]);
const builtinCommandNames = new Set<BuiltinSlashCommandName>([
  "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
  "changelog", "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact",
  "resume", "reload", "quit",
]);
const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const imageMimeTypes = new Set<ImageAttachment["mimeType"]>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_SESSION_ID_LENGTH = 4_096;
const MAX_PATH_LENGTH = 32_768;
const MAX_NAME_LENGTH = 256;
const MAX_MODEL_FIELD_LENGTH = 256;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_DATA_LENGTH = Math.ceil((10 * 1024 * 1024) / 3) * 4;

export function parseClientCommand(value: unknown): ClientCommand {
  if (!value || typeof value !== "object") throw new Error("Command must be an object");
  const command = value as Record<string, unknown>;
  if (command.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${String(command.protocolVersion)}`);
  requireString(command.requestId, "requestId", 128);
  if (typeof command.type !== "string" || !commandTypes.has(command.type)) throw new Error("Unknown command type");
  if (command.type !== "session.list" && command.type !== "session.create") {
    requireString(command.sessionId, "sessionId", MAX_SESSION_ID_LENGTH);
  }
  if (command.type === "session.create") {
    requireString(command.cwd, "cwd", MAX_PATH_LENGTH);
    if (command.name !== undefined) requireString(command.name, "name", MAX_NAME_LENGTH);
    if (command.thinking !== undefined) validateThinking(command.thinking);
    if (command.model !== undefined) {
      if (!command.model || typeof command.model !== "object" || Array.isArray(command.model)) throw new Error("Invalid model");
      const model = command.model as Record<string, unknown>;
      requireString(model.provider, "model provider", MAX_MODEL_FIELD_LENGTH);
      requireString(model.id, "model id", MAX_MODEL_FIELD_LENGTH);
    }
  }
  if (command.type === "session.rename") requireString(command.name, "name", MAX_NAME_LENGTH);
  if (["session.prompt", "session.steer", "session.followUp"].includes(command.type)) {
    requireString(command.text, "text", MAX_PROMPT_LENGTH, true);
    if (command.attachments !== undefined) validateAttachments(command.attachments);
  }
  if (command.type === "session.setModel") {
    requireString(command.provider, "provider", MAX_MODEL_FIELD_LENGTH);
    requireString(command.modelId, "modelId", MAX_MODEL_FIELD_LENGTH);
  }
  if (command.type === "session.setThinking") validateThinking(command.thinking);
  if (command.type === "session.command") {
    if (typeof command.command !== "string" || !builtinCommandNames.has(command.command as BuiltinSlashCommandName)) throw new Error("Invalid built-in command");
    if (command.arguments !== undefined) requireString(command.arguments, "arguments", MAX_PATH_LENGTH, true);
    if (command.payload !== undefined) validateBuiltinPayload(command.payload);
  }
  return value as ClientCommand;
}

function requireString(value: unknown, field: string, maxLength: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maxLength) throw new Error(`Invalid ${field}`);
}

function validateThinking(value: unknown): asserts value is ThinkingLevel {
  if (typeof value !== "string" || !thinkingLevels.has(value as ThinkingLevel)) throw new Error("Invalid thinking level");
}

function validateAttachments(value: unknown): asserts value is ImageAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error(`attachments must contain at most ${MAX_ATTACHMENTS} images`);
  for (const [index, attachment] of value.entries()) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) throw new Error(`Invalid attachment at index ${index}`);
    const item = attachment as Record<string, unknown>;
    if (typeof item.mimeType !== "string" || !imageMimeTypes.has(item.mimeType as ImageAttachment["mimeType"])) {
      throw new Error(`Invalid attachment mimeType at index ${index}`);
    }
    if (item.id !== undefined) requireString(item.id, `attachment id at index ${index}`, 128);
    if (item.name !== undefined) requireString(item.name, `attachment name at index ${index}`, 255);
    if (item.data !== undefined) {
      if (typeof item.data !== "string" || !item.data || item.data.length > MAX_ATTACHMENT_DATA_LENGTH
        || item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.data)) {
        throw new Error(`Invalid attachment data at index ${index}`);
      }
    }
    if (item.id === undefined && item.data === undefined) throw new Error(`Attachment id or data is required at index ${index}`);
  }
}

function validateBuiltinPayload(value: unknown): asserts value is BuiltinCommandPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command payload");
  const payload = value as Record<string, unknown>;
  const stringLimits: Record<string, number> = {
    action: 64,
    targetId: 4_096,
    provider: 256,
    apiKey: 16_384,
    fileName: 255,
    fileData: 40 * 1024 * 1024,
    cwd: MAX_PATH_LENGTH,
  };
  for (const [field, limit] of Object.entries(stringLimits)) {
    if (payload[field] !== undefined) requireString(payload[field], field, limit, field === "apiKey");
  }
  if (payload.authType !== undefined && payload.authType !== "api_key" && payload.authType !== "oauth") throw new Error("Invalid authType");
  if (payload.trusted !== undefined && typeof payload.trusted !== "boolean") throw new Error("Invalid trusted value");
  if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") throw new Error("Invalid enabled value");
  if (payload.modelIds !== undefined) validateStringArray(payload.modelIds, "modelIds", 2_048, 512);
  if (payload.values !== undefined) {
    if (!payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)) throw new Error("Invalid settings values");
    for (const [key, item] of Object.entries(payload.values as Record<string, unknown>)) {
      if (key.length > 128) throw new Error("Invalid settings key");
      if (typeof item === "string" || typeof item === "boolean" || item === undefined) continue;
      if (Array.isArray(item)) validateStringArray(item, key, 2_048, 512);
      else throw new Error(`Invalid settings value: ${key}`);
    }
  }
}

function validateStringArray(value: unknown, field: string, maxItems: number, maxLength: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > maxLength)) {
    throw new Error(`Invalid ${field}`);
  }
}

type WithoutProtocol<T> = T extends { protocolVersion: unknown } ? Omit<T, "protocolVersion"> : never;

export function event(value: WithoutProtocol<ServerEvent>): ServerEvent {
  return { protocolVersion: PROTOCOL_VERSION, ...value } as ServerEvent;
}
