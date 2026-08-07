import { validateHostname } from "./cloudflare.js";
import type { TailscaleConfig } from "./config.js";

export interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: string | number };
  User?: Record<string, { LoginName?: string }>;
}

export function tailscaleHostname(status: TailscaleStatus): string {
  const hostname = status.Self?.DNSName?.replace(/\.$/, "").toLowerCase();
  if (!hostname) throw new Error("Tailscale MagicDNS hostname is unavailable. Enable MagicDNS and HTTPS for this tailnet.");
  validateHostname(hostname);
  return hostname;
}

export function detectedTailscaleLogin(status: TailscaleStatus): string | undefined {
  const users = status.User || {};
  const selfUser = status.Self?.UserID === undefined ? undefined : users[String(status.Self.UserID)];
  const values = Object.values(users);
  return selfUser?.LoginName || (values.length === 1 ? values[0]?.LoginName : undefined);
}

export function tailscaleServeArgs(config: TailscaleConfig): string[] {
  return ["serve", `--https=${config.httpsPort}`, "--bg", tailscaleTarget(config)];
}

export function tailscaleTarget(config: TailscaleConfig): string {
  return `http://127.0.0.1:${config.localPort}`;
}

export function hasServeConfiguration(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === "object" && Object.keys(parsed as Record<string, unknown>).length);
  } catch {
    return true;
  }
}

export function validateTailscaleLogin(value: string): void {
  if (!/^[^\s]{1,320}$/.test(value)) throw new Error("Invalid Tailscale login");
}
