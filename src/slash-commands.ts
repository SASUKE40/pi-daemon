import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "./protocol.js";

/** Public built-ins shipped by the installed Pi coding agent. */
export const WEB_BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "settings", description: "Open settings menu", source: "builtin" },
  { name: "model", description: "Select model", source: "builtin" },
  { name: "scoped-models", description: "Enable or disable models for cycling", source: "builtin" },
  { name: "export", description: "Export session as HTML or JSONL", source: "builtin" },
  { name: "import", description: "Import and resume a JSONL session", source: "builtin" },
  { name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
  { name: "copy", description: "Copy the last Pi message", source: "builtin" },
  { name: "name", description: "Set the session display name", source: "builtin" },
  { name: "session", description: "Show session information and statistics", source: "builtin" },
  { name: "changelog", description: "Show Pi version history", source: "builtin" },
  { name: "hotkeys", description: "Show keyboard shortcuts", source: "builtin" },
  { name: "fork", description: "Fork from a previous user message", source: "builtin" },
  { name: "clone", description: "Duplicate the current session branch", source: "builtin" },
  { name: "tree", description: "Navigate the session tree", source: "builtin" },
  { name: "trust", description: "Save the project trust decision", source: "builtin" },
  { name: "login", description: "Configure provider authentication", source: "builtin" },
  { name: "logout", description: "Remove provider authentication", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "compact", description: "Manually compact the session context", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin" },
  { name: "reload", description: "Reload Pi resources and settings", source: "builtin" },
  { name: "quit", description: "Close this Pi runtime", source: "builtin" },
];

/** Return web-native built-ins plus every command AgentSession.prompt() can execute. */
export function getSlashCommands(session: AgentSession): SlashCommand[] {
  const extensions: SlashCommand[] = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    ...(command.description ? { description: command.description } : {}),
    source: "extension",
  }));
  const prompts: SlashCommand[] = session.promptTemplates.map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    source: "prompt",
  }));
  const skills: SlashCommand[] = session.settingsManager.getEnableSkillCommands()
    ? session.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      ...(skill.description ? { description: skill.description } : {}),
      source: "skill",
    }))
    : [];
  return [...WEB_BUILTIN_SLASH_COMMANDS, ...extensions, ...prompts, ...skills];
}
