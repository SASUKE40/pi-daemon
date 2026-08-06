#!/bin/sh
set -eu

VERSION="${PI_DAEMON_VERSION:-0.1.2}"
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

curl -fsSL "$RELEASE_BASE/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS"
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
  expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$TMP_DIR/SHA256SUMS")"
  [ -n "$expected" ] || fail "no checksum published for $asset"
  actual="$(sha256_file "$TMP_DIR/$asset")"
  [ "$actual" = "$expected" ] || fail "checksum verification failed for $asset"
}

printf 'Installing managed Node.js %s…\n' "$NODE_VERSION"
NODE_DIR="$DATA_DIR/node-${NODE_VERSION}-${PLATFORM}"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  [ ! -e "$NODE_DIR" ] || fail "incomplete managed Node runtime at $NODE_DIR"
  curl -fsSL "$RELEASE_BASE/$NODE_ASSET" -o "$TMP_DIR/$NODE_ASSET"
  verify_asset "$NODE_ASSET"
  mkdir -p "$TMP_DIR/node-unpack"
  tar -xzf "$TMP_DIR/$NODE_ASSET" -C "$TMP_DIR/node-unpack"
  extracted_node="$(find "$TMP_DIR/node-unpack" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [ -n "$extracted_node" ] && [ -x "$extracted_node/bin/node" ] || fail "managed Node archive is invalid"
  mv "$extracted_node" "$NODE_DIR"
fi
ln -sfn "$NODE_DIR" "$NODE_LINK"
MANAGED_NODE="$NODE_LINK/bin/node"
MANAGED_NPM="$NODE_LINK/bin/npm"
[ -x "$MANAGED_NPM" ] || fail "managed npm is missing"
PATH="$NODE_LINK/bin:$PATH"
export PATH
"$MANAGED_NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19))process.exit(1)' || fail "managed Node.js >=22.19.0 is required"

existing_pi="$(command -v pi 2>/dev/null || true)"
compatible_pi=""
if [ -n "$existing_pi" ]; then
  case "$("$existing_pi" --version 2>/dev/null || true)" in
    *"$PI_VERSION"*) compatible_pi="$existing_pi" ;;
  esac
fi

printf 'Installing Pi Daemon %s and Pi %s…\n' "$VERSION" "$PI_VERSION"
curl -fsSL "$RELEASE_BASE/$DAEMON_ASSET" -o "$TMP_DIR/$DAEMON_ASSET"
verify_asset "$DAEMON_ASSET"
"$MANAGED_NPM" install --global --prefix "$PREFIX" --ignore-scripts \
  "$TMP_DIR/$DAEMON_ASSET" \
  "@earendil-works/pi-coding-agent@$PI_VERSION"

if [ -e "$BIN_DIR/pi-daemon" ] || [ -L "$BIN_DIR/pi-daemon" ]; then
  mv "$BIN_DIR/pi-daemon" "$TMP_DIR/pi-daemon.previous"
fi
printf '#!/bin/sh\nPATH="%s:$PATH"\nexport PATH\nexec "%s" "$@"\n' "$NODE_LINK/bin" "$PREFIX/bin/pi-daemon" > "$BIN_DIR/pi-daemon"
chmod 755 "$BIN_DIR/pi-daemon"
if [ -n "$compatible_pi" ]; then
  SELECTED_PI="$compatible_pi"
  printf 'Preserving compatible Pi command at %s.\n' "$compatible_pi"
else
  SELECTED_PI="$PREFIX/bin/pi"
  if [ -e "$BIN_DIR/pi" ] || [ -L "$BIN_DIR/pi" ]; then
    mv "$BIN_DIR/pi" "$TMP_DIR/pi.previous"
  fi
  printf '#!/bin/sh\nPATH="%s:$PATH"\nexport PATH\nexec "%s" "$@"\n' "$NODE_LINK/bin" "$SELECTED_PI" > "$BIN_DIR/pi"
  chmod 755 "$BIN_DIR/pi"
  [ -z "$existing_pi" ] || printf 'Existing Pi is not %s; exposing the managed Pi at %s/pi.\n' "$PI_VERSION" "$BIN_DIR"
fi

use_existing_cloudflared=false
if command -v cloudflared >/dev/null 2>&1; then
  installed_version="$(cloudflared --version 2>/dev/null | sed -n 's/.*version \([0-9][0-9.]*\).*/\1/p')"
  if [ -n "$installed_version" ] && node -e 'const a=process.argv[1].split(".").map(Number),b=[2025,4,0];for(let i=0;i<3;i++){if((a[i]||0)>b[i])process.exit(0);if((a[i]||0)<b[i])process.exit(1)}' "$installed_version"; then
    use_existing_cloudflared=true
  fi
fi

if [ "$use_existing_cloudflared" = true ]; then
  CF_BIN="$(command -v cloudflared)"
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

printf '\nStarting interactive setup…\n'
PATH="$NODE_LINK/bin:$BIN_DIR:$PREFIX/bin:$PATH" PI_DAEMON_PI="$SELECTED_PI" PI_DAEMON_CLOUDFLARED="$CF_BIN" "$MANAGED_NODE" "$PREFIX/lib/node_modules/@edward40/pi-daemon/dist/cli.js" setup </dev/tty >/dev/tty

printf '\nInstalled. Management command: %s/pi-daemon\n' "$BIN_DIR"
