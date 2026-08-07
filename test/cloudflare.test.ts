import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare.js";
import type { CloudflareConfig } from "../src/config.js";

const githubAccess = {
  type: "github",
  identityProviderId: "github-id",
  identityProviderName: "GitHub",
  organization: "SASUKE40",
  team: "pi-admins",
} as const;

const githubConfig: CloudflareConfig = {
  accountId: "account-id",
  zoneId: "zone-id",
  tunnelId: "tunnel-id",
  accessAppId: "app-id",
  audience: "aud-id",
  teamDomain: "pi-team.cloudflareaccess.com",
  hostname: "pi.example.com",
  access: githubAccess,
};

function response(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ message: "failed" }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function provisionInput() {
  return {
    accountId: "account-id",
    zoneId: "zone-id",
    hostname: "pi.example.com",
    allowedEmail: "Only@Example.com",
    teamName: "pi-team",
    tunnelName: "pi-daemon-test",
    localPort: 8504,
  };
}

describe("Cloudflare provisioning", () => {
  it("preflights every API surface used by setup", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/access/organizations")) return response(null, 404);
      return response([]);
    };

    await new CloudflareClient("api-token-secret", fetcher).checkSetupAccess("account-id", "zone-id");

    expect(requests).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account-id/cfd_tunnel?is_deleted=false&per_page=5",
      "https://api.cloudflare.com/client/v4/accounts/account-id/access/apps?per_page=5",
      "https://api.cloudflare.com/client/v4/accounts/account-id/access/identity_providers",
      "https://api.cloudflare.com/client/v4/accounts/account-id/access/organizations",
      "https://api.cloudflare.com/client/v4/zones/zone-id/dns_records?per_page=5",
    ]);
  });

  it("identifies the missing permission during setup preflight", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/access/apps?")) return response(null, 403);
      return response([]);
    };

    await expect(new CloudflareClient("api-token-secret", fetcher).checkSetupAccess("account-id", "zone-id"))
      .rejects.toThrow("API token cannot access Access applications: GET /accounts/account-id/access/apps?per_page=5: failed");
  });

  it("creates an exact-email OTP policy and token-file-compatible tunnel", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/access/organizations") && !init?.method) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers") && !init?.method) return response([]);
      if (url.endsWith("/access/identity_providers") && init?.method === "POST") return response({ id: "otp-id", name: "One-time PIN", type: "onetimepin" });
      if (url.includes("/cfd_tunnel?") && !init?.method) return response([]);
      if (url.endsWith("/cfd_tunnel") && init?.method === "POST") return response({ id: "tunnel-id", name: "pi-daemon-test" });
      if (url.includes("/dns_records?") && !init?.method) return response([]);
      if (url.endsWith("/dns_records") && init?.method === "POST") return response({ id: "dns-id", type: "CNAME", name: "pi.example.com", content: "tunnel-id.cfargotunnel.com" });
      if (url.includes("/access/apps?") && !init?.method) return response([]);
      if (url.endsWith("/access/apps") && init?.method === "POST") return response({ id: "app-id", name: "Pi", domain: "pi.example.com", aud: "aud-id", type: "self_hosted" });
      if (url.endsWith("/configurations") && init?.method === "PUT") return response({});
      if (url.endsWith("/token")) return response("tunnel-token-secret");
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await new CloudflareClient("api-token-secret", fetcher).provision(provisionInput());

    expect(result.config.allowedEmail).toBe("only@example.com");
    expect(result.config.access).toBeUndefined();
    expect(result.created).toContain("One-time PIN identity provider");
    expect(result.tunnelToken).toBe("tunnel-token-secret");
    const appRequest = requests.find((item) => item.url.endsWith("/access/apps") && item.init?.method === "POST");
    const body = JSON.parse(String(appRequest?.init?.body));
    expect(body.allowed_idps).toEqual(["otp-id"]);
    expect(body.auto_redirect_to_identity).toBe(true);
    expect(body.policies[0].include).toEqual([{ email: { email: "only@example.com" } }]);
    expect(body.policies[0].require).toEqual([{ login_method: { id: "otp-id" } }]);
    expect(JSON.stringify(requests)).not.toContain("tunnel-token-secret");
  });

  it("refuses to take over an existing tunnel without a saved managed id", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/access/organizations")) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers")) return response([{ id: "otp-id", name: "One-time PIN", type: "onetimepin" }]);
      if (url.includes("/cfd_tunnel?")) return response([{ id: "someone-elses-tunnel", name: "pi-daemon-test", config_src: "cloudflare" }]);
      throw new Error(`Unexpected request: ${url}`);
    };

    await expect(new CloudflareClient("api-token-secret", fetcher).provision(provisionInput())).rejects.toThrow("Tunnel name conflict");
  });

  it("reuses a confirmed remote tunnel while still creating and validating its protected route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/access/organizations")) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers")) return response([{ id: "otp-id", name: "One-time PIN", type: "onetimepin" }]);
      if (url.includes("/cfd_tunnel?")) return response([{ id: "tunnel-id", name: "pi-daemon-test", config_src: "cloudflare" }]);
      if (url.includes("/dns_records?") && !init?.method) return response([]);
      if (url.endsWith("/dns_records") && init?.method === "POST") return response({ id: "dns-id", type: "CNAME", name: "pi.example.com", content: "tunnel-id.cfargotunnel.com", proxied: true });
      if (url.includes("/access/apps?") && !init?.method) return response([]);
      if (url.endsWith("/access/apps") && init?.method === "POST") return response({ id: "app-id", name: "Pi", domain: "pi.example.com", aud: "aud-id", type: "self_hosted" });
      if (url.endsWith("/configurations") && init?.method === "PUT") return response({});
      if (url.endsWith("/token")) return response("tunnel-token-secret");
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await new CloudflareClient("api-token-secret", fetcher).provision({ ...provisionInput(), adoptExisting: true });

    expect(result.config.tunnelId).toBe("tunnel-id");
    expect(result.created).toEqual(["DNS pi.example.com", "Access application pi.example.com"]);
    expect(requests.some((item) => item.url.endsWith("/cfd_tunnel") && item.init?.method === "POST")).toBe(false);
  });

  it("does not adopt a locally managed tunnel even with confirmation", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/access/organizations")) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers")) return response([{ id: "otp-id", name: "One-time PIN", type: "onetimepin" }]);
      if (url.includes("/cfd_tunnel?")) return response([{ id: "tunnel-id", name: "pi-daemon-test", config_src: "local" }]);
      throw new Error(`Unexpected request: ${url}`);
    };

    await expect(new CloudflareClient("api-token-secret", fetcher).provision({ ...provisionInput(), adoptExisting: true })).rejects.toThrow("not remotely managed");
  });

  it("migrates its saved GitHub policy to exact-email OTP without an open-policy window", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/access/organizations")) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers")) return response([
        { id: "github-id", name: "GitHub", type: "github" },
        { id: "otp-id", name: "One-time PIN", type: "onetimepin" },
      ]);
      if (url.includes("/cfd_tunnel?")) return response([{ id: "tunnel-id", name: "pi-daemon-test", config_src: "cloudflare" }]);
      if (url.includes("/dns_records?")) return response([{ id: "dns-id", type: "CNAME", name: "pi.example.com", content: "tunnel-id.cfargotunnel.com", proxied: true }]);
      if (url.includes("/access/apps?") && !init?.method) return response([{
        id: "app-id", name: "Pi", domain: "pi.example.com", aud: "aud-id", type: "self_hosted",
        allowed_idps: ["github-id"], auto_redirect_to_identity: true,
      }]);
      if (url.endsWith("/access/apps/app-id/policies") && !init?.method) return response([{
        id: "github-policy", name: "Pi Daemon GitHub organization", decision: "allow",
        include: [{ "github-organization": { name: "SASUKE40", team: "pi-admins", identity_provider_id: "github-id" } }],
        require: [{ login_method: { id: "github-id" } }],
      }]);
      if (url.endsWith("/access/apps/app-id/policies/github-policy") && init?.method === "PUT") return response({});
      if (url.endsWith("/access/apps/app-id") && init?.method === "PUT") return response({});
      if (url.endsWith("/configurations") && init?.method === "PUT") return response({});
      if (url.endsWith("/token")) return response("tunnel-token-secret");
      throw new Error(`Unexpected request: ${url}`);
    };
    const result = await new CloudflareClient("api-token-secret", fetcher).provision({ ...provisionInput(), previous: githubConfig });

    const policyUpdate = requests.find((item) => item.url.endsWith("/policies/github-policy") && item.init?.method === "PUT");
    const appUpdate = requests.find((item) => item.url.endsWith("/access/apps/app-id") && item.init?.method === "PUT");
    expect(JSON.parse(String(policyUpdate?.init?.body)).include).toEqual([{ email: { email: "only@example.com" } }]);
    expect(JSON.parse(String(policyUpdate?.init?.body)).require).toEqual([{ login_method: { id: "otp-id" } }]);
    expect(JSON.parse(String(appUpdate?.init?.body))).toMatchObject({ allowed_idps: ["otp-id"], auto_redirect_to_identity: true });
    expect(requests.indexOf(policyUpdate!)).toBeLessThan(requests.indexOf(appUpdate!));
    expect(result.config.allowedEmail).toBe("only@example.com");
    expect(result.created).toContain("Access policy migrated from GitHub to email OTP");
  });

  it("refuses an existing Access app with another allow policy", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/access/organizations")) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers")) return response([
        { id: "github-id", name: "GitHub", type: "github" },
        { id: "otp-id", name: "One-time PIN", type: "onetimepin" },
      ]);
      if (url.includes("/cfd_tunnel?")) return response([{ id: "tunnel-id", name: "pi-daemon-test", config_src: "cloudflare" }]);
      if (url.includes("/dns_records?")) return response([{ id: "dns-id", type: "CNAME", name: "pi.example.com", content: "tunnel-id.cfargotunnel.com", proxied: true }]);
      if (url.includes("/access/apps?")) return response([{
        id: "app-id", name: "Pi", domain: "pi.example.com", aud: "aud-id", type: "self_hosted",
        allowed_idps: ["github-id"], auto_redirect_to_identity: true,
      }]);
      if (url.endsWith("/access/apps/app-id/policies")) return response([
        {
          id: "managed", name: "Pi Daemon GitHub organization", decision: "allow",
          include: [{ "github-organization": { name: "SASUKE40", team: "pi-admins", identity_provider_id: "github-id" } }],
          require: [{ login_method: { id: "github-id" } }],
        },
        { id: "broad", name: "Any GitHub user", decision: "allow", include: [{ everyone: {} }] },
      ]);
      throw new Error(`Unexpected request: ${url}`);
    };

    await expect(new CloudflareClient("api-token-secret", fetcher).provision({ ...provisionInput(), previous: githubConfig }))
      .rejects.toThrow("exclusive exact-email OTP policy");
  });
});
