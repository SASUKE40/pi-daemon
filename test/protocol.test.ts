import { describe, expect, it } from "vitest";
import { parseClientCommand } from "../src/protocol.js";

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

  it("rejects invalid thinking levels", () => {
    expect(() => parseClientCommand({ protocolVersion: 1, requestId: "1", type: "session.setThinking", sessionId: "s", thinking: "extreme" })).toThrow("thinking");
  });
});
