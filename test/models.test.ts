import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiDaemonConfig } from "../src/config.js";
import { createModelRuntime, refreshModels } from "../src/models.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("custom model configuration", () => {
  it("loads and refreshes models.json from the configured Pi agent directory", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-models-"));
    const config = daemonConfig(root);
    await writeModels(root, "qwen2.5-coder:7b");

    const runtime = await createModelRuntime(config);
    expect(runtime.getModel("ollama", "qwen2.5-coder:7b")).toMatchObject({
      provider: "ollama",
      id: "qwen2.5-coder:7b",
    });
    expect(runtime.getAvailableSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "ollama", id: "qwen2.5-coder:7b" }),
    ]));

    await writeModels(root, "devstral-small-2");
    await refreshModels(runtime);
    expect(runtime.getModel("ollama", "devstral-small-2")).toBeDefined();
    expect(runtime.getModel("ollama", "qwen2.5-coder:7b")).toBeUndefined();
  });

  it("reports invalid custom model files instead of silently hiding their models", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daemon-models-"));
    await writeFile(join(root, "models.json"), "{ invalid json");

    await expect(createModelRuntime(daemonConfig(root))).rejects.toThrow("Invalid custom model configuration");
  });
});

function daemonConfig(agentDir: string): PiDaemonConfig {
  return {
    schemaVersion: 1,
    listenHost: "127.0.0.1",
    port: 8504,
    defaultCwd: "/tmp",
    agentDir,
  };
}

async function writeModels(agentDir: string, modelId: string): Promise<void> {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      ollama: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        models: [{ id: modelId }],
      },
    },
  }));
}
