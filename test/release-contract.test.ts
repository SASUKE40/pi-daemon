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
    const cloudflaredInstaller = await readFile(join(root, "src", "cloudflared-install.ts"), "utf8");
    const cli = await readFile(join(root, "src", "cli.ts"), "utf8");
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");

    expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe(manifest.pi);
    expect(pkg.dependencies["@edward40/pi-computer-use"]).toBeUndefined();
    expect(versionSource).toContain(`VERSION = "${pkg.version}"`);
    expect(installer).toContain(`VERSION="\${PI_DAEMON_VERSION:-${pkg.version}}"`);
    expect(installer).toContain(`NODE_VERSION="${manifest.node.version}"`);
    expect(installer).toContain(`PI_VERSION="${manifest.pi}"`);
    expect(versionSource).toContain(`CLOUDFLARED_VERSION = "${manifest.cloudflared.version}"`);
    expect(installer).toContain(`DAEMON_ASSET="edward40-pi-daemon-\${VERSION}.tgz"`);
    expect(installer).toContain('NPM_CONFIG_LOGLEVEL="error"');
    expect(installer).toContain('NPM_CONFIG_PROGRESS="false"');
    expect(installer).toContain('"$SELECTED_PI" install npm:@edward40/pi-computer-use');
    expect(installer).toContain("setup --from-installer </dev/tty >/dev/tty");
    expect(installer).not.toContain("PI_DAEMON_CLOUDFLARED");
    expect(installer).not.toContain("Installing cloudflared");
    const relaySelection = cli.indexOf("const relay = await selectRelay(prompt, current, memo)");
    const cloudflareBranch = cli.indexOf('if (relay === "cloudflare")', relaySelection);
    const cloudflaredInstall = cli.indexOf("const cloudflared = await findOrInstallCloudflared(prompt)", cloudflareBranch);
    expect(relaySelection).toBeGreaterThan(-1);
    expect(cloudflareBranch).toBeGreaterThan(relaySelection);
    expect(cloudflaredInstall).toBeGreaterThan(cloudflareBranch);
    for (const asset of Object.values(manifest.node.assets)) expect(workflow).toContain(String(asset));
    for (const asset of Object.values(manifest.cloudflared.assets)) {
      expect(workflow).toContain(String(asset));
      expect(cloudflaredInstaller).toContain(String(asset));
    }
  });

  it("builds a self-contained web-only release", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("npm pack --pack-destination artifacts");
    expect(workflow).toContain("sha256sum edward40-pi-daemon-*");
    expect(workflow).not.toContain("macos-");
    expect(workflow).not.toContain("electron");
    expect(workflow).not.toContain("NPM_TOKEN");
  });

  it("keeps the Nix flake aligned with the npm package and service names", async () => {
    const flake = await readFile(join(root, "flake.nix"), "utf8");
    const nixPackage = await readFile(join(root, "nix", "package.nix"), "utf8");
    const module = await readFile(join(root, "nix", "home-manager.nix"), "utf8");
    const services = await readFile(join(root, "src", "services.ts"), "utf8");
    const readme = await readFile(join(root, "README.md"), "utf8");

    expect(flake).toContain("homeManagerModules");
    expect(flake).toContain("default = self.homeManagerModules.pi-daemon;");
    expect(nixPackage).toContain("manifest = lib.importJSON ../package.json;");
    expect(nixPackage).toContain("inherit (manifest) version;");
    expect(nixPackage).toContain("importNpmLock");
    expect(nixPackage).not.toMatch(/npmDepsHash/u);
    expect(nixPackage).toContain("nodejs_24");
    for (const file of ["package-lock.json", "tsconfig.build.json", "vite.config.ts", "src", "web"]) {
      expect(nixPackage).toContain(`../${file}`);
    }
    expect(module).toContain('PI_DAEMON_MANAGED_SERVICES = "1";');
    expect(services).toContain('env.PI_DAEMON_MANAGED_SERVICES === "1"');
    for (const name of ["sessiond", "web", "cloudflared"]) {
      expect(module).toContain(`pi-daemon-${name} =`);
      expect(services).toContain(`pi-daemon-${name}.service`);
      expect(services).toContain(`com.edward40.pi-daemon.${name}`);
    }
    expect(module).toContain('Label = "com.edward40.pi-daemon.${name}";');
    expect(module).toContain("${packageDir}/dist/sessiond.js");
    expect(module).toContain("${packageDir}/dist/web.js");
    expect(readme).toContain("inputs.pi-daemon.url = \"github:SASUKE40/pi-daemon\";");
    expect(readme).toContain("inputs.pi-daemon.homeManagerModules.default");
  });

  it("keeps the Docker runtime aligned and loopback-published", async () => {
    const manifest = JSON.parse(await readFile(join(root, "compatibility.json"), "utf8"));
    const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
    const compose = await readFile(join(root, "compose.yaml"), "utf8");
    const readme = await readFile(join(root, "README.md"), "utf8");
    const ci = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");

    expect(dockerfile).toContain(`FROM node:${manifest.node.version}-bookworm-slim`);
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('PI_DAEMON_BIND_HOST=0.0.0.0');
    expect(compose).toContain("image: edward40/pi-daemon:");
    expect(compose).toContain('"127.0.0.1:8504:8504"');
    expect(compose).toContain("pi-agent:/home/node/.pi/agent");
    expect(readme).toContain("docker pull edward40/pi-daemon:latest");
    expect(readme).toContain("edward40/pi-daemon:latest");
    expect(ci).toContain("docker build --tag pi-daemon:ci .");
    expect(release).toContain("images: edward40/pi-daemon");
    expect(release).toContain("platforms: linux/amd64,linux/arm64");
    expect(release).toContain("secrets.DOCKERHUB_TOKEN");
  });
});
