import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { activeRelay, type PiDaemonConfig } from "./config.js";
import { getAppPaths } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface ServiceCommands {
  node: string;
  sessiondScript: string;
  webScript: string;
  cloudflared?: string;
}

export function currentServiceCommands(cloudflared?: string): ServiceCommands {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    node: process.execPath,
    sessiondScript: join(here, "sessiond.js"),
    webScript: join(here, "web.js"),
    ...(cloudflared ? { cloudflared } : {}),
  };
}

export function renderSystemdServices(commands: ServiceCommands, includeCloudflared = Boolean(commands.cloudflared)): Record<string, string> {
  const paths = getAppPaths();
  const common = `[Unit]\nAfter=graphical-session.target\nPartOf=graphical-session.target\n\n[Service]\nRestart=on-failure\nRestartSec=2\nEnvironmentFile=-${escapeSystemd(join(paths.configDir, "desktop.env"))}\n`;
  const services: Record<string, string> = {
    "pi-daemon-sessiond.service": `${common}ExecStart=${escapeSystemd(commands.node)} ${escapeSystemd(commands.sessiondScript)}\n\n[Install]\nWantedBy=graphical-session.target\n`,
    "pi-daemon-web.service": `${common}After=pi-daemon-sessiond.service\nExecStart=${escapeSystemd(commands.node)} ${escapeSystemd(commands.webScript)}\n\n[Install]\nWantedBy=graphical-session.target\n`,
  };
  if (includeCloudflared) {
    if (!commands.cloudflared) throw new Error("cloudflared command is required for the Cloudflare relay");
    services["pi-daemon-cloudflared.service"] = `${common}After=pi-daemon-web.service network-online.target\nExecStart=${escapeSystemd(commands.cloudflared)} tunnel run --token-file ${escapeSystemd(paths.tunnelTokenFile)}\n\n[Install]\nWantedBy=graphical-session.target\n`;
  }
  return services;
}

export function renderLaunchAgents(commands: ServiceCommands, includeCloudflared = Boolean(commands.cloudflared)): Record<string, string> {
  const paths = getAppPaths();
  const agents: Record<string, string> = {
    "com.edward40.pi-daemon.sessiond.plist": renderPlist("com.edward40.pi-daemon.sessiond", commands.node, [commands.sessiondScript], join(paths.logDir, "sessiond.log")),
    "com.edward40.pi-daemon.web.plist": renderPlist("com.edward40.pi-daemon.web", commands.node, [commands.webScript], join(paths.logDir, "web.log")),
  };
  if (includeCloudflared) {
    if (!commands.cloudflared) throw new Error("cloudflared command is required for the Cloudflare relay");
    agents["com.edward40.pi-daemon.cloudflared.plist"] = renderPlist("com.edward40.pi-daemon.cloudflared", commands.cloudflared, ["tunnel", "run", "--token-file", paths.tunnelTokenFile], join(paths.logDir, "cloudflared.log"));
  }
  return agents;
}

export async function installUserServices(config: PiDaemonConfig, commands: ServiceCommands): Promise<void> {
  const includeCloudflared = activeRelay(config) === "cloudflare";
  const paths = getAppPaths();
  await mkdir(paths.logDir, { recursive: true, mode: 0o700 });
  if (process.platform === "linux") {
    const directory = join(homedir(), ".config", "systemd", "user");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeDesktopEnvironment();
    if (!includeCloudflared) {
      await execFileAsync("systemctl", ["--user", "disable", "--now", "pi-daemon-cloudflared.service"]).catch(() => undefined);
      await rm(join(directory, "pi-daemon-cloudflared.service"), { force: true });
    }
    const rendered = renderSystemdServices(commands, includeCloudflared);
    for (const [name, content] of Object.entries(rendered)) await writeFile(join(directory, name), content, { mode: 0o600 });
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    const units = Object.keys(rendered);
    await execFileAsync("systemctl", ["--user", "enable", ...units]);
    await execFileAsync("systemctl", ["--user", "restart", ...units]);
    return;
  }
  if (process.platform === "darwin") {
    const directory = join(homedir(), "Library", "LaunchAgents");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const domain = `gui/${process.getuid?.() ?? 0}`;
    if (!includeCloudflared) {
      await execFileAsync("launchctl", ["bootout", `${domain}/com.edward40.pi-daemon.cloudflared`]).catch(() => undefined);
      await rm(join(directory, "com.edward40.pi-daemon.cloudflared.plist"), { force: true });
    }
    for (const [name, content] of Object.entries(renderLaunchAgents(commands, includeCloudflared))) {
      const target = join(directory, name);
      await writeFile(target, content, { mode: 0o600 });
      const label = name.replace(/\.plist$/, "");
      await execFileAsync("launchctl", ["bootout", `${domain}/${label}`]).catch(() => undefined);
      await bootstrapLaunchAgent(domain, target);
    }
    return;
  }
  throw new Error(`Unsupported service platform: ${process.platform}`);
}

