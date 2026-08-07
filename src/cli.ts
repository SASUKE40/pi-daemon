#!/usr/bin/env node
import { access, chmod, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import qrcode from "qrcode-terminal";
import {
  CloudflareClient,
  TunnelNameConflictError,
  validateEmail,
  validateHostname,
  type CloudflareAccount,
  type CloudflareZone,
  type ProvisionInput,
  type ProvisionResult,
} from "./cloudflare.js";
import { authorizeCloudflare, cloudflareOAuthConfig } from "./cloudflare-oauth.js";
import { activeRelay, defaultConfig, loadConfig, publicHostname as configuredHostname, saveConfig, type PiDaemonConfig, type RelayKind, type TailscaleConfig } from "./config.js";
import { getAppPaths } from "./paths.js";
import { loadSetupMemo, removeRuntimeConfigPreservingSetupMemo, saveSetupMemo, type SetupMemo } from "./setup-memo.js";
import { currentServiceCommands, installUserServices, restartService, stopAndRemoveUserServices } from "./services.js";
import { TerminalPrompter } from "./terminal.js";
import { detectedTailscaleLogin, hasServeConfiguration, tailscaleHostname, tailscaleServeArgs, tailscaleTarget, validateTailscaleLogin, type TailscaleStatus } from "./tailscale.js";
import { CLOUDFLARED_VERSION, PI_VERSION, VERSION } from "./version.js";

const execFileAsync = promisify(execFile);
const INSTALL_URL = "https://github.com/SASUKE40/pi-daemon/releases/latest/download/install.sh";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

async function main(): Promise<void> {
  const [command = "status", ...args] = process.argv.slice(2);
  switch (command) {
    case "setup": await setup(args.includes("--from-installer")); return;
    case "status": await status(); return;
    case "doctor": await doctor(); return;
    case "logs": await logs((args[0] || "all") as "sessiond" | "web" | "tunnel" | "all"); return;
    case "restart": await restart((args[0] || "all") as "sessiond" | "web" | "tunnel" | "all"); return;
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

async function setup(fromInstaller = false): Promise<void> {
  assertSupportedPlatform();
  const prompt = new TerminalPrompter();
  let releaseCloudflare: (() => Promise<void>) | undefined;
  try {
    prompt.print(`Pi Daemon ${VERSION} setup`);
    prompt.print("This grants the authenticated mobile user access to Pi's coding tools.");
    if (fromInstaller) prompt.print("Account setup is running on this board. Browser links may be opened on another device.");
    const paths = getAppPaths();
    const hasCurrentConfig = await exists(paths.configFile);
    const current = await loadConfig().catch(() => defaultConfig());
    let memo: SetupMemo | undefined;
    try {
      memo = await loadSetupMemo();
      if (memo) prompt.print("Found saved setup choices for reinstall.");
    } catch (error) {
      prompt.print(`Ignoring saved setup choices: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pi = process.env.PI_DAEMON_PI || await findExecutable("pi");
    if (!pi) throw new Error("Pi CLI is missing. Re-run the one-line installer.");

    const defaultCwd = await questionForDirectory(prompt, "Default working directory", hasCurrentConfig ? current.defaultCwd : memo?.defaultCwd || current.defaultCwd);
    const relay = await selectRelay(prompt, current, memo);
    let config: PiDaemonConfig;
    let mobileUrl: string;
    let rememberSetup: boolean;

    if (relay === "cloudflare") {
      if (await exists(paths.tunnelTokenFile) && await prompt.confirm("Has the existing Cloudflare connector token been exposed since it was last rotated", false)) {
        throw new Error("Rotate the exposed connector token in Cloudflare, then run setup again");
      }
      const connection = await connectCloudflare(prompt, memo, current.cloudflare?.accountId, current.cloudflare?.zoneId);
      const { cloudflare, account, zone } = connection;
      releaseCloudflare = connection.release;
      const publicHostname = await questionValidated(prompt, "Public hostname", current.cloudflare?.hostname || memo?.hostname || `pi.${zone.name}`, validateHostname);
      const allowedEmail = await questionValidated(prompt, "Only email allowed by Cloudflare Access", current.cloudflare?.allowedEmail || memo?.allowedEmail, validateEmail);
      prompt.print("Saved reinstall choices do not include the temporary Cloudflare authorization.");
      rememberSetup = await prompt.confirm("Remember these choices for a future setup or reinstall?", true);
      const teamName = `pi-${account.id.slice(0, 8)}`;
      const tunnelName = `pi-daemon-${sanitizeName(hostname())}`;
      prompt.print(`Provisioning protected hostname https://${publicHostname} …`);
      const previous = [current.cloudflare, memo?.cloudflare].find((item) => item?.accountId === account.id && item.zoneId === zone.id);
      const provisionInput: ProvisionInput = {
        accountId: account.id,
        zoneId: zone.id,
        hostname: publicHostname,
        allowedEmail,
        teamName,
        tunnelName,
        localPort: current.port,
        ...(previous ? { previous } : {}),
      };
      let provisioned: ProvisionResult;
      try {
        provisioned = await cloudflare.provision(provisionInput);
      } catch (error) {
        if (!(error instanceof TunnelNameConflictError)) throw error;
        prompt.print(`An existing remotely managed Cloudflare tunnel is named ${error.tunnelName}. This can be left behind by an interrupted setup or an uninstall that kept Cloudflare resources.`);
        if (!await prompt.confirm("Reuse it? Pi Daemon will require matching DNS and an exact-email Access policy.", false)) throw error;
        provisioned = await cloudflare.provision({ ...provisionInput, adoptExisting: true });
      }
      await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
      await writeFile(paths.tunnelTokenFile, `${provisioned.tunnelToken}\n`, { mode: 0o600 });
      await chmod(paths.tunnelTokenFile, 0o600);
      config = { ...current, defaultCwd, relay: "cloudflare", cloudflare: provisioned.config };
      await saveConfig(config);
      const previousTailscale = current.tailscale || memo?.tailscale;
      if (rememberSetup) await saveSetupMemo({
        schemaVersion: 1,
        defaultCwd,
        relay: "cloudflare",
        hostname: publicHostname,
        allowedEmail,
        accountId: account.id,
        zoneId: zone.id,
        cloudflare: provisioned.config,
        ...(previousTailscale ? { tailscale: previousTailscale } : {}),
      });
      const cloudflared = await findCloudflared();
      const connectorCount = await runningCloudflaredCount();
      if (connectorCount > 0) prompt.print(`Detected ${connectorCount} existing cloudflared process(es); they will not be modified.`);
      await installUserServices(config, currentServiceCommands(cloudflared));
      if (activeRelay(current) === "tailscale") await disableTailscaleServe(prompt, current.tailscale);
      prompt.print(`Created or reused: ${provisioned.created.length ? provisioned.created.join(", ") : "all existing managed resources"}`);
      mobileUrl = `https://${publicHostname}`;
    } else {
      const tailscale = await setupTailscaleServe(prompt, current, memo);
      rememberSetup = await prompt.confirm("Remember these choices for a future setup or reinstall?", true);
      config = { ...current, defaultCwd, relay: "tailscale", tailscale };
      await saveConfig(config);
      if (rememberSetup) {
        const previousCloudflare = current.cloudflare || memo?.cloudflare;
        await saveSetupMemo({
          schemaVersion: 1,
          defaultCwd,
          relay: "tailscale",
          tailscale,
          ...(previousCloudflare ? {
            hostname: previousCloudflare.hostname,
            allowedEmail: previousCloudflare.allowedEmail,
            accountId: previousCloudflare.accountId,
            zoneId: previousCloudflare.zoneId,
            cloudflare: previousCloudflare,
          } : {}),
        });
      }
      await installUserServices(config, currentServiceCommands());
      prompt.print(`Configured Tailscale Serve for ${tailscale.allowedLogin}.`);
      mobileUrl = `https://${tailscale.hostname}`;
    }
    if (!rememberSetup) await rm(paths.setupMemoFile, { force: true });
    prompt.print(`Mobile URL: ${mobileUrl}`);
    qrcode.generate(mobileUrl, { small: true }, (code) => prompt.print(code));
    if (await prompt.confirm("Open Pi now for local /login provider setup?", true)) {
      prompt.print("In Pi, run /login, finish provider authentication, then exit Pi.");
      const result = prompt.runInteractive(pi);
      if (result.status !== 0) throw new Error("Pi provider setup did not exit cleanly");
    }
    prompt.print(rememberSetup
      ? `Setup complete. Reinstall choices were saved to ${paths.setupMemoFile}.`
      : "Setup complete. Relay authorization was not retained.");
  } finally {
    if (releaseCloudflare) await releaseCloudflare().catch((error) => prompt.print(`Warning: could not revoke temporary Cloudflare authorization: ${error instanceof Error ? error.message : String(error)}`));
    prompt.close();
  }
}

async function status(): Promise<void> {
  const config = await loadConfig();
  const hostname = configuredHostname(config);
  const result: Record<string, unknown> = {
    version: VERSION,
    relay: activeRelay(config),
    configured: Boolean(hostname),
    url: hostname ? `https://${hostname}` : undefined,
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
  let config: PiDaemonConfig | undefined;
  try {
    config = await loadConfig();
    checks.push({ name: "Configuration", ok: true, detail: configuredHostname(config) || "local only" });
  } catch (error) {
    checks.push({ name: "Configuration", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const nodeMajorMinor = process.versions.node.split(".").slice(0, 2).map(Number);
  checks.push({ name: "Node.js", ok: (nodeMajorMinor[0] || 0) > 22 || nodeMajorMinor[0] === 22 && (nodeMajorMinor[1] || 0) >= 19, detail: process.version });
  checks.push({ name: "Platform", ok: ["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch), detail: `${process.platform}/${process.arch}` });
  const pi = await findExecutable("pi");
  const piVersion = pi ? await execFileAsync(pi, ["--version"]).then(({ stdout }) => stdout.trim()).catch(() => "unknown") : "missing";
  checks.push({ name: "Pi", ok: Boolean(pi) && piVersion.includes(PI_VERSION), detail: pi ? `${pi} (${piVersion})` : `required ${PI_VERSION}` });
  if (config && activeRelay(config) === "cloudflare") {
    const cloudflared = await findExecutable("cloudflared") || await localCloudflared();
    checks.push({ name: "cloudflared", ok: Boolean(cloudflared), detail: cloudflared || `required ${CLOUDFLARED_VERSION}` });
  }
  if (config && activeRelay(config) === "tailscale") {
    const tailscale = await findTailscale();
    const backend = tailscale ? await tailscaleStatus(tailscale).then((item) => item.BackendState || "unknown").catch(() => "unavailable") : "missing";
    checks.push({ name: "Tailscale", ok: Boolean(tailscale) && backend === "Running", detail: tailscale ? `${tailscale} (${backend})` : "missing" });
    if (tailscale && config.tailscale) {
      const target = tailscaleTarget(config.tailscale);
      const serve = await execFileAsync(tailscale, ["serve", "status", "--json"]).then(({ stdout }) => stdout.trim()).catch(() => "");
      checks.push({ name: "Tailscale Serve", ok: hasServeConfiguration(serve) && serve.includes(target), detail: serve.includes(target) ? target : "Pi Daemon route is not active" });
    }
  }
  if (process.platform === "linux") {
    const glibc = getGlibcVersion();
    checks.push({ name: "glibc", ok: Boolean(glibc), detail: glibc || "not detected" });
  }
  for (const check of checks) process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}\n`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function logs(target: "sessiond" | "web" | "tunnel" | "all"): Promise<void> {
  const config = await loadConfig();
  const tailscale = activeRelay(config) === "tailscale";
  if (tailscale && (target === "tunnel" || target === "all")) {
    const binary = await findTailscale();
    if (!binary) throw new Error("Tailscale is missing");
    const result = spawnSync(binary, ["serve", "status"], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Unable to read Tailscale Serve status");
    if (target === "tunnel") return;
  }
  if (process.platform === "linux") {
    const names = target === "all" ? ["sessiond", "web", ...(tailscale ? [] : ["cloudflared"])] : [target === "tunnel" ? "cloudflared" : target];
    spawnSync("journalctl", ["--user", "-n", "200", "-f", ...names.flatMap((name) => ["-u", `pi-daemon-${name}.service`])], { stdio: "inherit" });
    return;
  }
  const paths = getAppPaths();
  const names = target === "all" ? ["sessiond", "web", ...(tailscale ? [] : ["cloudflared"])] : [target === "tunnel" ? "cloudflared" : target];
  spawnSync("tail", ["-n", "200", "-f", ...names.map((name) => join(paths.logDir, `${name}.log`))], { stdio: "inherit" });
}

async function restart(target: "sessiond" | "web" | "tunnel" | "all"): Promise<void> {
  const config = await loadConfig();
  if (activeRelay(config) !== "tailscale") {
    await restartService(target);
    return;
  }
  if (target === "tunnel" || target === "all") {
    const tailscale = await findTailscale();
    if (!tailscale || !config.tailscale) throw new Error("Tailscale relay configuration is unavailable");
    const result = spawnSync(tailscale, tailscaleServeArgs(config.tailscale), { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Tailscale Serve restart failed");
  }
  await restartService(target, false);
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
  let releaseCloudflare: (() => Promise<void>) | undefined;
  try {
    if (!await prompt.confirm("Stop and remove Pi Daemon services and local daemon data?", false)) return;
    await stopAndRemoveUserServices();
    if (config && activeRelay(config) === "tailscale") await disableTailscaleServe(prompt, config.tailscale);
    if (deleteCloudflare && config?.cloudflare) {
      prompt.print(`Cloudflare resources for ${config.cloudflare.hostname} will be deleted: tunnel ${config.cloudflare.tunnelId}, Access app ${config.cloudflare.accessAppId}, and its matching CNAME.`);
      if (!await prompt.confirm("Delete those exact Cloudflare resources?", false)) throw new Error("Cloudflare deletion cancelled");
      const connection = await connectCloudflare(prompt, undefined, config.cloudflare.accountId, config.cloudflare.zoneId);
      releaseCloudflare = connection.release;
      if (connection.account.id !== config.cloudflare.accountId || connection.zone.id !== config.cloudflare.zoneId) throw new Error("Select the Cloudflare account and zone that own the configured Pi Daemon resources");
      await connection.cloudflare.deleteManaged(config.cloudflare);
    }
    const paths = getAppPaths();
    const preserveSetupMemo = await exists(paths.setupMemoFile)
      && !await prompt.confirm("Forget saved reinstall choices?", false);
    const launcherDir = join(homedir(), ".local", "bin");
    await rm(join(launcherDir, "pi-daemon"), { force: true });
    const piLauncher = join(launcherDir, "pi");
    const piLauncherContent = await readFile(piLauncher, "utf8").catch(() => "");
    if (piLauncherContent.includes(paths.dataDir)) await rm(piLauncher, { force: true });
    if (preserveSetupMemo) await removeRuntimeConfigPreservingSetupMemo();
    else await rm(paths.configDir, { recursive: true, force: true });
    await rm(paths.dataDir, { recursive: true, force: true });
    prompt.print(preserveSetupMemo
      ? `Pi Daemon removed. ~/.pi/agent and reinstall choices in ${paths.setupMemoFile} were preserved.`
      : "Pi Daemon removed. ~/.pi/agent authentication and sessions were preserved.");
  } finally {
    if (releaseCloudflare) await releaseCloudflare().catch((error) => prompt.print(`Warning: could not revoke temporary Cloudflare authorization: ${error instanceof Error ? error.message : String(error)}`));
    prompt.close();
  }
}

async function selectRelay(prompt: TerminalPrompter, current: PiDaemonConfig, memo?: SetupMemo): Promise<RelayKind> {
  const tailscale = await findTailscale();
  const preferred = activeRelay(current) || memo?.relay || "cloudflare";
  prompt.print("\nRemote access");
  prompt.print("1. Cloudflare Tunnel — public hostname protected by Cloudflare Access");
  prompt.print(`2. Tailscale Serve — private to your tailnet, no API token${tailscale ? "" : " (Tailscale not found)"}`);
  while (true) {
    const selected = await prompt.question("Relay number", preferred === "cloudflare" ? "1" : "2");
    if (selected === "1") return "cloudflare";
    if (selected === "2") {
      if (!tailscale) throw new Error("Install and sign in to Tailscale first: https://tailscale.com/download");
      return "tailscale";
    }
    prompt.print("Enter 1 or 2.");
  }
}

async function setupTailscaleServe(prompt: TerminalPrompter, current: PiDaemonConfig, memo?: SetupMemo): Promise<TailscaleConfig> {
  const tailscale = await findTailscale();
  if (!tailscale) throw new Error("Install and sign in to Tailscale first: https://tailscale.com/download");
  const status = await tailscaleStatus(tailscale).catch((error) => {
    throw new Error(`Unable to read Tailscale status: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (status.BackendState !== "Running") throw new Error(`Tailscale is not connected (${status.BackendState || "unknown state"}). Sign in with Tailscale, then run setup again.`);
  const hostname = tailscaleHostname(status);
  const detectedLogin = detectedTailscaleLogin(status);
  const preferredLogin = current.tailscale?.allowedLogin || memo?.tailscale?.allowedLogin || detectedLogin;
  const allowedLogin = await questionValidated(prompt, "Only Tailscale login allowed", preferredLogin, validateTailscaleLogin);
  const next: TailscaleConfig = { hostname, allowedLogin: allowedLogin.toLowerCase(), httpsPort: 443, localPort: current.port };
  const target = tailscaleTarget(next);
  const existingServe = await execFileAsync(tailscale, ["serve", "status", "--json"]).then(({ stdout }) => stdout.trim()).catch(() => "");
  const existingFunnel = await execFileAsync(tailscale, ["funnel", "status", "--json"]).then(({ stdout }) => stdout.trim()).catch(() => "");
  const differentServe = hasServeConfiguration(existingServe) && !existingServe.includes(target);
  const hasFunnel = hasServeConfiguration(existingFunnel);
  if (differentServe || hasFunnel) {
    if (differentServe) prompt.print(`This device already has a different Tailscale Serve configuration:\n${existingServe}`);
    if (hasFunnel) prompt.print(`This device already has Tailscale Funnel configuration:\n${existingFunnel}`);
    if (!await prompt.confirm("Continue and configure Pi Daemon as the private root HTTPS port 443 route?", false)) throw new Error("Tailscale Serve setup cancelled");
  }
  prompt.print(`Configuring private tailnet URL https://${hostname} …`);
  const result = prompt.runInteractive(tailscale, tailscaleServeArgs(next));
  if (result.status !== 0) throw new Error("Tailscale Serve setup failed");
  return next;
}

async function disableTailscaleServe(prompt: TerminalPrompter, config?: TailscaleConfig): Promise<void> {
  if (!config) return;
  const tailscale = await findTailscale();
  if (!tailscale) {
    prompt.print(`Warning: Tailscale is missing; disable the old route manually with: tailscale serve --https=${config.httpsPort} off`);
    return;
  }
  await execFileAsync(tailscale, ["serve", `--https=${config.httpsPort}`, "off"])
    .catch((error) => prompt.print(`Warning: could not disable Tailscale Serve: ${error instanceof Error ? error.message : String(error)}`));
}

async function findTailscale(): Promise<string | undefined> {
  return process.env.PI_DAEMON_TAILSCALE || await findExecutable("tailscale");
}

async function tailscaleStatus(tailscale: string): Promise<TailscaleStatus> {
  const { stdout } = await execFileAsync(tailscale, ["status", "--json"]);
  return JSON.parse(stdout) as TailscaleStatus;
}

async function selectAccount(accounts: CloudflareAccount[], prompt: TerminalPrompter, preferredId?: string): Promise<CloudflareAccount> {
  if (!accounts.length) throw new Error("No Cloudflare accounts visible to this token");
  if (accounts.length === 1) {
    const account = accounts[0] as CloudflareAccount;
    prompt.print(`Account: ${account.name}`);
    return account;
  }
  prompt.print(accounts.map((item, index) => `${index + 1}. ${item.name} (${item.id})`).join("\n"));
  const preferredIndex = accounts.findIndex((item) => item.id === preferredId);
  while (true) {
    const selected = Number(await prompt.question("Account number", String(preferredIndex >= 0 ? preferredIndex + 1 : 1))) - 1;
    if (accounts[selected]) return accounts[selected] as CloudflareAccount;
    prompt.print(`Enter a number from 1 to ${accounts.length}.`);
  }
}

async function selectZone(zones: CloudflareZone[], prompt: TerminalPrompter, preferredId?: string): Promise<CloudflareZone> {
  if (!zones.length) throw new Error("No DNS zones visible to this token");
  if (zones.length === 1) {
    const zone = zones[0] as CloudflareZone;
    prompt.print(`DNS zone: ${zone.name}`);
    return zone;
  }
  prompt.print(zones.map((item, index) => `${index + 1}. ${item.name} (${item.id})`).join("\n"));
  const preferredIndex = zones.findIndex((item) => item.id === preferredId);
  while (true) {
    const selected = Number(await prompt.question("Zone number", String(preferredIndex >= 0 ? preferredIndex + 1 : 1))) - 1;
    if (zones[selected]) return zones[selected] as CloudflareZone;
    prompt.print(`Enter a number from 1 to ${zones.length}.`);
  }
}

function printCloudflareTokenInstructions(prompt: TerminalPrompter): void {
  prompt.print("\nCloudflare login");
  prompt.print("Use a scoped API token. cloudflared's browser login cannot configure the Access app and exact-email policy.");
  prompt.print("Create a Custom Token here:");
  prompt.print(CLOUDFLARE_TOKEN_URL);
  prompt.print("Permissions (Cloudflare may label Edit as Write):");
  prompt.print("  Account · Account Settings · Read");
  prompt.print("  Account · Cloudflare Tunnel · Edit");
  prompt.print("  Account · Access: Apps and Policies · Edit");
  prompt.print("  Account · Access: Organizations, Identity Providers, and Groups · Edit");
  prompt.print("  Zone    · Zone · Read");
  prompt.print("  Zone    · DNS · Edit");
  prompt.print("Scope Account Resources to the account and Zone Resources to the DNS zone you want to use.");
}

interface CloudflareConnection {
  cloudflare: CloudflareClient;
  account: CloudflareAccount;
  zone: CloudflareZone;
  release?: () => Promise<void>;
}

async function connectCloudflare(
  prompt: TerminalPrompter,
  memo?: SetupMemo,
  preferredAccountId = memo?.accountId,
  preferredZoneId = memo?.zoneId,
): Promise<CloudflareConnection> {
  const oauth = cloudflareOAuthConfig();
  if (oauth) {
    try {
      prompt.print("\nCloudflare login");
      prompt.print("Authorize Pi Daemon in a browser. The temporary authorization is discarded after setup.");
      const session = await authorizeCloudflare(oauth, {
        onAuthorizationUrl(url) {
          prompt.print(`Open this link on any device:\n${url}`);
          qrcode.generate(url, { small: true }, (code) => prompt.print(code));
          prompt.print("Waiting for Cloudflare authorization…");
        },
      });
      try {
        const cloudflare = new CloudflareClient(session.accessToken);
        const account = await selectAccount(await cloudflare.accounts(), prompt, preferredAccountId);
        const zone = await selectZone(await cloudflare.zones(account.id), prompt, preferredZoneId);
        await cloudflare.checkSetupAccess(account.id, zone.id);
        prompt.print(`Cloudflare connected for ${account.name} / ${zone.name}.`);
        return { cloudflare, account, zone, release: session.revoke };
      } catch (error) {
        await session.revoke().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      prompt.print(`Could not authorize Cloudflare: ${error instanceof Error ? error.message : String(error)}`);
      if (!await prompt.confirm("Use a manually created API token instead?", false)) throw new Error("Cloudflare setup cancelled");
    }
  }
  return connectCloudflareWithToken(prompt, memo, preferredAccountId, preferredZoneId);
}

async function connectCloudflareWithToken(
  prompt: TerminalPrompter,
  memo?: SetupMemo,
  preferredAccountId = memo?.accountId,
  preferredZoneId = memo?.zoneId,
): Promise<CloudflareConnection> {
  let apiToken: string | undefined;
  if (memo?.cloudflareApiToken && await prompt.confirm("Use the legacy saved Cloudflare API token?", true)) apiToken = memo.cloudflareApiToken;
  if (!apiToken) printCloudflareTokenInstructions(prompt);
  while (true) {
    apiToken ||= await prompt.secret("Paste Cloudflare API token (input hidden)");
    try {
      const cloudflare = new CloudflareClient(apiToken);
      prompt.print("Checking token and permissions…");
      await cloudflare.verify();
      const account = await selectAccount(await cloudflare.accounts(), prompt, preferredAccountId);
      const zone = await selectZone(await cloudflare.zones(account.id), prompt, preferredZoneId);
      await cloudflare.checkSetupAccess(account.id, zone.id);
      prompt.print(`Cloudflare token accepted for ${account.name} / ${zone.name}.`);
      return { cloudflare, account, zone };
    } catch (error) {
      prompt.print(`Could not use that token: ${error instanceof Error ? error.message : String(error)}`);
      if (!await prompt.confirm("Try Cloudflare login again?", true)) throw new Error("Cloudflare setup cancelled");
      apiToken = undefined;
      printCloudflareTokenInstructions(prompt);
    }
  }
}

async function questionForDirectory(prompt: TerminalPrompter, label: string, defaultValue: string): Promise<string> {
  while (true) {
    const value = await prompt.question(label, defaultValue);
    try {
      if ((await stat(value)).isDirectory()) return value;
    } catch {
      // The same concise validation message applies to missing and inaccessible paths.
    }
    prompt.print("Enter an existing directory.");
  }
}

async function questionValidated(prompt: TerminalPrompter, label: string, defaultValue: string | undefined, validate: (value: string) => void): Promise<string> {
  while (true) {
    const value = await prompt.question(label, defaultValue);
    try {
      validate(value);
      return value;
    } catch (error) {
      prompt.print(error instanceof Error ? error.message : String(error));
    }
  }
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
