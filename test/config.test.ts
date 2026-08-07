import { describe, expect, it } from "vitest";
import { activeRelay, publicHostname, validateConfig, type PiDaemonConfig } from "../src/config.js";

const base: PiDaemonConfig = {
  schemaVersion: 1,
  listenHost: "127.0.0.1",
  port: 8504,
  defaultCwd: "/tmp",
  agentDir: "/tmp/agent",
};

describe("relay configuration", () => {
  it("keeps pre-relay Cloudflare configurations compatible", () => {
    const legacy: PiDaemonConfig = {
      ...base,
      cloudflare: {
        accountId: "a",
        zoneId: "z",
        tunnelId: "t",
        accessAppId: "app",
        audience: "aud",
        teamDomain: "team.cloudflareaccess.com",
        hostname: "pi.example.com",
        allowedEmail: "me@example.com",
      },
    };
    expect(activeRelay(validateConfig(legacy))).toBe("cloudflare");
    expect(publicHostname(legacy)).toBe("pi.example.com");
  });

  it("accepts legacy GitHub organization access so setup can migrate it", () => {
    const github = validateConfig({
      ...base,
      relay: "cloudflare",
      cloudflare: {
        accountId: "a",
        zoneId: "z",
        tunnelId: "t",
        accessAppId: "app",
        audience: "aud",
        teamDomain: "team.cloudflareaccess.com",
        hostname: "pi.example.com",
        access: {
          type: "github",
          identityProviderId: "github-id",
          identityProviderName: "GitHub",
          organization: "SASUKE40",
          team: "pi-admins",
        },
      },
    });

    expect(github.cloudflare?.access).toMatchObject({ type: "github", organization: "SASUKE40" });
    expect(github.cloudflare?.allowedEmail).toBeUndefined();
  });

  it("rejects ambiguous or unrestricted Cloudflare identities", () => {
    const cloudflare = {
      accountId: "a", zoneId: "z", tunnelId: "t", accessAppId: "app", audience: "aud",
      teamDomain: "team.cloudflareaccess.com", hostname: "pi.example.com",
    };
    expect(() => validateConfig({ ...base, cloudflare })).toThrow("exactly one Access identity");
    expect(() => validateConfig({
      ...base,
      cloudflare: {
        ...cloudflare,
        allowedEmail: "me@example.com",
        access: { type: "github", identityProviderId: "id", identityProviderName: "GitHub", organization: "org" },
      },
    })).toThrow("exactly one Access identity");
  });

  it("selects Tailscale when both relay configurations are retained", () => {
    const config = validateConfig({
      ...base,
      relay: "tailscale",
      tailscale: {
        hostname: "pi-device.tail1234.ts.net",
        allowedLogin: "me@example.com",
        httpsPort: 443,
        localPort: 8504,
      },
    });
    expect(activeRelay(config)).toBe("tailscale");
    expect(publicHostname(config)).toBe("pi-device.tail1234.ts.net");
  });

  it("requires matching metadata for the selected relay", () => {
    expect(() => validateConfig({ ...base, relay: "tailscale" })).toThrow("Tailscale relay configuration is missing");
    expect(() => validateConfig({ ...base, relay: "cloudflare" })).toThrow("Cloudflare relay configuration is missing");
  });

  it("requires Tailscale to proxy to the configured loopback web port", () => {
    expect(() => validateConfig({
      ...base,
      relay: "tailscale",
      tailscale: {
        hostname: "pi-device.tail1234.ts.net",
        allowedLogin: "me@example.com",
        httpsPort: 443,
        localPort: 9000,
      },
    })).toThrow("must match the web port");
  });
});
