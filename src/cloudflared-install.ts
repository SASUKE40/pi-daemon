import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getAppPaths } from "./paths.js";
import { CLOUDFLARED_VERSION, VERSION } from "./version.js";

const execFileAsync = promisify(execFile);
const RELEASE_BASE = `https://github.com/SASUKE40/pi-daemon/releases/download/v${VERSION}`;

export interface CloudflaredInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  binDir?: string;
  releaseBase?: string;
  fetch?: typeof fetch;
}

export function cloudflaredAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === "darwin" && arch === "arm64") return "cloudflared-darwin-arm64.tgz";
  if (platform === "darwin" && arch === "x64") return "cloudflared-darwin-amd64.tgz";
  if (platform === "linux" && arch === "arm64") return "cloudflared-linux-arm64";
  if (platform === "linux" && arch === "x64") return "cloudflared-linux-amd64";
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

export async function installCloudflared(options: CloudflaredInstallOptions = {}): Promise<string> {
  const platform = options.platform || process.platform;
  const asset = cloudflaredAsset(platform, options.arch || process.arch);
  const binDir = options.binDir || getAppPaths().binDir;
  const releaseBase = options.releaseBase || RELEASE_BASE;
  const fetchAsset = options.fetch || fetch;
  const temporaryDir = await mkdtemp(join(tmpdir(), "pi-daemon-cloudflared-"));
  const assetPath = join(temporaryDir, asset);
  const stagedTarget = join(binDir, `.cloudflared-${process.pid}-${randomUUID()}`);
  const target = join(binDir, "cloudflared");

  try {
    const [checksumsResponse, assetResponse] = await Promise.all([
      fetchAsset(`${releaseBase}/SHA256SUMS`, { redirect: "follow" }),
      fetchAsset(`${releaseBase}/${asset}`, { redirect: "follow" }),
    ]);
    if (!checksumsResponse.ok) throw new Error(`Unable to download cloudflared checksums (${checksumsResponse.status})`);
    if (!assetResponse.ok) throw new Error(`Unable to download cloudflared (${assetResponse.status})`);

    const checksums = await checksumsResponse.text();
    await writeFile(assetPath, new Uint8Array(await assetResponse.arrayBuffer()));
    const expected = checksumForAsset(checksums, asset);
    if (!expected) throw new Error(`No checksum published for ${asset}`);
    const actual = createHash("sha256").update(await readFile(assetPath)).digest("hex");
    if (actual !== expected) throw new Error(`Checksum verification failed for ${asset}`);

    const executable = platform === "darwin"
      ? await extractDarwinExecutable(assetPath, temporaryDir)
      : assetPath;
    await mkdir(binDir, { recursive: true, mode: 0o755 });
    await copyFile(executable, stagedTarget);
    await chmod(stagedTarget, 0o755);
    await rename(stagedTarget, target);
    return target;
  } finally {
    await rm(stagedTarget, { force: true }).catch(() => undefined);
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function checksumForAsset(checksums: string, asset: string): string | undefined {
  for (const line of checksums.split(/\r?\n/u)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/u.exec(line);
    if (match?.[2] === asset) return match[1]?.toLowerCase();
  }
  return undefined;
}

async function extractDarwinExecutable(assetPath: string, temporaryDir: string): Promise<string> {
  const unpackDir = join(temporaryDir, "unpack");
  await mkdir(unpackDir);
  await execFileAsync("tar", ["-xzf", assetPath, "-C", unpackDir]);
  const executable = await findFile(unpackDir, "cloudflared");
  if (!executable) throw new Error("cloudflared archive is invalid");
  return executable;
}

async function findFile(directory: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && basename(path) === name) return path;
    if (entry.isDirectory()) {
      const nested = await findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}
