import { describe, expect, it } from "vitest";
import {
  detectedTailscaleLogin,
  hasServeConfiguration,
  tailscaleHostname,
  tailscaleServeArgs,
  tailscaleTarget,
  validateTailscaleLogin,
  type TailscaleStatus,
} from "../src/tailscale.js";
import type { TailscaleConfig } from "../src/config.js";

const config: TailscaleConfig = {
  hostname: "pi-device.tail1234.ts.net",
  allowedLogin: "me@example.com",
  httpsPort: 443,
  localPort: 8504,
};

describe("Tailscale Serve helpers", () => {
  it("reads and normalizes the MagicDNS hostname", () => {
    expect(tailscaleHostname({ Self: { DNSName: "Pi-Device.Tail1234.TS.NET." } })).toBe("pi-device.tail1234.ts.net");
    expect(() => tailscaleHostname({})).toThrow("MagicDNS");
  });

  it("detects the signed-in owner from the local Tailscale status", () => {
    const status: TailscaleStatus = {
      Self: { UserID: 42 },
      User: {
        "7": { LoginName: "other@example.com" },
        "42": { LoginName: "me@example.com" },
      },
    };
    expect(detectedTailscaleLogin(status)).toBe("me@example.com");
    expect(detectedTailscaleLogin({ User: { "42": { LoginName: "only@example.com" } } })).toBe("only@example.com");
  });

  it("uses an explicit persistent HTTPS listener and loopback backend", () => {
    expect(tailscaleTarget(config)).toBe("http://127.0.0.1:8504");
    expect(tailscaleServeArgs(config)).toEqual([
      "serve",
      "--https=443",
      "--bg",
      "http://127.0.0.1:8504",
    ]);
  });

  it("distinguishes empty Serve state from existing configuration", () => {
    expect(hasServeConfiguration("")).toBe(false);
    expect(hasServeConfiguration("{}")).toBe(false);
    expect(hasServeConfiguration('{"TCP":{"443":{}}}')).toBe(true);
    expect(hasServeConfiguration("non-json status")).toBe(true);
  });

  it("validates a non-whitespace login identity", () => {
    expect(() => validateTailscaleLogin("me@example.com")).not.toThrow();
    expect(() => validateTailscaleLogin("me @example.com")).toThrow("Invalid Tailscale login");
    expect(() => validateTailscaleLogin("")).toThrow("Invalid Tailscale login");
  });
});
