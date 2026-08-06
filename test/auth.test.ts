import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AccessAuthorizer, allowedOrigins, isLoopbackHost, normalizeTeamDomain } from "../src/auth.js";
import type { PiDaemonConfig } from "../src/config.js";

const accessConfig: PiDaemonConfig = {
  schemaVersion: 1,
  listenHost: "127.0.0.1",
  port: 8504,
  defaultCwd: "/tmp",
  agentDir: "/tmp/agent",
  cloudflare: {
    accountId: "a", zoneId: "z", tunnelId: "t", accessAppId: "app", audience: "aud",
    teamDomain: "team.cloudflareaccess.com", hostname: "pi.example.com", allowedEmail: "me@example.com",
  },
};

describe("Access helpers", () => {
  it("allows only exact loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1:8504")).toBe(true);
    expect(isLoopbackHost("localhost:8504")).toBe(true);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
  });

  it("normalizes an HTTPS team domain", () => {
    expect(normalizeTeamDomain("team.cloudflareaccess.com")).toBe("https://team.cloudflareaccess.com");
    expect(() => normalizeTeamDomain("http://team.cloudflareaccess.com")).toThrow("HTTPS");
  });

  it("builds exact websocket origins", () => {
    expect(allowedOrigins(accessConfig)).toEqual(new Set(["http://127.0.0.1:8504", "http://localhost:8504", "https://pi.example.com"]));
    expect(allowedOrigins(accessConfig).has("https://evil.example.com")).toBe(false);
  });

  it("verifies issuer, audience, expiry, signature, and exact email", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
    const authorizer = new AccessAuthorizer(accessConfig, createLocalJWKSet({ keys: [jwk] }));
    const sign = (email: string, expiry: string) => new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("aud")
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);

    const valid = await sign("ME@example.com", "5m");
    await expect(authorizer.authorize({ host: "pi.example.com", "cf-access-jwt-assertion": valid })).resolves.toMatchObject({ local: false, email: "me@example.com" });
    await expect(authorizer.authorize({ host: "pi.example.com", "cf-access-jwt-assertion": await sign("other@example.com", "5m") })).rejects.toThrow("not allowed");
    await expect(authorizer.authorize({ host: "pi.example.com", "cf-access-jwt-assertion": await sign("me@example.com", "0s") })).rejects.toThrow();
  });
});
