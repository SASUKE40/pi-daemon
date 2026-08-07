import { openSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";
import { ReadStream, WriteStream } from "node:tty";
import { Writable } from "node:stream";

class MuteableTerminalOutput extends Writable {
  muted = false;
  readonly isTTY = true;

  constructor(private readonly target: WriteStream) {
    super();
  }

  get columns(): number { return this.target.columns; }
  get rows(): number { return this.target.rows; }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.muted) {
      callback();
      return;
    }
    this.target.write(chunk, encoding, callback);
  }
}

export class TerminalPrompter {
  private readonly inputFd: number;
  private readonly outputFd: number;
  private readonly input: ReadStream;
  private readonly output: WriteStream;
  private readonly readlineOutput: MuteableTerminalOutput;
  private readonly readline: Interface;

  constructor(path = "/dev/tty") {
    this.inputFd = openSync(path, "r");
    this.outputFd = openSync(path, "w");
    this.input = new ReadStream(this.inputFd);
    this.output = new WriteStream(this.outputFd);
    this.readlineOutput = new MuteableTerminalOutput(this.output);
    this.readline = createInterface({ input: this.input, output: this.readlineOutput, terminal: true });
  }

  async question(label: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await this.readline.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue || "";
  }

  async confirm(label: string, defaultValue = true): Promise<boolean> {
    const answer = (await this.question(`${label} ${defaultValue ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
    if (!answer) return defaultValue;
    return answer === "y" || answer === "yes";
  }

  async secret(label: string): Promise<string> {
    this.output.write(`${label}: `);
    this.readlineOutput.muted = true;
    try {
      return (await this.readline.question("")).trim();
    } finally {
      this.readlineOutput.muted = false;
      this.output.write("\n");
    }
  }

  print(message: string): void {
    this.output.write(`${message}\n`);
  }

  runInteractive(command: string, args: string[] = []): SpawnSyncReturns<Buffer> {
    const wasRaw = this.input.isRaw;
    this.readline.pause();
    if (wasRaw) this.input.setRawMode(false);
    try {
      return spawnSync(command, args, { stdio: [this.inputFd, this.outputFd, this.outputFd] });
    } finally {
      this.readline.resume();
      if (wasRaw) this.input.setRawMode(true);
    }
  }

  close(): void {
    this.readline.close();
    this.input.destroy();
    this.output.end();
  }
}
