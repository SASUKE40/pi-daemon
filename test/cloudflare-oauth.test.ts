import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeCloudflare, cloudflareOAuthConfig } from "../src/cloudflare-oauth.js";

describe("Cloudflare OAuth", () => {
  it("uses PKCE, retrieves the callback privately, and revokes the temporary token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let authorizationUrl = "";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, ...(init ? { init } : {}) });
      if (url === "https://relay.example/sessions") return new Response(null, { status: 201 });
      if (url.startsWith("https://relay.example/sessions/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.startsWith("https://relay.example/sessions/")) return Response.json({ code: "authorization-code" });
      if (url === "https://dash.cloudflare.com/oauth2/token") return Response.json({ access_token: "temporary-access-token" });
      if (url === "https://dash.cloudflare.com/oauth2/revoke") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const session = await authorizeCloudflare({
      clientId: "public-client-id",
      redirectUri: "https://relay.example/callback",
      relayUrl: "https://relay.example",
      scopes: ["account.read", "dns.write"],
    }, {
      fetcher,
      onAuthorizationUrl(url) { authorizationUrl = url; },
      pollIntervalMs: 0,
    });

    expect(session.accessToken).toBe("temporary-access-token");
    const parsedAuthorization = new URL(authorizationUrl);
    expect(parsedAuthorization.origin + parsedAuthorization.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(parsedAuthorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsedAuthorization.searchParams.get("scope")).toBe("account.read dns.write");

    const createBody = JSON.parse(String(requests.find((item) => item.url.endsWith("/sessions"))?.init?.body)) as { state: string; pollSecretHash: string };
    expect(createBody.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createBody.pollSecretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsedAuthorization.searchParams.get("state")).toBe(createBody.state);

    const tokenRequest = requests.find((item) => item.url.endsWith("/oauth2/token"));
    const tokenBody = tokenRequest?.init?.body as URLSearchParams;
    const verifier = tokenBody.get("code_verifier") as string;
    expect(tokenBody.get("code")).toBe("authorization-code");
    expect(tokenBody.get("client_secret")).toBeNull();
    expect(parsedAuthorization.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));

    const pollRequest = requests.find((item) => item.url.includes("/sessions/") && !item.init?.method);
    expect(new Headers(pollRequest?.init?.headers).get("Authorization")).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(requests.some((item) => item.url.includes("/sessions/") && item.init?.method === "DELETE")).toBe(true);

    await session.revoke();
    await session.revoke();
    expect(requests.filter((item) => item.url.endsWith("/oauth2/revoke"))).toHaveLength(1);
  });

  it("loads an all-or-nothing HTTPS configuration", () => {
    expect(cloudflareOAuthConfig({})).toBeUndefined();
    expect(() => cloudflareOAuthConfig({ PI_DAEMON_CLOUDFLARE_OAUTH_CLIENT_ID: "client" })).toThrow("requires client ID");
    expect(() => cloudflareOAuthConfig({
      PI_DAEMON_CLOUDFLARE_OAUTH_CLIENT_ID: "client",
      PI_DAEMON_CLOUDFLARE_OAUTH_RELAY_URL: "http://relay.example",
      PI_DAEMON_CLOUDFLARE_OAUTH_REDIRECT_URI: "https://relay.example/callback",
    })).toThrow("HTTPS");
    expect(cloudflareOAuthConfig({
      PI_DAEMON_CLOUDFLARE_OAUTH_CLIENT_ID: "client",
      PI_DAEMON_CLOUDFLARE_OAUTH_RELAY_URL: "https://relay.example/",
      PI_DAEMON_CLOUDFLARE_OAUTH_REDIRECT_URI: "https://relay.example/callback",
      PI_DAEMON_CLOUDFLARE_OAUTH_SCOPES: "account.read   dns.write",
    })).toEqual({
      clientId: "client",
      relayUrl: "https://relay.example",
      redirectUri: "https://relay.example/callback",
      scopes: ["account.read", "dns.write"],
    });
  });
});
