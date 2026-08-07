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
  cloudflare: {
    accountId: "account-id",
    zoneId: "zone-id",
    tunnelId: "tunnel-id",
    accessAppId: "app-id",
    audience: "aud-id",
    teamDomain: "pi-team.cloudflareaccess.com",
    hostname: "pi.example.com",
    allowedEmail: "only@example.com",
  },
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
    expect(await readFile(setupMemoFile, "utf8")).not.toContain("cloudflareApiToken");
  });

  it("does not reuse a token from a file readable by other users", async () => {
    await saveSetupMemo(memo);
    await chmod(getAppPaths().setupMemoFile, 0o644);

    await expect(loadSetupMemo()).rejects.toThrow("permissions must be 0600");
  });

  it("returns no memo before a user opts in", async () => {
    await expect(loadSetupMemo()).resolves.toBeUndefined();
  });

  it("accepts older memos without managed Cloudflare resource ids", async () => {
    const { cloudflare: _cloudflare, ...olderMemo } = memo;
    const { configDir, setupMemoFile } = getAppPaths();
    await mkdir(configDir, { recursive: true });
    await writeFile(setupMemoFile, JSON.stringify(olderMemo), { mode: 0o600 });

    await expect(loadSetupMemo()).resolves.toEqual(olderMemo);
  });

  it("accepts and migrates a legacy memo containing an API token", async () => {
    const legacyMemo = { ...memo, cloudflareApiToken: "legacy-api-token" };
    const { configDir, setupMemoFile } = getAppPaths();
    await mkdir(configDir, { recursive: true });
    await writeFile(setupMemoFile, JSON.stringify(legacyMemo), { mode: 0o600 });

    await expect(loadSetupMemo()).resolves.toEqual(legacyMemo);
  });

  it("saves GitHub organization access without OAuth credentials", async () => {
    const githubMemo: SetupMemo = {
      schemaVersion: 1,
      defaultCwd: "/work/project",
      relay: "cloudflare",
      cloudflare: {
        accountId: "account-id",
        zoneId: "zone-id",
        tunnelId: "tunnel-id",
        accessAppId: "app-id",
        audience: "aud-id",
        teamDomain: "pi-team.cloudflareaccess.com",
        hostname: "pi.example.com",
        access: {
          type: "github",
          identityProviderId: "github-id",
          identityProviderName: "GitHub",
          organization: "SASUKE40",
        },
      },
    };

    await saveSetupMemo(githubMemo);

    expect(await loadSetupMemo()).toEqual(githubMemo);
    expect(await readFile(getAppPaths().setupMemoFile, "utf8")).not.toMatch(/clientSecret|client_secret|credential/i);
  });

  it("saves Tailscale Serve choices without a credential", async () => {
    const tailscaleMemo: SetupMemo = {
      schemaVersion: 1,
      defaultCwd: "/work/project",
      relay: "tailscale",
      tailscale: {
        hostname: "pi-device.tail1234.ts.net",
        allowedLogin: "me@example.com",
        httpsPort: 443,
        localPort: 8504,
      },
    };

    await saveSetupMemo(tailscaleMemo);

    expect(await loadSetupMemo()).toEqual(tailscaleMemo);
    expect(await readFile(getAppPaths().setupMemoFile, "utf8")).not.toMatch(/token|credential/i);
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
