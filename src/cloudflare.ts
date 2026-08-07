import type { CloudflareConfig } from "./config.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { page?: number; total_pages?: number };
}

export interface CloudflareAccount { id: string; name: string }
export interface CloudflareZone { id: string; name: string; account?: { id: string } }
interface AccessOrganization { auth_domain: string; name?: string }
interface IdentityProvider { id: string; name: string; type: string }
interface Tunnel { id: string; name: string; config_src?: string; deleted_at?: string | null }
interface DnsRecord { id: string; name: string; type: string; content: string; proxied?: boolean }
interface AccessPolicy { id: string; name: string; decision: string; include?: unknown[]; require?: unknown[] }
interface AccessApplication {
  id: string;
  name: string;
  domain: string;
  aud: string;
  type: string;
  allowed_idps?: string[];
}

export interface ProvisionInput {
  accountId: string;
  zoneId: string;
  hostname: string;
  allowedEmail: string;
  teamName: string;
  tunnelName: string;
  localPort: number;
  previous?: CloudflareConfig;
}

export interface ProvisionResult {
  config: CloudflareConfig;
  tunnelToken: string;
  created: string[];
}

export class CloudflareClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (!token) throw new Error("Cloudflare API token is required");
  }

  async verify(): Promise<void> {
    await this.request("/user/tokens/verify");
  }

  async accounts(): Promise<CloudflareAccount[]> {
    return this.request<CloudflareAccount[]>("/accounts?per_page=50");
  }

  async zones(accountId: string): Promise<CloudflareZone[]> {
    return this.request<CloudflareZone[]>(`/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`);
  }

  async checkSetupAccess(accountId: string, zoneId: string): Promise<void> {
    await this.checkReadable("Cloudflare Tunnels", `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=5`);
    await this.checkReadable("Access applications", `/accounts/${accountId}/access/apps?per_page=5`, true);
    await this.checkReadable("Access identity providers", `/accounts/${accountId}/access/identity_providers`, true);
    await this.checkReadable("Access organization", `/accounts/${accountId}/access/organizations`, true);
    await this.checkReadable("DNS records", `/zones/${zoneId}/dns_records?per_page=5`);
  }

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    validateHostname(input.hostname);
    validateEmail(input.allowedEmail);
    const created: string[] = [];
    const organization = await this.ensureOrganization(input.accountId, input.teamName, created);
    const idp = await this.ensureOtpProvider(input.accountId, created);
    const tunnel = await this.ensureTunnel(input, created);
    const dns = await this.ensureDns(input, tunnel.id, created);
    void dns;
    const app = await this.ensureAccessApp(input, idp.id, created);
    await this.ensureTunnelConfiguration(input, tunnel.id, app.aud, organization.auth_domain);
    const tunnelToken = await this.request<string>(`/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/token`);
    return {
      created,
      tunnelToken,
      config: {
        accountId: input.accountId,
        zoneId: input.zoneId,
        tunnelId: tunnel.id,
        accessAppId: app.id,
        audience: app.aud,
        teamDomain: organization.auth_domain,
        hostname: input.hostname.toLowerCase(),
        allowedEmail: input.allowedEmail.toLowerCase(),
      },
    };
  }

  async deleteManaged(config: CloudflareConfig): Promise<void> {
    await this.request(`/accounts/${config.accountId}/access/apps/${config.accessAppId}`, { method: "DELETE" });
    const records = await this.request<DnsRecord[]>(`/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(config.hostname)}&type=CNAME`);
    for (const record of records) {
      if (record.content === `${config.tunnelId}.cfargotunnel.com`) await this.request(`/zones/${config.zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    }
    await this.request(`/accounts/${config.accountId}/cfd_tunnel/${config.tunnelId}`, { method: "DELETE" });
  }

  private async ensureOrganization(accountId: string, teamName: string, created: string[]): Promise<AccessOrganization> {
    try {
      const organization = await this.request<AccessOrganization>(`/accounts/${accountId}/access/organizations`);
      if (organization?.auth_domain) return organization;
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    const organization = await this.request<AccessOrganization>(`/accounts/${accountId}/access/organizations`, {
      method: "POST",
      body: JSON.stringify({ name: "Pi Daemon", auth_domain: `${sanitizeTeamName(teamName)}.cloudflareaccess.com`, is_ui_read_only: false }),
    });
    created.push("Access organization");
    return organization;
  }

  private async ensureOtpProvider(accountId: string, created: string[]): Promise<IdentityProvider> {
    const providers = await this.request<IdentityProvider[]>(`/accounts/${accountId}/access/identity_providers`);
    const existing = providers.find((provider) => provider.type === "onetimepin");
    if (existing) return existing;
    const provider = await this.request<IdentityProvider>(`/accounts/${accountId}/access/identity_providers`, {
      method: "POST",
      body: JSON.stringify({ name: "One-time PIN", type: "onetimepin", config: {} }),
    });
    created.push("One-time PIN identity provider");
    return provider;
  }

  private async ensureTunnel(input: ProvisionInput, created: string[]): Promise<Tunnel> {
    const tunnels = await this.request<Tunnel[]>(`/accounts/${input.accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(input.tunnelName)}`);
    const existing = tunnels.find((tunnel) => tunnel.name === input.tunnelName && !tunnel.deleted_at);
    if (existing) {
      if (!input.previous || input.previous.tunnelId !== existing.id) throw new Error(`Tunnel name conflict: ${input.tunnelName}`);
      if (existing.config_src && existing.config_src !== "cloudflare") throw new Error(`Tunnel ${input.tunnelName} is not remotely managed`);
      return existing;
    }
    const tunnel = await this.request<Tunnel>(`/accounts/${input.accountId}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name: input.tunnelName, config_src: "cloudflare" }),
    });
    created.push(`Tunnel ${input.tunnelName}`);
    return tunnel;
  }

  private async ensureDns(input: ProvisionInput, tunnelId: string, created: string[]): Promise<DnsRecord> {
    const target = `${tunnelId}.cfargotunnel.com`;
    const records = await this.request<DnsRecord[]>(`/zones/${input.zoneId}/dns_records?name=${encodeURIComponent(input.hostname)}&per_page=50`);
    if (records.length) {
      const exact = records.find((record) => record.type === "CNAME" && record.content === target && record.proxied === true);
      if (!exact) throw new Error(`DNS conflict: ${input.hostname} already exists and is not managed by this tunnel`);
      return exact;
    }
    const record = await this.request<DnsRecord>(`/zones/${input.zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "CNAME", name: input.hostname, content: target, ttl: 1, proxied: true }),
    });
    created.push(`DNS ${input.hostname}`);
    return record;
  }

  private async ensureAccessApp(input: ProvisionInput, idpId: string, created: string[]): Promise<AccessApplication> {
    const apps = await this.request<AccessApplication[]>(`/accounts/${input.accountId}/access/apps?per_page=100`);
    const existing = apps.find((app) => app.domain.toLowerCase() === input.hostname.toLowerCase());
    if (existing) {
      if (!input.previous || input.previous.accessAppId !== existing.id || existing.type !== "self_hosted") throw new Error(`Access application conflict: ${input.hostname}`);
      await this.validatePolicy(input, existing, idpId);
      return existing;
    }
    const app = await this.request<AccessApplication>(`/accounts/${input.accountId}/access/apps`, {
      method: "POST",
      body: JSON.stringify({
        name: `Pi Daemon – ${input.hostname}`,
        domain: input.hostname,
        type: "self_hosted",
        session_duration: "24h",
        allowed_idps: [idpId],
        auto_redirect_to_identity: true,
        app_launcher_visible: false,
        policies: [{
          name: "Pi Daemon exact email",
          decision: "allow",
          precedence: 1,
          include: [{ email: { email: input.allowedEmail.toLowerCase() } }],
          require: [{ login_method: { id: idpId } }],
        }],
      }),
    });
    created.push(`Access application ${input.hostname}`);
    return app;
  }

  private async validatePolicy(input: ProvisionInput, app: AccessApplication, idpId: string): Promise<void> {
    const policies = await this.request<AccessPolicy[]>(`/accounts/${input.accountId}/access/apps/${app.id}/policies`);
    const managed = policies.find((policy) => policy.name === "Pi Daemon exact email" && policy.decision === "allow");
    const expectedEmail = input.allowedEmail.toLowerCase();
    const includesEmail = managed?.include?.length === 1 && (managed.include[0] as { email?: { email?: string } }).email?.email?.toLowerCase() === expectedEmail;
    const requiresIdp = managed?.require?.some((rule) => (rule as { login_method?: { id?: string } }).login_method?.id === idpId);
    const otherAllow = policies.some((policy) => policy.decision === "allow" && policy.id !== managed?.id);
    if (!managed || !includesEmail || !requiresIdp || otherAllow) throw new Error(`Existing Access app for ${input.hostname} does not have the expected exclusive exact-email OTP policy`);
  }

  private async ensureTunnelConfiguration(input: ProvisionInput, tunnelId: string, audience: string, authDomain: string): Promise<void> {
    const teamName = new URL(/^https?:\/\//.test(authDomain) ? authDomain : `https://${authDomain}`).hostname.split(".")[0];
    await this.request(`/accounts/${input.accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: { ingress: [
        {
          hostname: input.hostname,
          service: `http://127.0.0.1:${input.localPort}`,
          originRequest: { access: { required: true, teamName, audTag: [audience] } },
        },
        { service: "http_status:404" },
      ] } }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    let envelope: ApiEnvelope<T>;
    try {
      envelope = await response.json() as ApiEnvelope<T>;
    } catch {
      throw new CloudflareApiError(response.status, `Cloudflare API returned ${response.status}`);
    }
    if (!response.ok || !envelope.success) {
      const message = envelope.errors?.map((item) => item.message).filter(Boolean).join("; ") || `Cloudflare API returned ${response.status}`;
      throw new CloudflareApiError(response.status, message);
    }
    return envelope.result;
  }

  private async checkReadable(label: string, path: string, allowMissing = false): Promise<void> {
    try {
      await this.request(path);
    } catch (error) {
      if (allowMissing && error instanceof CloudflareApiError && error.status === 404) return;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`API token cannot access ${label}: ${detail}`);
    }
  }
}

export class CloudflareApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export function validateHostname(hostname: string): void {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) throw new Error("Invalid public hostname");
}

export function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid allowed email");
}

function sanitizeTeamName(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!result) throw new Error("Invalid Cloudflare team name");
  return result;
}
