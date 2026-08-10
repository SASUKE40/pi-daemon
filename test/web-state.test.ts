// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appReducer, decodeApplicationServerKey, filterSlashCommands, mergeSlashCommands, parseBuiltinSlashCommand, slashCommandQuery } from "../web/app.tsx";

describe("React web state", () => {
  it("replaces live assistant output with the finalized message", () => {
    const initial = { connected: true, daemonConnected: true, sessions: [], timeline: [], status: "running" as const, queue: { steering: [], followUp: [] } };
    const streaming = appReducer(initial, { type: "session.event", value: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } } });
    expect(streaming.timeline).toHaveLength(1);
    expect((streaming.timeline[0] as { __live?: boolean }).__live).toBe(true);
    const finished = appReducer(streaming, { type: "session.event", value: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } } });
    expect(finished.timeline).toEqual([{ role: "assistant", content: [{ type: "text", text: "Hello" }] }]);
  });

  it("decodes a URL-safe VAPID application key", () => {
    expect(Array.from(decodeApplicationServerKey("AQIDBA"))).toEqual([1, 2, 3, 4]);
  });

  it("opens slash completion only for a command token and prioritizes name matches", () => {
    const commands = [
      { name: "review", description: "Inspect the change", source: "extension" as const },
      { name: "skill:inspect", description: "Review with a skill", source: "skill" as const },
      { name: "release", description: "Ship to production", source: "prompt" as const },
    ];
    expect(slashCommandQuery("/")).toBe("");
    expect(slashCommandQuery("/review ")).toBeUndefined();
    expect(slashCommandQuery("message /review")).toBeUndefined();
    expect(filterSlashCommands(commands, "rev").map((command) => command.name)).toEqual(["review", "skill:inspect"]);
  });

  it("recognizes only advertised built-in slash commands", () => {
    const commands = [
      { name: "new", description: "Start a new session", source: "builtin" as const },
      { name: "review", description: "Review changes", source: "extension" as const },
    ];
    expect(parseBuiltinSlashCommand("/new", commands)).toEqual({ name: "new", arguments: "" });
    expect(parseBuiltinSlashCommand("/new  now ", commands)).toEqual({ name: "new", arguments: "now" });
    expect(parseBuiltinSlashCommand("/review", commands)).toBeUndefined();
    expect(parseBuiltinSlashCommand("/missing", commands)).toBeUndefined();
  });

  it("adds missing built-ins and deduplicates built-ins already sent by the daemon", () => {
    const commands = mergeSlashCommands([
      { name: "model", description: "Select model", source: "builtin" },
      { name: "deploy", description: "Deploy", source: "extension" },
    ]);
    expect(commands.filter((command) => command.source === "builtin" && command.name === "model")).toHaveLength(1);
    expect(commands.at(-1)).toEqual({ name: "deploy", description: "Deploy", source: "extension" });
  });
});
