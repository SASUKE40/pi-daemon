# Pi Daemon Cloudflare OAuth relay

This Worker bridges Cloudflare's browser redirect back to a headless `pi-daemon setup` process. It stores an authorization code for at most five minutes in a Durable Object. The CLI keeps both the PKCE verifier and a separate polling secret, so the relay cannot exchange the code for a Cloudflare access token.

## Deploy the relay

1. Install the pinned Wrangler dependency, sign in when prompted, and deploy the Worker and Durable Object:

   ```sh
   npm install
   npm run deploy
   ```

2. Give the Worker a stable HTTPS custom domain, such as `https://connect.example.com`, and verify that `https://connect.example.com/healthz` returns `{"ok":true}`. Keep this hostname stable after publishing a release because released CLIs contain the relay and redirect URLs.

## Register the OAuth client

In **Cloudflare > Manage Account > OAuth clients**, create a client for a browser, desktop, or CLI application. Cloudflare's current [OAuth client guide](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) requires a client name, logo, client URL, and scopes before a client can be public.

Configure:

- Response type and grant type: Authorization Code
- Token endpoint authentication method: None
- PKCE: required, using S256
- Redirect URL: `https://connect.example.com/callback`
- A client URL on a domain you control

Select these scopes:

- Account Settings Read
- Cloudflare Tunnel Write
- Access: Apps and Policies Write
- Access: Organizations, Identity Providers, and Groups Write
- Zone Read
- DNS Write

New clients are private. A private client can be used only by members of the Cloudflare account that owns it. Before making the client public, complete Cloudflare's client-URL domain verification. Changing visibility to public is permanent, so verify the redirect URL and scopes first.

## Configure Pi Daemon

Put the public client metadata in `src/cloudflare-oauth-defaults.ts` before building a release. The client ID and URLs are public metadata; do not add a client secret because this is a PKCE public client.

For development, override the release defaults without editing the source:

```sh
export PI_DAEMON_CLOUDFLARE_OAUTH_CLIENT_ID='...'
export PI_DAEMON_CLOUDFLARE_OAUTH_RELAY_URL='https://connect.example.com'
export PI_DAEMON_CLOUDFLARE_OAUTH_REDIRECT_URI='https://connect.example.com/callback'
```

`PI_DAEMON_CLOUDFLARE_OAUTH_SCOPES` may override the OAuth scope IDs with a space-separated list. When omitted, the CLI sends the scope IDs in `src/cloudflare-oauth-defaults.ts`; keep that list synchronized with the public client's registered scopes.

Run `pi-daemon setup` against a test account and zone before publishing. Confirm that the consent page lists the intended scopes, the terminal continues after the browser reports **Cloudflare connected**, and the setup token is revoked at completion.

## Security model

The Worker stores no access tokens, refresh tokens, PKCE verifiers, API tokens, account IDs, zone IDs, email addresses, or tunnel credentials. It returns `204` while authorization is pending and deletes each session when the CLI consumes it or its five-minute alarm expires.

The relay receives only the authorization code and cannot exchange it by itself: the CLI retains the per-attempt PKCE verifier. Polling and deletion also require a separate random secret whose SHA-256 hash is stored by the Durable Object. API responses disable caching; callback pages also disable framing, MIME sniffing, and referrer disclosure.
