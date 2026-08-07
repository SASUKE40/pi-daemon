import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppPaths } from "../src/paths.js";
import { loadSetupMemo, removeRuntimeConfigPreservingSetupMemo, saveSetupMemo, type SetupMemo } from "../src/setup-memo.js";

const memo: SetupMemo = {
  schemaVersion: 1,
  defaultCwd: "/work/project",
  hostname: "pi.example.com",
  allowedEmail: "only@example.com",
  accountId: "account-id",
  zoneId: "zone-id",
  cloudflareApiToken: "api-token-secret",
};

describe("setup memo", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-memo-"));
    vi.stubEnv("PI_DAEMON_CONFIG_DIR", join(root, "config"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("atomically saves reinstall choices in an owner-only file", async () => {
    await saveSetupMemo(memo);

    const { setupMemoFile } = getAppPaths();
    expect(await loadSetupMemo()).toEqual(memo);
    expect((await stat(setupMemoFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(setupMemoFile, "utf8")).toContain('"cloudflareApiToken": "api-token-secret"');
  });

  it("does not reuse a token from a file readable by other users", async () => {
    await saveSetupMemo(memo);
    await chmod(getAppPaths().setupMemoFile, 0o644);

    await expect(loadSetupMemo()).rejects.toThrow("permissions must be 0600");
  });

  it("returns no memo before a user opts in", async () => {
    await expect(loadSetupMemo()).resolves.toBeUndefined();
  });

  it("preserves only the opted-in memo during uninstall cleanup", async () => {
    await saveSetupMemo(memo);
    const paths = getAppPaths();
    await writeFile(paths.configFile, "runtime config");
    await writeFile(paths.tunnelTokenFile, "connector token");
    await mkdir(join(paths.configDir, "nested"));
    await writeFile(join(paths.configDir, "nested", "runtime file"), "runtime data");

    await removeRuntimeConfigPreservingSetupMemo();

    expect(await loadSetupMemo()).toEqual(memo);
    await expect(readFile(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.tunnelTokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(paths.configDir, "nested", "runtime file"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
