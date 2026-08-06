import type { IncomingHttpHeaders } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { PiDaemonConfig } from "./config.js";

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
  if (config.cloudflare) origins.add(`https://${config.cloudflare.hostname}`);
  return origins;
}

export class AccessAuthorizer {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private jwksUrl?: string;

  constructor(private readonly config: PiDaemonConfig, private readonly verificationKey?: JWTVerifyGetKey) {}

  async authorize(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity> {
    const host = hostnameFromHeaders(headers);
    if (isLoopbackHost(host)) return { local: true };
    const cloudflare = this.config.cloudflare;
    if (!cloudflare || host !== cloudflare.hostname.toLowerCase()) throw new Error("Unrecognized host");
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
