import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "./protocol.js";

/** Return every slash command AgentSession.prompt() can execute in this runtime. */
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
  return [...extensions, ...prompts, ...skills];
}
