import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getSlashCommands, WEB_BUILTIN_SLASH_COMMANDS } from "../src/slash-commands.js";

describe("getSlashCommands", () => {
  it("matches Pi's complete public built-in command list", () => {
    expect(WEB_BUILTIN_SLASH_COMMANDS.map(({ name }) => name)).toEqual([
      "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
      "changelog", "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact",
      "resume", "reload", "quit",
    ]);
  });

  it("returns extension, prompt-template, and enabled skill commands in Pi invocation order", () => {
    const session = {
      extensionRunner: {
        getRegisteredCommands: () => [
          { invocationName: "review", description: "Review the current change" },
          { invocationName: "review:1", description: "Run the other review command" },
        ],
      },
      promptTemplates: [{ name: "fix-tests", description: "Repair test failures" }],
      settingsManager: { getEnableSkillCommands: () => true },
      resourceLoader: { getSkills: () => ({ skills: [{ name: "browser", description: "Control a browser" }] }) },
    } as unknown as AgentSession;

    expect(getSlashCommands(session)).toEqual([
      ...WEB_BUILTIN_SLASH_COMMANDS,
      { name: "review", description: "Review the current change", source: "extension" },
      { name: "review:1", description: "Run the other review command", source: "extension" },
      { name: "fix-tests", description: "Repair test failures", source: "prompt" },
      { name: "skill:browser", description: "Control a browser", source: "skill" },
    ]);
  });

  it("omits skill commands when Pi has disabled them", () => {
    const session = {
      extensionRunner: { getRegisteredCommands: () => [] },
      promptTemplates: [],
      settingsManager: { getEnableSkillCommands: () => false },
      resourceLoader: { getSkills: () => { throw new Error("skills should not be read"); } },
    } as unknown as AgentSession;
    expect(getSlashCommands(session)).toEqual(WEB_BUILTIN_SLASH_COMMANDS);
  });
});
