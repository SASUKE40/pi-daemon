import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface AppPaths {
  configDir: string;
  configFile: string;
  setupMemoFile: string;
  dataDir: string;
  runtimeDir: string;
  socketPath: string;
  attachmentDir: string;
  binDir: string;
  logDir: string;
  tunnelTokenFile: string;
  pushVapidFile: string;
  pushSubscriptionsDir: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const userHome = env.PI_DAEMON_HOME || homedir();
  const configDir = env.PI_DAEMON_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "pi-daemon");
  const dataDir = env.PI_DAEMON_DATA_DIR || join(env.XDG_DATA_HOME || join(userHome, ".local", "share"), "pi-daemon");
  const runtimeBase = env.XDG_RUNTIME_DIR || join(dataDir, "run");
  const runtimeDir = join(runtimeBase, "pi-daemon");
  const logDir = process.platform === "darwin"
    ? join(userHome, "Library", "Logs", "pi-daemon")
    : join(env.XDG_STATE_HOME || join(userHome, ".local", "state"), "pi-daemon", "logs");
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    setupMemoFile: join(configDir, "setup-memo.json"),
    dataDir,
    runtimeDir,
    socketPath: env.PI_DAEMON_SOCKET || join(runtimeDir, "sessiond.sock"),
    attachmentDir: join(runtimeDir, "attachments"),
    binDir: join(dataDir, "bin"),
    logDir,
    tunnelTokenFile: join(configDir, "tunnel-token"),
    pushVapidFile: join(dataDir, "web-push-vapid.json"),
    pushSubscriptionsDir: join(dataDir, "web-push-subscriptions"),
  };
}

export function safeSocketFallback(): string {
  return join(tmpdir(), `pi-daemon-${process.getuid?.() ?? "user"}.sock`);
}
