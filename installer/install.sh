#!/bin/sh
set -eu

VERSION="${PI_DAEMON_VERSION:-0.1.4}"
NODE_VERSION="22.19.0"
PI_VERSION="0.83.0"
CLOUDFLARED_VERSION="2026.7.3"
DAEMON_ASSET="edward40-pi-daemon-${VERSION}.tgz"
RELEASE_BASE="https://github.com/SASUKE40/pi-daemon/releases/download/v${VERSION}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-daemon"
NODE_LINK="$DATA_DIR/node"
PREFIX="$DATA_DIR/npm"
BIN_DIR="$HOME/.local/bin"
TOOLS_DIR="$DATA_DIR/bin"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-daemon-install.XXXXXX")"

cleanup() {
  rm -r "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'pi-daemon installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) PLATFORM="darwin-arm64"; NODE_ASSET="node-v${NODE_VERSION}-darwin-arm64.tar.gz"; CF_ASSET="cloudflared-darwin-arm64.tgz" ;;
  Darwin/x86_64) PLATFORM="darwin-x64"; NODE_ASSET="node-v${NODE_VERSION}-darwin-x64.tar.gz"; CF_ASSET="cloudflared-darwin-amd64.tgz" ;;
  Linux/aarch64|Linux/arm64) PLATFORM="linux-arm64"; NODE_ASSET="node-v${NODE_VERSION}-linux-arm64.tar.gz"; CF_ASSET="cloudflared-linux-arm64" ;;
  Linux/x86_64|Linux/amd64) PLATFORM="linux-x64"; NODE_ASSET="node-v${NODE_VERSION}-linux-x64.tar.gz"; CF_ASSET="cloudflared-linux-amd64" ;;
  *) fail "unsupported platform $OS/$ARCH" ;;
esac

if [ "$OS" = "Linux" ]; then
  getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail "Linux support requires glibc"
fi

mkdir -p "$PREFIX" "$BIN_DIR" "$TOOLS_DIR"

checksums_downloaded=false
ensure_checksums() {
  if [ "$checksums_downloaded" = false ]; then
    curl -fsSL "$RELEASE_BASE/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS"
    checksums_downloaded=true
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

verify_asset() {
  asset="$1"
  ensure_checksums
  expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$TMP_DIR/SHA256SUMS")"
  [ -n "$expected" ] || fail "no checksum published for $asset"
  actual="$(sha256_file "$TMP_DIR/$asset")"
  [ "$actual" = "$expected" ] || fail "checksum verification failed for $asset"
}

existing_node="$(command -v node 2>/dev/null || true)"
existing_npm="$(command -v npm 2>/dev/null || true)"
SELECTED_NODE=""
SELECTED_NPM=""
if [ -n "$existing_node" ] && [ -n "$existing_npm" ] &&
  "$existing_node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19))process.exit(1)' >/dev/null 2>&1; then
  SELECTED_NODE="$existing_node"
  SELECTED_NPM="$existing_npm"
  printf 'Found compatible Node.js at %s; skipping Node.js installation.\n' "$SELECTED_NODE"
else
  NODE_DIR="$DATA_DIR/node-${NODE_VERSION}-${PLATFORM}"
  if [ -x "$NODE_DIR/bin/node" ] && [ -x "$NODE_DIR/bin/npm" ]; then
    printf 'Found managed Node.js %s; skipping Node.js installation.\n' "$NODE_VERSION"
  else
    printf 'Installing managed Node.js %s…\n' "$NODE_VERSION"
    [ ! -e "$NODE_DIR" ] || fail "incomplete managed Node runtime at $NODE_DIR"
    curl -fsSL "$RELEASE_BASE/$NODE_ASSET" -o "$TMP_DIR/$NODE_ASSET"
    verify_asset "$NODE_ASSET"
    mkdir -p "$TMP_DIR/node-unpack"
    tar -xzf "$TMP_DIR/$NODE_ASSET" -C "$TMP_DIR/node-unpack"
    extracted_node="$(find "$TMP_DIR/node-unpack" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    [ -n "$extracted_node" ] && [ -x "$extracted_node/bin/node" ] && [ -x "$extracted_node/bin/npm" ] || fail "managed Node archive is invalid"
    mv "$extracted_node" "$NODE_DIR"
  fi
  ln -sfn "$NODE_DIR" "$NODE_LINK"
  SELECTED_NODE="$NODE_LINK/bin/node"
  SELECTED_NPM="$NODE_LINK/bin/npm"
fi
RUNTIME_BIN="$(dirname "$SELECTED_NODE")"
PATH="$RUNTIME_BIN:$PATH"
export PATH
"$SELECTED_NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19))process.exit(1)' || fail "Node.js >=22.19.0 is required"

existing_pi="$(command -v pi 2>/dev/null || true)"
compatible_pi=""
for candidate in "$existing_pi" "$BIN_DIR/pi" "$PREFIX/bin/pi"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  case "$("$candidate" --version 2>/dev/null || true)" in
    *"$PI_VERSION"*) compatible_pi="$candidate"; break ;;
  esac
done

