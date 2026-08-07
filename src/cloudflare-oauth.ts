import { createHash, randomBytes } from "node:crypto";
import { CLOUDFLARE_OAUTH_DEFAULTS } from "./cloudflare-oauth-defaults.js";

const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface CloudflareOAuthConfig {
  clientId: string;
  redirectUri: string;
  relayUrl: string;
  scopes?: string[];
}

export interface CloudflareOAuthSession {
  accessToken: string;
  revoke(): Promise<void>;
}

interface OAuthTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface RelayResult {
  code?: string;
  error?: string;
  errorDescription?: string;
}

interface AuthorizeOptions {
  fetcher?: typeof fetch;
  onAuthorizationUrl(url: string): void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export function cloudflareOAuthConfig(environment: NodeJS.ProcessEnv = process.env): CloudflareOAuthConfig | undefined {
  const clientId = environment.PI_DAEMON_CLOUDFLARE_OAUTH_CLIENT_ID?.trim() || CLOUDFLARE_OAUTH_DEFAULTS.clientId;
  const relayUrl = environment.PI_DAEMON_CLOUDFLARE_OAUTH_RELAY_URL?.trim() || CLOUDFLARE_OAUTH_DEFAULTS.relayUrl;
  const redirectUri = environment.PI_DAEMON_CLOUDFLARE_OAUTH_REDIRECT_URI?.trim() || CLOUDFLARE_OAUTH_DEFAULTS.redirectUri;
  const configured = [clientId, relayUrl, redirectUri].filter(Boolean).length;
  if (!configured) return undefined;
  if (configured !== 3) throw new Error("Cloudflare OAuth requires client ID, relay URL, and redirect URI");
  const parsedRelay = new URL(relayUrl as string);
  const parsedRedirect = new URL(redirectUri as string);
  if (parsedRelay.protocol !== "https:" || parsedRedirect.protocol !== "https:") throw new Error("Cloudflare OAuth URLs must use HTTPS");
  const scopes = environment.PI_DAEMON_CLOUDFLARE_OAUTH_SCOPES?.split(/\s+/).filter(Boolean);
  return {
    clientId: clientId as string,
    relayUrl: parsedRelay.toString().replace(/\/$/, ""),
    redirectUri: parsedRedirect.toString(),
    ...(scopes?.length ? { scopes } : {}),
  };
}

export async function authorizeCloudflare(
  config: CloudflareOAuthConfig,
  options: AuthorizeOptions,
): Promise<CloudflareOAuthSession> {
  const fetcher = options.fetcher || fetch;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));
  const pollSecret = base64url(randomBytes(32));
  const pollSecretHash = createHash("sha256").update(pollSecret).digest("hex");
  const sessionUrl = `${config.relayUrl}/sessions/${state}`;

  const created = await fetcher(`${config.relayUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, pollSecretHash }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!created.ok) throw new Error(`Cloudflare OAuth relay could not start a session (${created.status})`);

  const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (config.scopes?.length) authorizationUrl.searchParams.set("scope", config.scopes.join(" "));
  let result: RelayResult | undefined;
  const timeoutAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    options.onAuthorizationUrl(authorizationUrl.toString());
    while (Date.now() < timeoutAt) {
      const response = await fetcher(sessionUrl, {
        headers: { Authorization: `Bearer ${pollSecret}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 204) {
        await delay(options.pollIntervalMs ?? 1_000);
        continue;
      }
      if (!response.ok) throw new Error(`Cloudflare OAuth relay returned ${response.status}`);
      result = await response.json() as RelayResult;
      break;
    }
    if (!result) throw new Error("Cloudflare authorization timed out");
    if (result.error) throw new Error(result.errorDescription || result.error);
    if (!result.code) throw new Error("Cloudflare OAuth relay returned no authorization code");

    const tokenResponse = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code: result.code,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const token = await tokenResponse.json() as OAuthTokenResponse;
    if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || token.error || `Cloudflare token exchange failed (${tokenResponse.status})`);
    let active = true;
    return {
      accessToken: token.access_token,
      async revoke(): Promise<void> {
        if (!active) return;
        active = false;
        const response = await fetcher(REVOKE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: token.access_token as string, client_id: config.clientId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Cloudflare OAuth revocation failed (${response.status})`);
      },
    };
  } finally {
    await fetcher(sessionUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${pollSecret}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
