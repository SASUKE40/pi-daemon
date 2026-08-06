import { describe, expect, it, vi } from "vitest";
import { renderLaunchAgents, renderSystemdServices, type ServiceCommands } from "../src/services.js";

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
  macAppExecutable: "/Users/test/Applications/Pi Daemon.app/Contents/MacOS/Pi Daemon",
};

describe("service renderers", () => {
  it("never places a tunnel token in systemd argv", () => {
    const units = renderSystemdServices(commands);
    expect(units["pi-daemon-cloudflared.service"]).toContain("--token-file");
    expect(units["pi-daemon-cloudflared.service"]).not.toMatch(/eyJ/);
  });

  it("uses the stable signed app as the macOS host", () => {
    const plists = renderLaunchAgents(commands);
    expect(plists["com.edward40.pi-daemon.sessiond.plist"]).toContain("Pi Daemon.app/Contents/MacOS/Pi Daemon");
    expect(plists["com.edward40.pi-daemon.cloudflared.plist"]).toContain("--token-file");
  });
});
