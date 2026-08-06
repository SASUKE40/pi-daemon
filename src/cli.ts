#!/usr/bin/env node
import { access, chmod, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import qrcode from "qrcode-terminal";
import { CloudflareClient, type CloudflareAccount, type CloudflareZone } from "./cloudflare.js";
import { defaultConfig, loadConfig, saveConfig, type PiDaemonConfig } from "./config.js";
import { getAppPaths } from "./paths.js";
import { currentServiceCommands, installUserServices, restartService, stopAndRemoveUserServices } from "./services.js";
import { TerminalPrompter } from "./terminal.js";
import { CLOUDFLARED_VERSION, PI_VERSION, VERSION } from "./version.js";

const execFileAsync = promisify(execFile);
const INSTALL_URL = "https://github.com/SASUKE40/pi-daemon/releases/latest/download/install.sh";

async function main(): Promise<void> {
  const [command = "status", ...args] = process.argv.slice(2);
  switch (command) {
    case "setup": await setup(); return;
    case "status": await status(); return;
    case "doctor": await doctor(); return;
    case "logs": await logs((args[0] || "all") as "sessiond" | "web" | "tunnel" | "all"); return;
    case "restart": await restartService((args[0] || "all") as "sessiond" | "web" | "tunnel" | "all"); return;
    case "update": await update(); return;
    case "uninstall": await uninstall(args.includes("--delete-cloudflare")); return;
    case "version":
    case "--version":
    case "-v": process.stdout.write(`${VERSION}\n`); return;
    case "help":
    case "--help":
    case "-h": printHelp(); return;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function setup(): Promise<void> {
  assertSupportedPlatform();
  const prompt = new TerminalPrompter();
  try {
    prompt.print(`Pi Daemon ${VERSION} setup`);
    prompt.print("This grants the authenticated mobile user access to Pi's coding tools.");
    if (!await prompt.confirm("Any previously exposed Cloudflare tunnel token has been rotated", false)) throw new Error("Rotate the exposed tunnel token before deployment, then run setup again");
    const pi = process.env.PI_DAEMON_PI || await findExecutable("pi");
    if (!pi) throw new Error("Pi CLI is missing. Re-run the one-line installer.");

    if (await prompt.confirm("Open Pi now for local /login provider setup?", true)) {
      prompt.print("In Pi, run /login, finish provider authentication, then exit Pi.");
      const result = prompt.runInteractive(pi);
      if (result.status !== 0) throw new Error("Pi provider setup did not exit cleanly");
    }

    const current = await loadConfig().catch(() => defaultConfig());
    const defaultCwd = await prompt.question("Default working directory", current.defaultCwd);
    if (!(await stat(defaultCwd)).isDirectory()) throw new Error("Default working directory does not exist");
    prompt.print("Create a scoped Cloudflare API token with Account/Zone Read, Tunnel Write, DNS Write, Access Apps/Policies Write, and Access Organizations/Identity Providers Write.");
    const apiToken = await prompt.secret("Cloudflare API token (used once, never saved)");
    const cloudflare = new CloudflareClient(apiToken);
    await cloudflare.verify();
    const account = await selectAccount(await cloudflare.accounts(), prompt);
    const zone = await selectZone(await cloudflare.zones(account.id), prompt);
    const publicHostname = await prompt.question("Public hostname", current.cloudflare?.hostname || `pi.${zone.name}`);
    const allowedEmail = await prompt.question("Only email allowed by Cloudflare Access", current.cloudflare?.allowedEmail);
    const teamName = await prompt.question("Cloudflare Zero Trust team name", `pi-${account.id.slice(0, 8)}`);
    const tunnelName = `pi-daemon-${sanitizeName(hostname())}`;
    prompt.print(`Provisioning protected hostname https://${publicHostname} …`);
    const provisioned = await cloudflare.provision({
      accountId: account.id,
      zoneId: zone.id,
      hostname: publicHostname,
      allowedEmail,
      teamName,
      tunnelName,
      localPort: current.port,
      ...(current.cloudflare ? { previous: current.cloudflare } : {}),
    });

    const paths = getAppPaths();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.tunnelTokenFile, `${provisioned.tunnelToken}\n`, { mode: 0o600 });
    await chmod(paths.tunnelTokenFile, 0o600);
    const config: PiDaemonConfig = { ...current, defaultCwd, cloudflare: provisioned.config };
    await saveConfig(config);
    const cloudflared = await findCloudflared();
    const connectorCount = await runningCloudflaredCount();
    if (connectorCount > 0) prompt.print(`Detected ${connectorCount} existing cloudflared process(es); they will not be modified.`);
    await installUserServices(config, currentServiceCommands(cloudflared));
    prompt.print(`Created or reused: ${provisioned.created.length ? provisioned.created.join(", ") : "all existing managed resources"}`);
    prompt.print(`Mobile URL: https://${publicHostname}`);
    qrcode.generate(`https://${publicHostname}`, { small: true }, (code) => prompt.print(code));
    prompt.print("Setup complete. The Cloudflare API token was not retained.");
  } finally {
    prompt.close();
  }
}

async function status(): Promise<void> {
  const config = await loadConfig();
  const result: Record<string, unknown> = {
    version: VERSION,
    configured: Boolean(config.cloudflare),
    url: config.cloudflare ? `https://${config.cloudflare.hostname}` : undefined,
    localUrl: `http://${config.listenHost}:${config.port}`,
  };
  try {
    const response = await fetch(`http://${config.listenHost}:${config.port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    result.health = await response.json();
  } catch {
    result.health = { ok: false, error: "Web service unavailable" };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function doctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const nodeMajorMinor = process.versions.node.split(".").slice(0, 2).map(Number);
  checks.push({ name: "Node.js", ok: (nodeMajorMinor[0] || 0) > 22 || nodeMajorMinor[0] === 22 && (nodeMajorMinor[1] || 0) >= 19, detail: process.version });
  checks.push({ name: "Platform", ok: ["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch), detail: `${process.platform}/${process.arch}` });
  const pi = await findExecutable("pi");
  const piVersion = pi ? await execFileAsync(pi, ["--version"]).then(({ stdout }) => stdout.trim()).catch(() => "unknown") : "missing";
  checks.push({ name: "Pi", ok: Boolean(pi) && piVersion.includes(PI_VERSION), detail: pi ? `${pi} (${piVersion})` : `required ${PI_VERSION}` });
  const cloudflared = await findExecutable("cloudflared") || await localCloudflared();
  checks.push({ name: "cloudflared", ok: Boolean(cloudflared), detail: cloudflared || `required ${CLOUDFLARED_VERSION}` });
  if (process.platform === "linux") {
    const glibc = getGlibcVersion();
    checks.push({ name: "glibc", ok: Boolean(glibc), detail: glibc || "not detected" });
  }
  try {
    const config = await loadConfig();
    checks.push({ name: "Configuration", ok: true, detail: config.cloudflare?.hostname || "local only" });
  } catch (error) {
    checks.push({ name: "Configuration", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  for (const check of checks) process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}\n`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function logs(target: "sessiond" | "web" | "tunnel" | "all"): Promise<void> {
  if (process.platform === "linux") {
    const names = target === "all" ? ["sessiond", "web", "cloudflared"] : [target === "tunnel" ? "cloudflared" : target];
    spawnSync("journalctl", ["--user", "-n", "200", "-f", ...names.flatMap((name) => ["-u", `pi-daemon-${name}.service`])], { stdio: "inherit" });
    return;
  }
  const paths = getAppPaths();
  const names = target === "all" ? ["sessiond", "web", "cloudflared"] : [target === "tunnel" ? "cloudflared" : target];
  spawnSync("tail", ["-n", "200", "-f", ...names.map((name) => join(paths.logDir, `${name}.log`))], { stdio: "inherit" });
}

async function update(): Promise<void> {
  const paths = getAppPaths();
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const target = join(paths.runtimeDir, `install-${process.pid}.sh`);
  const response = await fetch(INSTALL_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to download installer (${response.status})`);
  await writeFile(target, await response.text(), { mode: 0o700 });
  try {
    const result = spawnSync("sh", [target], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Update installer failed");
  } finally {
    await unlink(target).catch(() => undefined);
  }
}

async function uninstall(deleteCloudflare: boolean): Promise<void> {
  const config = await loadConfig().catch(() => undefined);
  const prompt = new TerminalPrompter();
  try {
    if (!await prompt.confirm("Stop and remove Pi Daemon services and local daemon data?", false)) return;
    await stopAndRemoveUserServices();
    if (deleteCloudflare && config?.cloudflare) {
      prompt.print(`Cloudflare resources for ${config.cloudflare.hostname} will be deleted: tunnel ${config.cloudflare.tunnelId}, Access app ${config.cloudflare.accessAppId}, and its matching CNAME.`);
      if (!await prompt.confirm("Delete those exact Cloudflare resources?", false)) throw new Error("Cloudflare deletion cancelled");
      const token = await prompt.secret("Scoped Cloudflare API token");
      await new CloudflareClient(token).deleteManaged(config.cloudflare);
    }
    const paths = getAppPaths();
    const launcherDir = join(homedir(), ".local", "bin");
    await rm(join(launcherDir, "pi-daemon"), { force: true });
    const piLauncher = join(launcherDir, "pi");
    const piLauncherContent = await readFile(piLauncher, "utf8").catch(() => "");
    if (piLauncherContent.includes(paths.dataDir)) await rm(piLauncher, { force: true });
    await rm(paths.configDir, { recursive: true, force: true });
    await rm(paths.dataDir, { recursive: true, force: true });
    prompt.print("Pi Daemon removed. ~/.pi/agent authentication and sessions were preserved.");
  } finally {
    prompt.close();
  }
}

async function selectAccount(accounts: CloudflareAccount[], prompt: TerminalPrompter): Promise<CloudflareAccount> {
  if (!accounts.length) throw new Error("No Cloudflare accounts visible to this token");
  if (accounts.length === 1) return accounts[0] as CloudflareAccount;
  prompt.print(accounts.map((item, index) => `${index + 1}. ${item.name} (${item.id})`).join("\n"));
  const selected = Number(await prompt.question("Account number", "1")) - 1;
  if (!accounts[selected]) throw new Error("Invalid account selection");
  return accounts[selected] as CloudflareAccount;
}

async function selectZone(zones: CloudflareZone[], prompt: TerminalPrompter): Promise<CloudflareZone> {
  if (!zones.length) throw new Error("No DNS zones visible to this token");
  if (zones.length === 1) return zones[0] as CloudflareZone;
  prompt.print(zones.map((item, index) => `${index + 1}. ${item.name} (${item.id})`).join("\n"));
  const selected = Number(await prompt.question("Zone number", "1")) - 1;
  if (!zones[selected]) throw new Error("Invalid zone selection");
  return zones[selected] as CloudflareZone;
}

async function findCloudflared(): Promise<string> {
  const selected = process.env.PI_DAEMON_CLOUDFLARED || await localCloudflared() || await findExecutable("cloudflared");
  if (!selected) throw new Error("cloudflared is missing. Re-run the one-line installer.");
  return selected;
}

async function localCloudflared(): Promise<string | undefined> {
  const target = join(getAppPaths().binDir, "cloudflared");
  return await exists(target) ? target : undefined;
}

async function findExecutable(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", `command -v ${name}`]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function runningCloudflaredCount(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", "cloudflared"]);
    return stdout.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function assertSupportedPlatform(): void {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  if (process.platform === "linux" && !getGlibcVersion()) throw new Error("Linux support requires glibc");
}

function getGlibcVersion(): string | undefined {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return report.header?.glibcVersionRuntime;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "computer";
}

function printHelp(): void {
  process.stdout.write(`Pi Daemon ${VERSION}\n\nCommands:\n  setup\n  status\n  doctor\n  logs [sessiond|web|tunnel|all]\n  restart [sessiond|web|tunnel|all]\n  update\n  uninstall [--delete-cloudflare]\n`);
}

void main().catch((error) => {
  process.stderr.write(`pi-daemon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