async function bootstrapLaunchAgent(domain: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await execFileAsync("launchctl", ["bootstrap", domain, target]);
      return;
    } catch (error) {
      lastError = error;
      const item = error as { code?: number | string; stderr?: string };
      const retryable = item.code === 5 || item.code === "5" || item.stderr?.includes("Bootstrap failed: 5");
      if (!retryable || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError;
}

export async function stopAndRemoveUserServices(): Promise<void> {
  if (process.platform === "linux") {
    await execFileAsync("systemctl", ["--user", "disable", "--now", "pi-daemon-sessiond.service", "pi-daemon-web.service", "pi-daemon-cloudflared.service"]).catch(() => undefined);
    const directory = join(homedir(), ".config", "systemd", "user");
    for (const name of ["pi-daemon-sessiond.service", "pi-daemon-web.service", "pi-daemon-cloudflared.service"]) await rm(join(directory, name), { force: true });
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return;
  }
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    for (const label of ["com.edward40.pi-daemon.sessiond", "com.edward40.pi-daemon.web", "com.edward40.pi-daemon.cloudflared"]) {
      await execFileAsync("launchctl", ["bootout", `${domain}/${label}`]).catch(() => undefined);
      await rm(join(homedir(), "Library", "LaunchAgents", `${label}.plist`), { force: true });
    }
  }
}

export async function restartService(target: "sessiond" | "web" | "tunnel" | "all", includeTunnel = true): Promise<void> {
  const requested: Array<"sessiond" | "web" | "tunnel"> = target === "all" ? ["sessiond", "web", "tunnel"] : [target];
  const names = includeTunnel ? requested : requested.filter((name) => name !== "tunnel");
  if (!names.length) return;
  if (process.platform === "linux") {
    const units = names.map((name) => `pi-daemon-${name === "tunnel" ? "cloudflared" : name}.service`);
    await execFileAsync("systemctl", ["--user", "restart", ...units]);
    return;
  }
  const mapping = { sessiond: "com.edward40.pi-daemon.sessiond", web: "com.edward40.pi-daemon.web", tunnel: "com.edward40.pi-daemon.cloudflared" };
  for (const name of names) await execFileAsync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${mapping[name]}`]);
}

async function writeDesktopEnvironment(): Promise<void> {
  const paths = getAppPaths();
  const keys = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  const content = keys.flatMap((key) => process.env[key] ? [`${key}=${escapeEnvironment(process.env[key] as string)}`] : []).join("\n");
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.configDir, "desktop.env"), `${content}\n`, { mode: 0o600 });
  await chmod(join(paths.configDir, "desktop.env"), 0o600);
}

function renderPlist(label: string, program: string, args: string[], logFile: string): string {
  const argumentXml = [program, ...args].map((item) => `      <string>${escapeXml(item)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${escapeXml(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${argumentXml}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ProcessType</key><string>Interactive</string>\n  <key>StandardOutPath</key><string>${escapeXml(logFile)}</string>\n  <key>StandardErrorPath</key><string>${escapeXml(logFile)}</string>\n</dict>\n</plist>\n`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeSystemd(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function escapeEnvironment(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "")}"`;
}