existing_daemon="$(command -v pi-daemon 2>/dev/null || true)"
compatible_daemon=""
for candidate in "$existing_daemon" "$BIN_DIR/pi-daemon" "$PREFIX/bin/pi-daemon"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  case "$("$candidate" --version 2>/dev/null || true)" in
    *"$VERSION"*) compatible_daemon="$candidate"; break ;;
  esac
done

install_pi=false
install_daemon=false
if [ -n "$compatible_pi" ]; then
  SELECTED_PI="$compatible_pi"
  printf 'Found compatible Pi %s at %s; skipping Pi installation.\n' "$PI_VERSION" "$SELECTED_PI"
else
  install_pi=true
fi
if [ -n "$compatible_daemon" ]; then
  SELECTED_DAEMON="$compatible_daemon"
  printf 'Found compatible Pi Daemon %s at %s; skipping Pi Daemon installation.\n' "$VERSION" "$SELECTED_DAEMON"
else
  install_daemon=true
fi

if [ "$install_daemon" = true ]; then
  printf 'Installing Pi Daemon %s…\n' "$VERSION"
  curl -fsSL "$RELEASE_BASE/$DAEMON_ASSET" -o "$TMP_DIR/$DAEMON_ASSET"
  verify_asset "$DAEMON_ASSET"
fi
if [ "$install_pi" = true ]; then
  printf 'Installing Pi %s…\n' "$PI_VERSION"
fi
if [ "$install_daemon" = true ] && [ "$install_pi" = true ]; then
  "$SELECTED_NPM" install --global --prefix "$PREFIX" --ignore-scripts \
    "$TMP_DIR/$DAEMON_ASSET" \
    "@earendil-works/pi-coding-agent@$PI_VERSION"
elif [ "$install_daemon" = true ]; then
  "$SELECTED_NPM" install --global --prefix "$PREFIX" --ignore-scripts "$TMP_DIR/$DAEMON_ASSET"
elif [ "$install_pi" = true ]; then
  "$SELECTED_NPM" install --global --prefix "$PREFIX" --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
fi

if [ "$install_daemon" = true ]; then
  if [ -e "$BIN_DIR/pi-daemon" ] || [ -L "$BIN_DIR/pi-daemon" ]; then
    mv "$BIN_DIR/pi-daemon" "$TMP_DIR/pi-daemon.previous"
  fi
  printf '#!/bin/sh\nPATH="%s:$PATH"\nexport PATH\nexec "%s" "$@"\n' "$RUNTIME_BIN" "$PREFIX/bin/pi-daemon" > "$BIN_DIR/pi-daemon"
  chmod 755 "$BIN_DIR/pi-daemon"
  SELECTED_DAEMON="$BIN_DIR/pi-daemon"
fi
if [ "$install_pi" = true ]; then
  SELECTED_PI="$PREFIX/bin/pi"
  if [ -e "$BIN_DIR/pi" ] || [ -L "$BIN_DIR/pi" ]; then
    mv "$BIN_DIR/pi" "$TMP_DIR/pi.previous"
  fi
  printf '#!/bin/sh\nPATH="%s:$PATH"\nexport PATH\nexec "%s" "$@"\n' "$RUNTIME_BIN" "$SELECTED_PI" > "$BIN_DIR/pi"
  chmod 755 "$BIN_DIR/pi"
  [ -z "$existing_pi" ] || printf 'Existing Pi is not %s; exposing the managed Pi at %s/pi.\n' "$PI_VERSION" "$BIN_DIR"
fi

existing_cloudflared="$(command -v cloudflared 2>/dev/null || true)"
if [ -z "$existing_cloudflared" ] && [ -x "$TOOLS_DIR/cloudflared" ]; then
  existing_cloudflared="$TOOLS_DIR/cloudflared"
fi

if [ -n "$existing_cloudflared" ]; then
  CF_BIN="$existing_cloudflared"
  printf 'Found cloudflared at %s; skipping cloudflared installation.\n' "$CF_BIN"
else
  printf 'Installing cloudflared %s…\n' "$CLOUDFLARED_VERSION"
  curl -fsSL "$RELEASE_BASE/$CF_ASSET" -o "$TMP_DIR/$CF_ASSET"
  verify_asset "$CF_ASSET"
  if [ "$OS" = "Darwin" ]; then
    tar -xzf "$TMP_DIR/$CF_ASSET" -C "$TMP_DIR"
    found="$(find "$TMP_DIR" -type f -name cloudflared -print -quit)"
    [ -n "$found" ] || fail "cloudflared archive is invalid"
    cp "$found" "$TOOLS_DIR/cloudflared"
  else
    cp "$TMP_DIR/$CF_ASSET" "$TOOLS_DIR/cloudflared"
  fi
  chmod 755 "$TOOLS_DIR/cloudflared"
  CF_BIN="$TOOLS_DIR/cloudflared"
fi

printf '\nStarting on-board Pi and Cloudflare login…\n'
PATH="$RUNTIME_BIN:$BIN_DIR:$PREFIX/bin:$PATH" PI_DAEMON_PI="$SELECTED_PI" PI_DAEMON_CLOUDFLARED="$CF_BIN" "$SELECTED_DAEMON" setup --from-installer </dev/tty >/dev/tty

printf '\nReady. Management command: %s\n' "$SELECTED_DAEMON"
