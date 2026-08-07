/**
 * Public OAuth metadata is safe to ship in the CLI. Set these values after the
 * project OAuth callback relay and public Cloudflare OAuth client are created.
 * Environment variables with the same fields override these release defaults.
 */
export const CLOUDFLARE_OAUTH_DEFAULTS = {
  clientId: "",
  relayUrl: "",
  redirectUri: "",
} as const;
