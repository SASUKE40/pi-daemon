import { describe, expect, it } from "vitest";
import { event, parseClientCommand } from "../src/protocol.js";

describe("parseClientCommand", () => {
  it("accepts a valid prompt", () => {
    expect(parseClientCommand({
      protocolVersion: 1,
      requestId: "request-1",
      type: "session.prompt",
      sessionId: "session-1",
      text: "hello",
    }).type).toBe("session.prompt");
  });

  it("rejects unknown protocol versions", () => {
    expect(() => parseClientCommand({ protocolVersion: 2, requestId: "1", type: "session.list" })).toThrow("Unsupported protocol");
  });

  it("requires a session id for session operations", () => {
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.abort" })).toThrow("sessionId");
  });

  it("accepts every command shape", () => {
    const commands = [
      { type: "session.list" },
      { type: "session.create", cwd: "/tmp/work", name: "Work", model: { provider: "openai", id: "gpt" }, thinking: "high" },
      { type: "session.open", sessionId: "s" },
      { type: "session.rename", sessionId: "s", name: "Renamed" },
      { type: "session.prompt", sessionId: "s", text: "hello", attachments: [{ id: "upload", mimeType: "image/png" }] },
      { type: "session.steer", sessionId: "s", text: "adjust", attachments: [{ data: "YWJj", mimeType: "image/jpeg", name: "photo.jpg" }] },
      { type: "session.followUp", sessionId: "s", text: "next" },
      { type: "session.abort", sessionId: "s" },
      { type: "session.refreshModels", sessionId: "s" },
      { type: "session.setModel", sessionId: "s", provider: "anthropic", modelId: "claude" },
      { type: "session.setThinking", sessionId: "s", thinking: "xhigh" },
      { type: "session.command", sessionId: "s", command: "tree", payload: { targetId: "entry-1" } },
    ];

    for (const [index, command] of commands.entries()) {
      expect(parseClientCommand({ protocolVersion: 1, requestId: `request-${index}`, ...command })).toMatchObject(command);
    }
  });

  it("validates thinking levels on both create and update", () => {
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.setThinking", sessionId: "s", thinking: "extreme" })).toThrow("thinking");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.create", cwd: "/tmp", thinking: "extreme" })).toThrow("thinking");
  });

  it("accepts only known and bounded built-in command payloads", () => {
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.command", sessionId: "s", command: "does-not-exist" })).toThrow("built-in command");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.command", sessionId: "s", command: "login", payload: { authType: "password" } })).toThrow("authType");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.command", sessionId: "s", command: "scoped-models", payload: { modelIds: [42] } })).toThrow("modelIds");
  });

  it("validates names and model identifiers before commands have side effects", () => {
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.create", cwd: "/tmp", name: "  " })).toThrow("name");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.create", cwd: "/tmp", model: null })).toThrow("model");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.create", cwd: "/tmp", model: { provider: "openai" } })).toThrow("model id");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.setModel", sessionId: "s", provider: "", modelId: "gpt" })).toThrow("provider");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.rename", sessionId: "s", name: "x".repeat(257) })).toThrow("name");
  });

  it("rejects unsafe or malformed attachment payloads", () => {
    const prompt = (attachments: unknown) => ({
      protocolVersion: 1, requestId: "1", type: "session.prompt", sessionId: "s", text: "hello", attachments,
    });
    expect(() => parseClientCommand(prompt({ id: "one", mimeType: "image/png" }))).toThrow("attachments");
    expect(() => parseClientCommand(prompt(Array.from({ length: 5 }, (_, index) => ({ id: String(index), mimeType: "image/png" }))))).toThrow("at most 4");
    expect(() => parseClientCommand(prompt([{ id: "one", mimeType: "image/svg+xml" }]))).toThrow("mimeType");
    expect(() => parseClientCommand(prompt([{ mimeType: "image/png" }]))).toThrow("id or data");
    expect(() => parseClientCommand(prompt([{ data: "not base64", mimeType: "image/png" }]))).toThrow("data");
  });

  it("bounds identifiers, paths, and prompt frames", () => {
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: " ", type: "session.list" })).toThrow("requestId");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "x".repeat(129), type: "session.list" })).toThrow("requestId");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.open", sessionId: "x".repeat(4_097) })).toThrow("sessionId");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.create", cwd: "x".repeat(32_769) })).toThrow("cwd");
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.prompt", sessionId: "s", text: "x".repeat(1_000_001) })).toThrow("text");
  });

  it("adds the current protocol version to server events", () => {
    expect(event({ type: "ready" })).toEqual({ protocolVersion: 1, type: "ready" });
  });
});
