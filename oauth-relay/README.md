# Pi Daemon Cloudflare OAuth relay

This Worker bridges Cloudflare's browser redirect back to a headless `pi-daemon setup` process. It stores an authorization code for at most five minutes in a Durable Object. The CLI keeps both the PKCE verifier and a separate polling secret, so the relay cannot exchange the code for a Cloudflare access token.

## One-time deployment

1. Install and deploy the Worker:

   ```sh
   npm install
   npm run deploy
   ```

2. Give the Worker a stable HTTPS custom domain, such as `https://connect.example.com`.

3. In **Cloudflare > Manage Account > OAuth clients**, create a client with:

   - Response type: Authorization Code
   - Grant type: Authorization Code
   - Token authentication method: None
   - PKCE: S256
   - Redirect URL: `https://connect.example.com/callback`
   - Public visibility, after verifying the client URL domain

4. Select the permissions Pi Daemon already needs:

   - Account Settings Read
   - Cloudflare Tunnel Write
   - Access: Apps and Policies Write
   - Access: Organizations, Identity Providers, and Groups Write
   - Zone Read
   - DNS Write

5. Put the public client metadata in `src/cloudflare-oauth-defaults.ts` before building a release. For development, the same fields can be overridden without rebuilding:

   ```sh
   export PI_DAEMON_CLOUDFLARE_OAUTH_CLIENT_ID='...'
   export PI_DAEMON_CLOUDFLARE_OAUTH_RELAY_URL='https://connect.example.com'
   export PI_DAEMON_CLOUDFLARE_OAUTH_REDIRECT_URI='https://connect.example.com/callback'
   ```

`PI_DAEMON_CLOUDFLARE_OAUTH_SCOPES` may optionally contain the registered OAuth scope IDs separated by spaces. When omitted, Cloudflare uses the scopes registered on the client.

The Worker stores no access tokens, refresh tokens, PKCE verifiers, API tokens, account IDs, zone IDs, email addresses, or tunnel credentials. It returns `204` while authorization is pending and deletes each session when the CLI consumes it or its five-minute alarm expires.
