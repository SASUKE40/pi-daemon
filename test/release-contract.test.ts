import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("release contract", () => {
  it("keeps installer, package, and compatibility pins aligned", async () => {
    const manifest = JSON.parse(await readFile(join(root, "compatibility.json"), "utf8"));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const installer = await readFile(join(root, "installer", "install.sh"), "utf8");
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");

    expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe(manifest.pi);
    expect(pkg.dependencies["@edward40/pi-computer-use"]).toBe(manifest.computerUse);
    expect(installer).toContain(`NODE_VERSION="${manifest.node.version}"`);
    expect(installer).toContain(`PI_VERSION="${manifest.pi}"`);
    expect(installer).toContain(`CLOUDFLARED_VERSION="${manifest.cloudflared.version}"`);
    for (const asset of Object.values(manifest.node.assets)) expect(workflow).toContain(String(asset));
  });

  it("builds native macOS bundles on both runner architectures", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("runner: macos-15\n            arch: arm64");
    expect(workflow).toContain("runner: macos-15-intel\n            arch: x64");
    expect(workflow).toContain("merge-multiple: true");
  });
});
