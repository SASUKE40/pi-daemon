import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PORT } from "./version.js";
import { getAppPaths } from "./paths.js";

export interface CloudflareConfig {
  accountId: string;
  zoneId: string;
  tunnelId: string;
  accessAppId: string;
  audience: string;
  teamDomain: string;
  hostname: string;
  allowedEmail: string;
}

export interface PiDaemonConfig {
  schemaVersion: 1;
  listenHost: "127.0.0.1";
  port: number;
  defaultCwd: string;
  agentDir: string;
  cloudflare?: CloudflareConfig;
}

export function defaultConfig(): PiDaemonConfig {
  return {
    schemaVersion: 1,
    listenHost: "127.0.0.1",
    port: DEFAULT_PORT,
    defaultCwd: process.cwd(),
    agentDir: process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi/agent`,
  };
}

export function validateConfig(value: unknown): PiDaemonConfig {
  if (!value || typeof value !== "object") throw new Error("Configuration must be an object");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1) throw new Error("Unsupported configuration schema");
  if (item.listenHost !== "127.0.0.1") throw new Error("listenHost must remain 127.0.0.1");
  if (!Number.isInteger(item.port) || Number(item.port) < 1 || Number(item.port) > 65535) throw new Error("Invalid port");
  if (typeof item.defaultCwd !== "string" || !item.defaultCwd) throw new Error("Invalid defaultCwd");
  if (typeof item.agentDir !== "string" || !item.agentDir) throw new Error("Invalid agentDir");
  if (item.cloudflare !== undefined) validateCloudflareConfig(item.cloudflare);
  return value as PiDaemonConfig;
}

export function validateCloudflareConfig(value: unknown): asserts value is CloudflareConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid Cloudflare configuration");
  const item = value as Record<string, unknown>;
  for (const key of ["accountId", "zoneId", "tunnelId", "accessAppId", "audience", "teamDomain", "hostname", "allowedEmail"]) {
    if (typeof item[key] !== "string" || !(item[key] as string)) throw new Error(`Invalid Cloudflare field: ${key}`);
  }
}

export async function loadConfig(): Promise<PiDaemonConfig> {
  const { configFile } = getAppPaths();
  try {
    return validateConfig(JSON.parse(await readFile(configFile, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
}

export async function saveConfig(config: PiDaemonConfig): Promise<void> {
  validateConfig(config);
  const { configFile } = getAppPaths();
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, configFile);
}
