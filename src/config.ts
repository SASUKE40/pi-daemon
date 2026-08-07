import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PORT } from "./version.js";
import { getAppPaths } from "./paths.js";

interface CloudflareConfigBase {
  accountId: string;
  zoneId: string;
  tunnelId: string;
  accessAppId: string;
  audience: string;
  teamDomain: string;
  hostname: string;
}

export interface CloudflareGitHubAccess {
  type: "github";
  identityProviderId: string;
  identityProviderName: string;
  organization: string;
  team?: string;
}

/** New installations use GitHub. The email shape remains readable for in-place migration. */
export type CloudflareConfig = CloudflareConfigBase & (
  | { access: CloudflareGitHubAccess; allowedEmail?: undefined }
  | { access?: undefined; allowedEmail: string }
);

export interface TailscaleConfig {
  hostname: string;
  allowedLogin: string;
  httpsPort: 443;
  localPort: number;
}

export type RelayKind = "cloudflare" | "tailscale";

export interface PiDaemonConfig {
  schemaVersion: 1;
  listenHost: "127.0.0.1";
  port: number;
  defaultCwd: string;
  agentDir: string;
  relay?: RelayKind;
  cloudflare?: CloudflareConfig;
  tailscale?: TailscaleConfig;
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
  if (item.relay !== undefined && item.relay !== "cloudflare" && item.relay !== "tailscale") throw new Error("Invalid relay");
  if (item.cloudflare !== undefined) validateCloudflareConfig(item.cloudflare);
  if (item.tailscale !== undefined) validateTailscaleConfig(item.tailscale);
  if (item.relay === "cloudflare" && item.cloudflare === undefined) throw new Error("Cloudflare relay configuration is missing");
  if (item.relay === "tailscale" && item.tailscale === undefined) throw new Error("Tailscale relay configuration is missing");
  if (item.relay === "tailscale" && (item.tailscale as TailscaleConfig).localPort !== item.port) throw new Error("Tailscale local port must match the web port");
  return value as PiDaemonConfig;
}

export function validateCloudflareConfig(value: unknown): asserts value is CloudflareConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid Cloudflare configuration");
  const item = value as Record<string, unknown>;
  for (const key of ["accountId", "zoneId", "tunnelId", "accessAppId", "audience", "teamDomain", "hostname"]) {
    if (typeof item[key] !== "string" || !(item[key] as string)) throw new Error(`Invalid Cloudflare field: ${key}`);
  }
  const hasLegacyEmail = typeof item.allowedEmail === "string" && Boolean(item.allowedEmail);
  const access = item.access;
  if (hasLegacyEmail === Boolean(access)) throw new Error("Cloudflare configuration must contain exactly one Access identity");
  if (hasLegacyEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.allowedEmail as string)) throw new Error("Invalid Cloudflare field: allowedEmail");
    return;
  }
  if (!access || typeof access !== "object") throw new Error("Invalid Cloudflare field: access");
  const identity = access as Record<string, unknown>;
  if (identity.type !== "github") throw new Error("Invalid Cloudflare Access identity type");
  for (const key of ["identityProviderId", "identityProviderName", "organization"]) {
    if (typeof identity[key] !== "string" || !identity[key]) throw new Error(`Invalid Cloudflare Access field: ${key}`);
  }
  if (identity.team !== undefined && (typeof identity.team !== "string" || !identity.team)) throw new Error("Invalid Cloudflare Access field: team");
}

export function validateTailscaleConfig(value: unknown): asserts value is TailscaleConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid Tailscale configuration");
  const item = value as Record<string, unknown>;
  if (typeof item.hostname !== "string" || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(item.hostname)) throw new Error("Invalid Tailscale hostname");
  if (typeof item.allowedLogin !== "string" || !/^[^\s]{1,320}$/.test(item.allowedLogin)) throw new Error("Invalid Tailscale login");
  if (item.httpsPort !== 443) throw new Error("Tailscale Serve must use HTTPS port 443");
  if (!Number.isInteger(item.localPort) || Number(item.localPort) < 1 || Number(item.localPort) > 65535) throw new Error("Invalid Tailscale local port");
}

export function activeRelay(config: PiDaemonConfig): RelayKind | undefined {
  if (config.relay) return config.relay;
  if (config.cloudflare) return "cloudflare";
  if (config.tailscale) return "tailscale";
  return undefined;
}

export function publicHostname(config: PiDaemonConfig): string | undefined {
  const relay = activeRelay(config);
  return relay === "cloudflare" ? config.cloudflare?.hostname : relay === "tailscale" ? config.tailscale?.hostname : undefined;
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
