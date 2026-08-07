import { describe, expect, it } from "vitest";
import { assistantNotificationPreview, notificationExcerpt, SessionNotificationTracker } from "../src/sessiond.js";

describe("session notification previews", () => {
  it("uses finalized assistant text without thinking or tool content", () => {
    expect(assistantNotificationPreview({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Finished\n\nthe requested change." },
        { type: "toolCall", name: "bash", arguments: { command: "secret" } },
      ],
    })).toBe("Finished the requested change.");
    expect(assistantNotificationPreview({ role: "user", content: [{ type: "text", text: "ignore" }] })).toBeUndefined();
  });

  it("uses a Unicode-safe 160-character maximum and a fallback", () => {
    const excerpt = notificationExcerpt(`${"🙂 ".repeat(100)}the end`, "fallback");
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(160);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(notificationExcerpt(" \n ", "fallback")).toBe("fallback");
  });
});

describe("SessionNotificationTracker", () => {
  it("delivers completion exactly once using the last finalized response", () => {
    const tracker = new SessionNotificationTracker();
    tracker.begin();
    tracker.capture({ role: "assistant", content: [{ type: "text", text: "First" }] });
    tracker.capture({ role: "assistant", content: [{ type: "text", text: "Final answer" }] });
    expect(tracker.complete("session-1")).toEqual({ sessionId: "session-1", outcome: "completed", body: "Final answer" });
    expect(tracker.complete("session-1")).toBeUndefined();
    expect(tracker.fail("session-1", "late error")).toBeUndefined();
  });

  it("suppresses both success and failure after a user abort", () => {
    const tracker = new SessionNotificationTracker();
    tracker.begin();
    tracker.abort();
    expect(tracker.complete("session-1")).toBeUndefined();
    expect(tracker.fail("session-1", "aborted")).toBeUndefined();
  });

  it("creates a distinct, single-line failure notification", () => {
    const tracker = new SessionNotificationTracker();
    tracker.begin();
    expect(tracker.fail("session-1", "Provider\nfailed")).toEqual({ sessionId: "session-1", outcome: "failed", body: "Provider failed" });
  });
});
