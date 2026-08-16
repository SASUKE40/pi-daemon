import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiDaemonConfig } from "./config.js";

const MODEL_REFRESH_TIMEOUT_MS = 15_000;

/** Create Pi's model/auth runtime from the daemon's configured agent directory. */
export async function createModelRuntime(config: PiDaemonConfig): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(config.agentDir, "auth.json"),
    modelsPath: join(config.agentDir, "models.json"),
    allowModelNetwork: false,
  });
  assertValidModelConfig(runtime);
  return runtime;
}

/** Reload models.json without turning a model-picker action into a network catalog refresh. */
export async function refreshModels(runtime: ModelRuntime): Promise<void> {
  await runtime.refresh({
    allowNetwork: false,
    signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
  });
  assertValidModelConfig(runtime);
}

function assertValidModelConfig(runtime: ModelRuntime): void {
  const error = runtime.getError();
  if (error) throw new Error(`Invalid custom model configuration: ${error}`);
}
