import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAppPaths } from "../src/paths.js";

describe("getAppPaths", () => {
  it("uses HOME from the provided environment", () => {
    const paths = getAppPaths({ HOME: "/users/test" });

    expect(paths.configDir).toBe(join("/users/test", ".config", "pi-daemon"));
    expect(paths.dataDir).toBe(join("/users/test", ".local", "share", "pi-daemon"));
    expect(paths.binDir).toBe(join(paths.dataDir, "bin"));
  });

  it("gives XDG directories precedence over HOME", () => {
    const paths = getAppPaths({
      HOME: "/users/test",
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_RUNTIME_DIR: "/xdg/run",
      XDG_STATE_HOME: "/xdg/state",
    });

    expect(paths.configDir).toBe(join("/xdg/config", "pi-daemon"));
    expect(paths.dataDir).toBe(join("/xdg/data", "pi-daemon"));
    expect(paths.runtimeDir).toBe(join("/xdg/run", "pi-daemon"));
    expect(paths.logDir).toBe(process.platform === "darwin"
      ? join("/users/test", "Library", "Logs", "pi-daemon")
      : join("/xdg/state", "pi-daemon", "logs"));
  });

  it("gives Pi Daemon directory and socket overrides precedence over XDG", () => {
    const paths = getAppPaths({
      HOME: "/users/test",
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_RUNTIME_DIR: "/xdg/run",
      PI_DAEMON_CONFIG_DIR: "/daemon/config",
      PI_DAEMON_DATA_DIR: "/daemon/data",
      PI_DAEMON_SOCKET: "/daemon/socket",
    });

    expect(paths.configDir).toBe("/daemon/config");
    expect(paths.dataDir).toBe("/daemon/data");
    expect(paths.socketPath).toBe("/daemon/socket");
    expect(paths.pushVapidFile).toBe(join("/daemon/data", "web-push-vapid.json"));
    expect(paths.pushSubscriptionsDir).toBe(join("/daemon/data", "web-push-subscriptions"));
  });

  it("uses PI_DAEMON_HOME before HOME for derived directories", () => {
    const paths = getAppPaths({ HOME: "/users/test", PI_DAEMON_HOME: "/daemon/home" });

    expect(paths.configDir).toBe(join("/daemon/home", ".config", "pi-daemon"));
    expect(paths.dataDir).toBe(join("/daemon/home", ".local", "share", "pi-daemon"));
  });
});
