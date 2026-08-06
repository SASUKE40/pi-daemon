import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare.js";

function response(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ message: "failed" }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Cloudflare provisioning", () => {
  it("creates an exact-email OTP policy and token-file-compatible tunnel", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/access/organizations") && !init?.method) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers") && !init?.method) return response([{ id: "otp-id", name: "OTP", type: "onetimepin" }]);
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
    const result = await new CloudflareClient("api-token-secret", fetcher).provision({
      accountId: "account-id",
      zoneId: "zone-id",
      hostname: "pi.example.com",
      allowedEmail: "Only@Example.com",
      teamName: "pi-team",
      tunnelName: "pi-daemon-test",
      localPort: 8504,
    });
    expect(result.config.allowedEmail).toBe("only@example.com");
    expect(result.tunnelToken).toBe("tunnel-token-secret");
    const appRequest = requests.find((item) => item.url.endsWith("/access/apps") && item.init?.method === "POST");
    const body = JSON.parse(String(appRequest?.init?.body));
    expect(body.allowed_idps).toEqual(["otp-id"]);
    expect(body.policies[0].include).toEqual([{ email: { email: "only@example.com" } }]);
    expect(body.policies[0].require).toEqual([{ login_method: { id: "otp-id" } }]);
    expect(JSON.stringify(requests)).not.toContain("tunnel-token-secret");
  });

  it("refuses to take over an existing tunnel without a saved managed id", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/access/organizations")) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers")) return response([{ id: "otp-id", name: "OTP", type: "onetimepin" }]);
      if (url.includes("/cfd_tunnel?")) return response([{ id: "someone-elses-tunnel", name: "pi-daemon-test", config_src: "cloudflare" }]);
      throw new Error(`Unexpected request: ${url}`);
    };
    await expect(new CloudflareClient("api-token-secret", fetcher).provision({
      accountId: "account-id", zoneId: "zone-id", hostname: "pi.example.com", allowedEmail: "only@example.com",
      teamName: "pi-team", tunnelName: "pi-daemon-test", localPort: 8504,
    })).rejects.toThrow("Tunnel name conflict");
  });

  it("refuses an existing Access app with another allow policy", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/access/organizations")) return response({ auth_domain: "pi-team.cloudflareaccess.com" });
      if (url.endsWith("/access/identity_providers")) return response([{ id: "otp-id", name: "OTP", type: "onetimepin" }]);
      if (url.includes("/cfd_tunnel?")) return response([{ id: "tunnel-id", name: "pi-daemon-test", config_src: "cloudflare" }]);
      if (url.includes("/dns_records?")) return response([{ id: "dns-id", type: "CNAME", name: "pi.example.com", content: "tunnel-id.cfargotunnel.com", proxied: true }]);
      if (url.includes("/access/apps?")) return response([{ id: "app-id", name: "Pi", domain: "pi.example.com", aud: "aud-id", type: "self_hosted" }]);
      if (url.endsWith("/access/apps/app-id/policies")) return response([
        { id: "managed", name: "Pi Daemon exact email", decision: "allow", include: [{ email: { email: "only@example.com" } }], require: [{ login_method: { id: "otp-id" } }] },
        { id: "broad", name: "Any OTP user", decision: "allow", include: [{ everyone: {} }] },
      ]);
      throw new Error(`Unexpected request: ${url}`);
    };
    await expect(new CloudflareClient("api-token-secret", fetcher).provision({
      accountId: "account-id", zoneId: "zone-id", hostname: "pi.example.com", allowedEmail: "only@example.com",
      teamName: "pi-team", tunnelName: "pi-daemon-test", localPort: 8504,
      previous: { accountId: "account-id", zoneId: "zone-id", tunnelId: "tunnel-id", accessAppId: "app-id", audience: "aud-id", teamDomain: "pi-team.cloudflareaccess.com", hostname: "pi.example.com", allowedEmail: "only@example.com" },
    })).rejects.toThrow("exclusive exact-email OTP policy");
  });
});
