// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appReducer, decodeApplicationServerKey } from "../web/app.tsx";

describe("React web state", () => {
  it("replaces live assistant output with the finalized message", () => {
    const initial = { connected: true, daemonConnected: true, sessions: [], timeline: [], status: "running" as const };
    const streaming = appReducer(initial, { type: "session.event", value: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } } });
    expect(streaming.timeline).toHaveLength(1);
    expect((streaming.timeline[0] as { __live?: boolean }).__live).toBe(true);
    const finished = appReducer(streaming, { type: "session.event", value: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } } });
    expect(finished.timeline).toEqual([{ role: "assistant", content: [{ type: "text", text: "Hello" }] }]);
  });

  it("decodes a URL-safe VAPID application key", () => {
    expect(Array.from(decodeApplicationServerKey("AQIDBA"))).toEqual([1, 2, 3, 4]);
  });
});
