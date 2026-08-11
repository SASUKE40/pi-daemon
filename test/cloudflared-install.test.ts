import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflaredAsset, installCloudflared } from "../src/cloudflared-install.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cloudflared installation", () => {
  it("maps every supported platform to its release asset", () => {
    expect(cloudflaredAsset("darwin", "arm64")).toBe("cloudflared-darwin-arm64.tgz");
    expect(cloudflaredAsset("darwin", "x64")).toBe("cloudflared-darwin-amd64.tgz");
    expect(cloudflaredAsset("linux", "arm64")).toBe("cloudflared-linux-arm64");
    expect(cloudflaredAsset("linux", "x64")).toBe("cloudflared-linux-amd64");
    expect(() => cloudflaredAsset("win32", "x64")).toThrow("Unsupported platform");
  });

  it("downloads, verifies, and installs the selected Linux binary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-daemon-cloudflared-test-"));
    temporaryDirectories.push(directory);
    const binary = new TextEncoder().encode("cloudflared-test-binary");
    const digest = createHash("sha256").update(binary).digest("hex");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith("/SHA256SUMS")
        ? new Response(`${digest}  cloudflared-linux-arm64\n`)
        : new Response(binary);
    });

    const installed = await installCloudflared({
      platform: "linux",
      arch: "arm64",
      binDir: directory,
      releaseBase: "https://release.test/v1",
      fetch: fetchMock,
    });

    expect(installed).toBe(join(directory, "cloudflared"));
    expect(await readFile(installed)).toEqual(Buffer.from(binary));
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an asset that does not match the published checksum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-daemon-cloudflared-test-"));
    temporaryDirectories.push(directory);
    const fetchMock = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/SHA256SUMS")
      ? new Response(`${"0".repeat(64)}  cloudflared-linux-amd64\n`)
      : new Response("tampered"));

    await expect(installCloudflared({
      platform: "linux",
      arch: "x64",
      binDir: directory,
      releaseBase: "https://release.test/v1",
      fetch: fetchMock,
    })).rejects.toThrow("Checksum verification failed");
  });
});
