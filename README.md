# Pi Daemon

Pi Daemon runs the [Pi coding agent](https://github.com/earendil-works/pi) in a persistent server session, serves a focused mobile PWA on loopback, and publishes it through a named Cloudflare Tunnel protected by an exact-email Access policy.

> **Security:** An authenticated mobile user can invoke Pi's coding tools, execute commands, and modify files without per-action confirmation. Use a dedicated Cloudflare hostname, protect the email account used for OTP, and do not run the service on a machine you are unwilling to control remotely.

## One-line installation

```sh
curl -fsSL https://github.com/SASUKE40/pi-daemon/releases/latest/download/install.sh | sh
```

Prerequisites:

- `curl` and `tar` (the installer provides its own Node.js 22.19.0/npm runtime without root)
- macOS 13+ on arm64/x64, or glibc Linux arm64/x64
- A Cloudflare-managed DNS zone and a scoped API token

The wizard installs the checksummed Pi Daemon web package from the GitHub release, Node.js `22.19.0`, Pi `0.83.0`, cloudflared `2026.7.3`, and three user-level services. Before installing, it checks for compatible Node.js/npm, Pi, and Pi Daemon commands and reuses each one it finds instead of reinstalling it; when Node.js is missing or too old, it provides a managed runtime without root. Pi provider setup and Cloudflare login then run interactively on the board; on a headless board, open the displayed browser links on another device and paste the resulting scoped Cloudflare API token into the board terminal. The installer never stores that API token. The tunnel connector token is saved in a mode-0600 file and passed to cloudflared with `--token-file`, never on the process command line.

## Architecture

```text
Mobile PWA ── Cloudflare Access ── Tunnel ── 127.0.0.1:8504 web gateway
                                                        │ mode-0600 Unix socket
                                                        ▼
                                              long-lived Pi session daemon
                                                        │
                                              ~/.pi/agent sessions/auth
```

Closing the browser or restarting the web gateway does not stop the Pi run. Restarting the session daemon or rebooting necessarily terminates an in-flight model/tool call, but the append-only session remains resumable. V1 keeps multiple saved sessions and permits one active run globally.

On macOS the components run as LaunchAgents; on Linux they run as systemd user services. The release is web-only and does not ship Electron or desktop-control tooling.

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

The default uninstall removes only Pi Daemon services and daemon configuration. It preserves `~/.pi/agent` authentication and sessions and leaves Cloudflare resources intact. Deleting Cloudflare resources requires the explicit flag, confirmation, and a freshly entered API token.

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

Tagged releases build the web package on Ubuntu, attach it directly to the GitHub release, mirror the pinned Node.js and cloudflared assets, and publish SHA-256 checksums plus the installer. No Apple or npm publishing credentials are required.

## Operational notes

- Prevent system sleep separately if the machine must remain reachable; Pi Daemon does not change power-management settings.
- If a tunnel token is exposed, rotate it in Cloudflare before starting the connector.
- Existing system/root cloudflared services are not modified; Pi Daemon installs a separate user connector.
