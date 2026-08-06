# Pi Daemon

Pi Daemon runs the [Pi coding agent](https://github.com/earendil-works/pi) in a persistent desktop session, serves a focused mobile PWA on loopback, and publishes it through a named Cloudflare Tunnel protected by an exact-email Access policy.

> **Security:** An authenticated mobile user can invoke Pi's bash/edit tools and control the visible desktop without per-action confirmation. Use a dedicated Cloudflare hostname, protect the email account used for OTP, and do not run the service on a machine you are unwilling to control remotely.

## One-line installation

After the first signed release is published:

```sh
curl -fsSL https://github.com/SASUKE40/pi-daemon/releases/latest/download/install.sh | sh
```

Prerequisites:

- `curl` and `tar` (the installer provides its own Node.js 22.19.0/npm runtime without root)
- macOS 13+ on arm64/x64, or glibc Linux arm64/x64
- An active, unlocked graphical login session
- A Cloudflare-managed DNS zone and a scoped API token
- On macOS, approval for the signed `Pi Daemon.app` under Accessibility and Screen Recording

The wizard installs a managed Node.js `22.19.0` runtime, Pi `0.83.0`, `@edward40/pi-computer-use` `0.1.1`, cloudflared `2026.7.3`, the signed macOS host when applicable, and three user-level services. It preserves a compatible existing Pi command and otherwise exposes the managed CLI. It never stores the scoped Cloudflare API token. The tunnel connector token is saved in a mode-0600 file and passed to cloudflared with `--token-file`, never on the process command line.

## Architecture

```text
Mobile PWA ── Cloudflare Access ── Tunnel ── 127.0.0.1:8504 web gateway
                                                        │ mode-0600 Unix socket
                                                        ▼
                                              long-lived Pi session daemon
                                                        │
                                              ~/.pi/agent sessions/auth
```

Closing the browser or restarting the web gateway does not stop the Pi run. Restarting the session daemon or rebooting necessarily terminates an in-flight model/tool call, but the append-only session remains resumable. V1 keeps multiple saved sessions and permits one active run globally so two agents cannot fight over the same desktop.

On macOS, the signed, notarized, no-Dock Electron host owns the session daemon and the TCC responsibility chain required by Cua Driver. On Linux, a systemd user service is tied to the active graphical session and captures its X11/Wayland environment.

## Commands

```text
pi-daemon setup
pi-daemon status
pi-daemon doctor
pi-daemon logs [sessiond|web|tunnel|all]
pi-daemon restart [sessiond|web|tunnel|all]
pi-daemon update
pi-daemon uninstall
pi-daemon uninstall --delete-cloudflare
```

The default uninstall removes only Pi Daemon services, the signed host, and daemon configuration. It preserves `~/.pi/agent` authentication and sessions and leaves Cloudflare resources intact. Deleting Cloudflare resources requires the explicit flag, confirmation, and a freshly entered API token.

## Cloudflare API token permissions

Scope the token to one account and one DNS zone with:

- Account and Zone Read
- Cloudflare Tunnel / Cloudflare One Connectors Write
- DNS Write
- Access Apps and Policies Write
- Access Organizations, Identity Providers, and Groups Write

The wizard creates or validates one remotely managed tunnel, one proxied CNAME, one self-hosted Access application, and an Allow policy containing the exact email plus a required One-time PIN login method. It refuses to overwrite conflicting DNS or Access resources.

## Development

```sh
npm install
npm run check
```

For local testing, create `~/.config/pi-daemon/config.json` or run the setup wizard, start `npm run dev:sessiond`, then run the built web server. The server always binds to `127.0.0.1`; loopback requests are allowed without Cloudflare, while requests using the configured public Host must carry a valid `Cf-Access-Jwt-Assertion`.

macOS packaging requires a Developer ID Application certificate plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Tagged releases publish the npm package with provenance, build and notarize both macOS architectures, mirror the pinned cloudflared assets, produce SHA-256 checksums, and attach the installer.

## Operational notes

- Keep the visible desktop unlocked for the `computer` tool. Locking it produces a tool error but leaves non-GUI Pi work running.
- Prevent system sleep separately if the machine must remain reachable; Pi Daemon does not change power-management settings.
- If a tunnel token is exposed, rotate it in Cloudflare before starting the connector.
- Existing system/root cloudflared services are not modified; Pi Daemon installs a separate user connector.
