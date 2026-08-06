import { closeSync, createReadStream, createWriteStream, openSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";

export class TerminalPrompter {
  private readonly fd: number;
  private readonly input: ReturnType<typeof createReadStream>;
  private readonly output: ReturnType<typeof createWriteStream>;
  private readonly readline: Interface;

  constructor(path = "/dev/tty") {
    this.fd = openSync(path, "r+");
    this.input = createReadStream(path, { fd: this.fd, autoClose: false });
    this.output = createWriteStream(path, { fd: this.fd, autoClose: false });
    this.readline = createInterface({ input: this.input, output: this.output, terminal: true });
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
    const disabled = spawnSync("stty", ["-echo"], { stdio: [this.fd, this.fd, this.fd] });
    if (disabled.status !== 0) throw new Error("Unable to disable terminal echo");
    try {
      return (await this.readline.question("")).trim();
    } finally {
      spawnSync("stty", ["echo"], { stdio: [this.fd, this.fd, this.fd] });
      this.output.write("\n");
    }
  }

  print(message: string): void {
    this.output.write(`${message}\n`);
  }

  runInteractive(command: string, args: string[] = []): SpawnSyncReturns<Buffer> {
    return spawnSync(command, args, { stdio: [this.fd, this.fd, this.fd] });
  }

  close(): void {
    this.readline.close();
    this.input.destroy();
    this.output.end();
    closeSync(this.fd);
  }
}
