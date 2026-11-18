import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import type { PiDaemonConfig } from "../src/config.js";
import {
  installUserServices,
  renderLaunchAgents,
  renderSystemdServices,
  servicesManagedExternally,
  stopAndRemoveUserServices,
  type ServiceCommands,
} from "../src/services.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file: string, _args: string[], callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    callback(null, { stdout: "", stderr: "" });
  }),
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("../src/paths.js", () => ({
  getAppPaths: () => ({
    configDir: "/home/test/.config/pi-daemon",
    configFile: "/home/test/.config/pi-daemon/config.json",
    dataDir: "/home/test/.local/share/pi-daemon",
    runtimeDir: "/run/user/1/pi-daemon",
    socketPath: "/run/user/1/pi-daemon/sessiond.sock",
    attachmentDir: "/run/user/1/pi-daemon/attachments",
    binDir: "/home/test/.local/share/pi-daemon/bin",
    logDir: "/home/test/logs",
    tunnelTokenFile: "/home/test/.config/pi-daemon/tunnel-token",
  }),
}));

const commands: ServiceCommands = {
  node: "/usr/bin/node",
  sessiondScript: "/app/sessiond.js",
  webScript: "/app/web.js",
  cloudflared: "/app/cloudflared",
};

describe("service renderers", () => {
  it("places service ordering dependencies in the systemd Unit section", () => {
    const units = renderSystemdServices(commands);
    const web = splitSystemdSections(units["pi-daemon-web.service"] as string);
    const cloudflared = splitSystemdSections(units["pi-daemon-cloudflared.service"] as string);

    expect(web.unit).toContain("After=graphical-session.target pi-daemon-sessiond.service");
    expect(cloudflared.unit).toContain("After=graphical-session.target pi-daemon-web.service network-online.target");
    expect(web.service).not.toMatch(/^After=/mu);
    expect(cloudflared.service).not.toMatch(/^After=/mu);
  });

  it("never places a tunnel token in systemd argv", () => {
    const units = renderSystemdServices(commands);
    expect(units["pi-daemon-cloudflared.service"]).toContain("--token-file");
    expect(units["pi-daemon-cloudflared.service"]).not.toMatch(/eyJ/);
  });

  it("runs the session daemon directly with Node on macOS", () => {
    const plists = renderLaunchAgents(commands);
    expect(plists["com.edward40.pi-daemon.sessiond.plist"]).toContain("<string>/usr/bin/node</string>");
    expect(plists["com.edward40.pi-daemon.sessiond.plist"]).toContain("<string>/app/sessiond.js</string>");
    expect(plists["com.edward40.pi-daemon.cloudflared.plist"]).toContain("--token-file");
  });

  it("omits cloudflared services for Tailscale Serve", () => {
    const { cloudflared: _cloudflared, ...tailscaleCommands } = commands;
    expect(Object.keys(renderSystemdServices(tailscaleCommands))).toEqual([
      "pi-daemon-sessiond.service",
      "pi-daemon-web.service",
    ]);
    expect(Object.keys(renderLaunchAgents(tailscaleCommands))).toEqual([
      "com.edward40.pi-daemon.sessiond.plist",
      "com.edward40.pi-daemon.web.plist",
    ]);
  });

  it("escapes special characters in systemd commands and launchd XML", () => {
    const special: ServiceCommands = {
      node: '/opt/Node & Tools/100%/node "stable"',
      sessiondScript: "/app/session\\daemon.js",
      webScript: "/app/<web>.js",
    };

    const systemd = renderSystemdServices(special)["pi-daemon-sessiond.service"] as string;
    expect(systemd).toContain('ExecStart="/opt/Node & Tools/100%%/node \\"stable\\"" "/app/session\\\\daemon.js"');

    const launchd = renderLaunchAgents(special)["com.edward40.pi-daemon.web.plist"] as string;
    expect(launchd).toContain("<string>/opt/Node &amp; Tools/100%/node &quot;stable&quot;</string>");
    expect(launchd).toContain("<string>/app/&lt;web&gt;.js</string>");
  });

  it("requires a cloudflared command when the relay is explicitly included", () => {
    const withoutCloudflared: ServiceCommands = {
      node: commands.node,
      sessiondScript: commands.sessiondScript,
      webScript: commands.webScript,
    };

    expect(() => renderSystemdServices(withoutCloudflared, true)).toThrow("cloudflared command is required");
    expect(() => renderLaunchAgents(withoutCloudflared, true)).toThrow("cloudflared command is required");
  });
});

describe("Nix-managed services", () => {
  const execFileMock = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;
  const originalPlatform = process.platform;
  const tailscaleConfig = { relay: "tailscale" } as PiDaemonConfig;
  const cloudflareConfig = { relay: "cloudflare" } as PiDaemonConfig;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  function commandsRun(): string[] {
    return execFileMock.mock.calls.map(([file, args]) => [file, ...(args as string[])].join(" "));
  }

  beforeEach(() => {
    vi.stubEnv("PI_DAEMON_MANAGED_SERVICES", "1");
    execFileMock.mockClear();
    vi.mocked(writeFile).mockClear();
    vi.mocked(rm).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setPlatform(originalPlatform);
  });

  it("is enabled only by the Home Manager marker", () => {
    expect(servicesManagedExternally({ PI_DAEMON_MANAGED_SERVICES: "1" })).toBe(true);
    expect(servicesManagedExternally({ PI_DAEMON_MANAGED_SERVICES: "0" })).toBe(false);
    expect(servicesManagedExternally({})).toBe(false);
  });

  it("restarts the declared systemd units without rewriting them", async () => {
    setPlatform("linux");
    await installUserServices(tailscaleConfig, commands);
    expect(commandsRun()).toEqual(["systemctl --user restart pi-daemon-sessiond.service pi-daemon-web.service"]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("restarts the declared cloudflared unit for the Cloudflare relay", async () => {
    setPlatform("linux");
    await installUserServices(cloudflareConfig, commands);
    expect(commandsRun()).toEqual(["systemctl --user restart pi-daemon-sessiond.service pi-daemon-web.service pi-daemon-cloudflared.service"]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("explains how to declare cloudflared when its unit is missing", async () => {
    setPlatform("linux");
    execFileMock.mockImplementationOnce((_file: string, _args: string[], callback: (error: Error) => void) => {
      callback(new Error("Unit pi-daemon-cloudflared.service not found."));
    });
    await expect(installUserServices(cloudflareConfig, commands)).rejects.toThrow("services.pi-daemon.cloudflared.enable = true");
  });

  it("kickstarts the declared launch agents on macOS", async () => {
    setPlatform("darwin");
    await installUserServices(tailscaleConfig, commands);
    const domain = `gui/${process.getuid?.() ?? 0}`;
    expect(commandsRun()).toEqual([
      `launchctl kickstart -k ${domain}/com.edward40.pi-daemon.sessiond`,
      `launchctl kickstart -k ${domain}/com.edward40.pi-daemon.web`,
    ]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("stops but never deletes the declared units on uninstall", async () => {
    setPlatform("linux");
    await stopAndRemoveUserServices();
    expect(commandsRun()).toEqual(["systemctl --user stop pi-daemon-sessiond.service pi-daemon-web.service pi-daemon-cloudflared.service"]);
    expect(rm).not.toHaveBeenCalled();
  });
});

function splitSystemdSections(unit: string): { unit: string; service: string } {
  const [unitSection, remainder] = unit.split("\n[Service]\n");
  if (unitSection === undefined || remainder === undefined) throw new Error("Expected Unit and Service sections");
  return { unit: unitSection, service: remainder.split("\n[Install]\n")[0] as string };
}
