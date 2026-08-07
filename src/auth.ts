import type { IncomingHttpHeaders } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { activeRelay, publicHostname, type PiDaemonConfig } from "./config.js";

export interface AuthenticatedIdentity {
  local: boolean;
  email?: string;
  claims?: JWTPayload;
}

export function hostnameFromHeaders(headers: IncomingHttpHeaders): string {
  return String(headers.host || "").toLowerCase().replace(/\.$/, "");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized.startsWith("localhost:") || normalized === "127.0.0.1" || normalized.startsWith("127.0.0.1:");
}

export function allowedOrigins(config: PiDaemonConfig): Set<string> {
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  const hostname = publicHostname(config);
  if (hostname) origins.add(`https://${hostname}`);
  return origins;
}

export class AccessAuthorizer {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private jwksUrl?: string;

  constructor(private readonly config: PiDaemonConfig, private readonly verificationKey?: JWTVerifyGetKey) {}

  async authorize(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity> {
    const host = hostnameFromHeaders(headers);
    if (isLoopbackHost(host)) return { local: true };
    if (activeRelay(this.config) === "tailscale") {
      const tailscale = this.config.tailscale;
      if (!tailscale || host !== tailscale.hostname.toLowerCase()) throw new Error("Unrecognized host");
      const rawLogin = headers["tailscale-user-login"];
      const login = (Array.isArray(rawLogin) ? rawLogin[0] : rawLogin)?.trim().toLowerCase();
      if (!login) throw new Error("Missing Tailscale identity");
      if (login !== tailscale.allowedLogin.toLowerCase()) throw new Error("Tailscale identity is not allowed");
      return { local: false, email: login };
    }
    const cloudflare = this.config.cloudflare;
    if (activeRelay(this.config) !== "cloudflare" || !cloudflare || host !== cloudflare.hostname.toLowerCase()) throw new Error("Unrecognized host");
    const raw = headers["cf-access-jwt-assertion"];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token) throw new Error("Missing Cloudflare Access assertion");
    const issuer = normalizeTeamDomain(cloudflare.teamDomain);
    const url = `${issuer}/cdn-cgi/access/certs`;
    if (!this.verificationKey && (!this.jwks || this.jwksUrl !== url)) {
      this.jwks = createRemoteJWKSet(new URL(url));
      this.jwksUrl = url;
    }
    const key = this.verificationKey || this.jwks;
    if (!key) throw new Error("Cloudflare signing keys are unavailable");
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["RS256"],
      issuer,
      audience: cloudflare.audience,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
    if (!email || email !== cloudflare.allowedEmail.toLowerCase()) throw new Error("Cloudflare identity is not allowed");
    return { local: false, email, claims: payload };
  }
}

export function normalizeTeamDomain(input: string): string {
  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "https:") throw new Error("Cloudflare team domain must use HTTPS");
  return url.origin;
}
