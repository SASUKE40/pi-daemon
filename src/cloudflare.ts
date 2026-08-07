import type { CloudflareConfig, CloudflareGitHubAccess } from "./config.js";

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
export interface IdentityProvider { id: string; name: string; type: string }
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
  auto_redirect_to_identity?: boolean;
  app_launcher_visible?: boolean;
  session_duration?: string;
}

export interface ProvisionInput {
  accountId: string;
  zoneId: string;
  hostname: string;
  access: CloudflareGitHubAccess;
  teamName: string;
  tunnelName: string;
  localPort: number;
  previous?: CloudflareConfig;
  adoptExisting?: boolean;
}

export interface ProvisionResult {
  config: CloudflareConfig;
  tunnelToken: string;
  created: string[];
}

export class TunnelNameConflictError extends Error {
  constructor(readonly tunnelName: string) {
    super(`Tunnel name conflict: ${tunnelName}`);
    this.name = "TunnelNameConflictError";
  }
}

export class CloudflareClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (!token) throw new Error("Cloudflare API credential is required");
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
    validateGitHubOrganization(input.access.organization);
    if (input.access.team) validateGitHubTeam(input.access.team);
    const created: string[] = [];
    const organization = await this.ensureOrganization(input.accountId, input.teamName, created);
    const idp = await this.requireGitHubProvider(input.accountId, input.access.identityProviderId);
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
        access: {
          type: "github",
          identityProviderId: idp.id,
          identityProviderName: idp.name,
          organization: input.access.organization,
          ...(input.access.team ? { team: input.access.team } : {}),
        },
      },
    };
  }

  async githubIdentityProviders(accountId: string): Promise<IdentityProvider[]> {
    try {
      const providers = await this.request<IdentityProvider[]>(`/accounts/${accountId}/access/identity_providers`);
      return providers.filter((provider) => provider.type === "github");
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return [];
      throw error;
    }
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

  private async requireGitHubProvider(accountId: string, identityProviderId: string): Promise<IdentityProvider> {
    const provider = (await this.githubIdentityProviders(accountId)).find((item) => item.id === identityProviderId);
    if (!provider) throw new Error("The selected GitHub identity provider is no longer configured in Cloudflare Access");
    return provider;
  }

  private async ensureTunnel(input: ProvisionInput, created: string[]): Promise<Tunnel> {
    const tunnels = await this.request<Tunnel[]>(`/accounts/${input.accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(input.tunnelName)}`);
    const existing = tunnels.find((tunnel) => tunnel.name === input.tunnelName && !tunnel.deleted_at);
    if (existing) {
      if (existing.config_src && existing.config_src !== "cloudflare") throw new Error(`Tunnel ${input.tunnelName} is not remotely managed`);
      if ((!input.previous || input.previous.tunnelId !== existing.id) && !input.adoptExisting) throw new TunnelNameConflictError(input.tunnelName);
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
      if (existing.type !== "self_hosted" || ((!input.previous || input.previous.accessAppId !== existing.id) && !input.adoptExisting)) throw new Error(`Access application conflict: ${input.hostname}`);
      await this.ensureGitHubPolicy(input, existing, idpId, created);
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
        policies: [githubPolicy(input.access, idpId)],
      }),
    });
    created.push(`Access application ${input.hostname}`);
    return app;
  }

  private async ensureGitHubPolicy(input: ProvisionInput, app: AccessApplication, idpId: string, changed: string[]): Promise<void> {
    const policies = await this.request<AccessPolicy[]>(`/accounts/${input.accountId}/access/apps/${app.id}/policies`);
    const managed = policies.find((policy) => policy.name === "Pi Daemon GitHub organization" && policy.decision === "allow");
    const otherAllow = policies.some((policy) => policy.decision === "allow" && policy.id !== managed?.id);
    if (managed && matchesGitHubPolicy(managed, input.access, idpId) && !otherAllow) {
      if (!matchesGitHubApp(app, idpId)) {
        if (!input.previous || input.previous.accessAppId !== app.id) throw new Error(`Existing Access app for ${input.hostname} is not restricted to the selected GitHub login`);
        await this.updateAccessApp(input.accountId, app, idpId);
        changed.push("GitHub login for Access application");
      }
      return;
    }

    const legacy = policies.find((policy) => policy.name === "Pi Daemon exact email" && policy.decision === "allow");
    const legacyEmail = input.previous?.allowedEmail;
    const legacyMatches = Boolean(legacy && legacyEmail && legacy.include?.length === 1
      && (legacy.include[0] as { email?: { email?: string } }).email?.email?.toLowerCase() === legacyEmail.toLowerCase()
      && legacy.require?.some((rule) => Boolean((rule as { login_method?: { id?: string } }).login_method?.id)));
    const otherLegacyAllow = policies.some((policy) => policy.decision === "allow" && policy.id !== legacy?.id);
    if (!legacy || !legacyMatches || otherLegacyAllow || !input.previous || input.previous.accessAppId !== app.id) {
      throw new Error(`Existing Access app for ${input.hostname} does not have the expected exclusive GitHub organization policy`);
    }

    await this.request(`/accounts/${input.accountId}/access/apps/${app.id}/policies/${legacy.id}`, {
      method: "PUT",
      body: JSON.stringify(githubPolicy(input.access, idpId)),
    });
    await this.updateAccessApp(input.accountId, app, idpId);
    changed.push("Access policy migrated from email OTP to GitHub");
  }

  private async updateAccessApp(accountId: string, app: AccessApplication, idpId: string): Promise<void> {
    await this.request(`/accounts/${accountId}/access/apps/${app.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: app.name,
        domain: app.domain,
        type: app.type,
        session_duration: app.session_duration || "24h",
        allowed_idps: [idpId],
        auto_redirect_to_identity: true,
        app_launcher_visible: app.app_launcher_visible ?? false,
      }),
    });
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
    const method = init.method || "GET";
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
      throw new CloudflareApiError(response.status, `${method} ${path}: Cloudflare API returned ${response.status}`);
    }
    if (!response.ok || !envelope.success) {
      const message = envelope.errors?.map((item) => item.message).filter(Boolean).join("; ") || `Cloudflare API returned ${response.status}`;
      throw new CloudflareApiError(response.status, `${method} ${path}: ${message}`);
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

export function validateGitHubOrganization(organization: string): void {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(organization)) throw new Error("Invalid GitHub organization");
}

export function validateGitHubTeam(team: string): void {
  if (!/^[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i.test(team)) throw new Error("Invalid GitHub team slug");
}

function githubPolicy(access: CloudflareGitHubAccess, idpId: string): Record<string, unknown> {
  return {
    name: "Pi Daemon GitHub organization",
    decision: "allow",
    precedence: 1,
    include: [{ "github-organization": {
      name: access.organization,
      identity_provider_id: idpId,
      ...(access.team ? { team: access.team } : {}),
    } }],
    require: [{ login_method: { id: idpId } }],
  };
}

function matchesGitHubPolicy(policy: AccessPolicy, access: CloudflareGitHubAccess, idpId: string): boolean {
  const organization = policy.include?.length === 1
    ? (policy.include[0] as { "github-organization"?: { name?: string; team?: string; identity_provider_id?: string } })["github-organization"]
    : undefined;
  return organization?.name?.toLowerCase() === access.organization.toLowerCase()
    && (organization.team || undefined)?.toLowerCase() === (access.team || undefined)?.toLowerCase()
    && organization.identity_provider_id === idpId
    && Boolean(policy.require?.some((rule) => (rule as { login_method?: { id?: string } }).login_method?.id === idpId));
}

function matchesGitHubApp(app: AccessApplication, idpId: string): boolean {
  return app.allowed_idps?.length === 1 && app.allowed_idps[0] === idpId && app.auto_redirect_to_identity === true;
}

function sanitizeTeamName(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!result) throw new Error("Invalid Cloudflare team name");
  return result;
}
