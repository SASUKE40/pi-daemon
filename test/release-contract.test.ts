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
    const versionSource = await readFile(join(root, "src", "version.ts"), "utf8");
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");

    expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe(manifest.pi);
    expect(pkg.dependencies["@edward40/pi-computer-use"]).toBeUndefined();
    expect(versionSource).toContain(`VERSION = "${pkg.version}"`);
    expect(installer).toContain(`VERSION="\${PI_DAEMON_VERSION:-${pkg.version}}"`);
    expect(installer).toContain(`NODE_VERSION="${manifest.node.version}"`);
    expect(installer).toContain(`PI_VERSION="${manifest.pi}"`);
    expect(installer).toContain(`CLOUDFLARED_VERSION="${manifest.cloudflared.version}"`);
    expect(installer).toContain(`DAEMON_ASSET="edward40-pi-daemon-\${VERSION}.tgz"`);
    expect(installer).toContain('NPM_CONFIG_LOGLEVEL="error"');
    expect(installer).toContain('NPM_CONFIG_PROGRESS="false"');
    expect(installer).toContain('"$SELECTED_PI" install npm:@edward40/pi-computer-use');
    expect(installer).toContain("setup --from-installer </dev/tty >/dev/tty");
    for (const asset of Object.values(manifest.node.assets)) expect(workflow).toContain(String(asset));
  });

  it("builds a self-contained web-only release", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("npm pack --pack-destination artifacts");
    expect(workflow).toContain("sha256sum edward40-pi-daemon-*");
    expect(workflow).not.toContain("macos-");
    expect(workflow).not.toContain("electron");
    expect(workflow).not.toContain("NPM_TOKEN");
  });
});
