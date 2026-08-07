import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAppPaths } from "./paths.js";

export interface SetupMemo {
  schemaVersion: 1;
  defaultCwd: string;
  hostname: string;
  allowedEmail: string;
  accountId: string;
  zoneId: string;
  cloudflareApiToken: string;
}

export function validateSetupMemo(value: unknown): SetupMemo {
  if (!value || typeof value !== "object") throw new Error("Setup memo must be an object");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1) throw new Error("Unsupported setup memo schema");
  for (const key of ["defaultCwd", "hostname", "allowedEmail", "accountId", "zoneId", "cloudflareApiToken"]) {
    if (typeof item[key] !== "string" || !(item[key] as string)) throw new Error(`Invalid setup memo field: ${key}`);
  }
  return value as SetupMemo;
}

export async function loadSetupMemo(): Promise<SetupMemo | undefined> {
  const { setupMemoFile } = getAppPaths();
  try {
    const details = await stat(setupMemoFile);
    if (!details.isFile()) throw new Error("Setup memo must be a regular file");
    if ((details.mode & 0o777) !== 0o600) throw new Error("Setup memo permissions must be 0600");
    return validateSetupMemo(JSON.parse(await readFile(setupMemoFile, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveSetupMemo(memo: SetupMemo): Promise<void> {
  validateSetupMemo(memo);
  const { setupMemoFile } = getAppPaths();
  await mkdir(dirname(setupMemoFile), { recursive: true, mode: 0o700 });
  const temporary = `${setupMemoFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(memo, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, setupMemoFile);
}

export async function removeRuntimeConfigPreservingSetupMemo(): Promise<void> {
  const { configDir, setupMemoFile } = getAppPaths();
  const memoName = basename(setupMemoFile);
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (name !== memoName) await rm(join(configDir, name), { recursive: true, force: true });
  }
}
