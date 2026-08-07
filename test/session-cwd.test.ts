import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureWorkingDirectory } from "../src/sessiond.js";

describe("ensureWorkingDirectory", () => {
  it("creates a missing working directory recursively", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-daemon-cwd-"));
    const requested = join(root, "new", "project");

    try {
      const cwd = await ensureWorkingDirectory(requested);
      expect(cwd).toBe(await realpath(requested));
      expect((await stat(requested)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still rejects an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-daemon-cwd-"));
    const requested = join(root, "file.txt");

    try {
      await writeFile(requested, "not a directory");
      await expect(ensureWorkingDirectory(requested)).rejects.toThrow("Working directory is not a directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
