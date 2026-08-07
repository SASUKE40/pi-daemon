/**
 * Public OAuth metadata is safe to ship in the CLI. Set these values after the
 * project OAuth callback relay and public Cloudflare OAuth client are created.
 * Environment variables with the same fields override these release defaults.
 */
export const CLOUDFLARE_OAUTH_DEFAULTS = {
  clientId: "eb36f8ba635473b58f875d14bd8656ac",
  relayUrl: "https://pi-daemon-oauth-relay.sasuke688848.workers.dev",
  redirectUri: "https://pi-daemon-oauth-relay.sasuke688848.workers.dev/callback",
  scopes: [
    "dns.write",
    "zone.read",
    "zone-access.write",
    "access-acct.write",
    "argotunnel.write",
    "account-settings.read",
  ],
} as const;
