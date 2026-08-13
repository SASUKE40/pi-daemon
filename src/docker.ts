#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log } from "./log.js";

const scripts = ["sessiond.js", "web.js"] as const;
const directory = dirname(fileURLToPath(import.meta.url));

function start(script: typeof scripts[number]): ChildProcess {
  const child = spawn(process.execPath, [join(directory, script)], {
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => log.error("container service failed to start", { script, message: error.message }));
  return child;
}

function exited(child: ChildProcess, script: string): Promise<{ script: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ script, code, signal })));
}

async function main(): Promise<void> {
  const children = scripts.map((script) => ({ script, child: start(script) }));
  let requestedSignal: NodeJS.Signals | undefined;
  const stopRequested = new Promise<{ signal: NodeJS.Signals }>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        requestedSignal = signal;
        resolve({ signal });
      });
    }
  });
  const first = await Promise.race([
    ...children.map(({ child, script }) => exited(child, script)),
    stopRequested,
  ]);

  if ("script" in first && !requestedSignal) {
    log.error("container service exited", first);
    process.exitCode = first.code || 1;
  }
  const signal = requestedSignal || "SIGTERM";
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal);

  const forceStop = setTimeout(() => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 10_000);
  forceStop.unref();
  await Promise.all(children.map(({ child, script }) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : exited(child, script)));
  clearTimeout(forceStop);
}

void main().catch((error) => {
  log.error("container supervisor failed", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
