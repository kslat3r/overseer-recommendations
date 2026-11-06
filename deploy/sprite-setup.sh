#!/usr/bin/env bash
# Runs INSIDE the Fly Sprite (Ubuntu, Node + Git preinstalled). Idempotent: safe to re-run
# to update. Secrets are read from the environment (or the existing env file), written to a
# mode-600 file, and never echoed, logged, passed in argv, or stored in git/service config.
#
#   export OVERSEERR_URL=... OVERSEERR_API_KEY=... APP_PASSWORD=... TS_AUTHKEY=...
#   bash /home/sprite/sprite-setup.sh
# Optional: TS_USERSPACE=1 (userspace networking fallback), TS_HOSTNAME=name.
set -euo pipefail
umask 077

REPO_URL="${REPO_URL:-https://github.com/kslat3r/overseer-recommendations.git}"
REPO_DIR="${REPO_DIR:-/home/sprite/overseer-recommendations}"
ENV_FILE="${ENV_FILE:-/home/sprite/overseer-recs.env}"
TS_HOSTNAME="${TS_HOSTNAME:-overseer-recs}"
PROXY_ADDR="127.0.0.1:1055"
PORT_NUM=8080

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
sudo_() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ---------------------------------------------------------------- 1. secrets / env file
# Existing env file values are used for anything not exported now (re-runs need no secrets).
file_get() { # name -> value from env file (no shell evaluation)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1
}
TS_AUTHKEY="${TS_AUTHKEY:-${TAILSCALE_AUTHKEY:-}}"
OVERSEERR_URL="${OVERSEERR_URL:-$(file_get OVERSEERR_URL)}"
OVERSEERR_API_KEY="${OVERSEERR_API_KEY:-$(file_get OVERSEERR_API_KEY)}"
APP_PASSWORD="${APP_PASSWORD:-$(file_get APP_PASSWORD)}"

missing=()
[ -n "$OVERSEERR_URL" ] || missing+=(OVERSEERR_URL)
[ -n "$OVERSEERR_API_KEY" ] || missing+=(OVERSEERR_API_KEY)
[ -n "$APP_PASSWORD" ] || missing+=(APP_PASSWORD)
if [ "${#missing[@]}" -gt 0 ]; then
  die "missing required value(s): ${missing[*]} (export them in this shell first)"
fi
case "$OVERSEERR_URL" in
  http://* | https://*) ;;
  *) die "OVERSEERR_URL must start with http:// or https://" ;;
esac
# The env file is KEY=value per line, read by Node --env-file: reject values that would break it.
for v in OVERSEERR_URL OVERSEERR_API_KEY APP_PASSWORD; do
  case "${!v}" in
    *$'\n'* | *$'\r'*) die "$v must not contain newlines" ;;
    *\"* | *\'* | *\#* | *\\*) die "$v must not contain quotes, # or backslashes (they break the env file)" ;;
  esac
done
[ "${#APP_PASSWORD}" -ge 8 ] || die "APP_PASSWORD must be at least 8 characters"

# ---------------------------------------------------------------- 2. repo
command -v git >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found"
if [ -d "$REPO_DIR/.git" ]; then
  log "Updating $REPO_DIR"
  if [ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]; then
    die "$REPO_DIR has local changes; commit/stash/discard them (git -C $REPO_DIR checkout .) and re-run"
  fi
  git -C "$REPO_DIR" fetch --quiet origin main
  git -C "$REPO_DIR" checkout --quiet main
  git -C "$REPO_DIR" merge --ff-only --quiet origin/main
else
  log "Cloning $REPO_URL"
  git clone --quiet --branch main "$REPO_URL" "$REPO_DIR"
fi

# ---------------------------------------------------------------- 3. pnpm, install, build
if ! command -v pnpm >/dev/null; then
  log "Installing pnpm"
  if command -v corepack >/dev/null && corepack enable --install-directory "$HOME/.local/bin" 2>/dev/null; then
    export PATH="$HOME/.local/bin:$PATH"
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null; then
    npm install --global --prefix "$HOME/.local" pnpm >/dev/null
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
command -v pnpm >/dev/null || die "could not install pnpm"
log "Installing dependencies and building"
(cd "$REPO_DIR" && pnpm install --frozen-lockfile && pnpm build)
[ -f "$REPO_DIR/dist-server/index.js" ] || die "build did not produce dist-server/index.js"
[ -f "$REPO_DIR/dist/index.html" ] || die "build did not produce dist/index.html"
NODE_BIN="$(command -v node)"

# ---------------------------------------------------------------- 4. persist env file (600, outside dist)
log "Writing $ENV_FILE (mode 600)"
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
{
  printf 'NODE_ENV=production\n'
  printf 'PORT=%s\n' "$PORT_NUM"
  printf 'TAILSCALE_PROXY=http://%s\n' "$PROXY_ADDR"
  printf 'OVERSEERR_URL=%s\n' "$OVERSEERR_URL"
  printf 'OVERSEERR_API_KEY=%s\n' "$OVERSEERR_API_KEY"
  printf 'APP_PASSWORD=%s\n' "$APP_PASSWORD"
} >"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$ENV_FILE"

# ---------------------------------------------------------------- 5. Tailscale
if ! command -v tailscaled >/dev/null || ! command -v tailscale >/dev/null; then
  log "Installing Tailscale (official script)"
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi
command -v tailscaled >/dev/null || die "tailscaled not installed"
TSD="$(command -v tailscaled)"
TS="$(command -v tailscale)"
sudo_ mkdir -p /var/lib/tailscale /var/run/tailscale

command -v sprite-env >/dev/null || die "sprite-env not found: run this script inside the Sprite"

svc_replace() { # name, then `sprite-env services create` args
  local name="$1"
  shift
  sprite-env services delete "$name" >/dev/null 2>&1 || true
  sprite-env services create "$name" "$@"
}

# Default: kernel networking (Sprites provide /dev/net/tun + CAP_NET_ADMIN and allow UDP when no
# network policy is set). TS_USERSPACE=1 switches to userspace networking as a fallback.
TSD_ARGS="--state=/var/lib/tailscale/tailscaled.state,--socket=/var/run/tailscale/tailscaled.sock,--outbound-http-proxy-listen=$PROXY_ADDR,--socks5-server=$PROXY_ADDR"
if [ "${TS_USERSPACE:-}" = "1" ]; then
  MODE="userspace networking"
  TSD_ARGS="--tun=userspace-networking,$TSD_ARGS"
else
  MODE="kernel networking"
  [ -c /dev/net/tun ] || die "/dev/net/tun is missing, so kernel Tailscale cannot start. Re-run with TS_USERSPACE=1 to use userspace networking instead."
fi

# Sprite services run unprivileged by default; tailscaled needs root (TUN + /var/lib, /var/run),
# so it is started through passwordless sudo.
log "Configuring tailscaled service ($MODE, proxy $PROXY_ADDR)"
svc_replace tailscaled \
  --cmd /usr/bin/sudo \
  --args "-n,$TSD,$TSD_ARGS"

log "Waiting for tailscaled"
SOCK=/var/run/tailscale/tailscaled.sock
ready=""
for _ in $(seq 1 40); do
  if [ -S "$SOCK" ]; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || die "tailscaled did not become ready (see /.sprite/logs/services/tailscaled.log; if kernel mode failed, re-run with TS_USERSPACE=1)"
sleep 1

# `tailscale up` once: skip if already logged in (node state persists in /var/lib/tailscale).
if sudo_ "$TS" --socket="$SOCK" status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
  log "Tailscale already up"
else
  [ -n "$TS_AUTHKEY" ] || die "TS_AUTHKEY (or TAILSCALE_AUTHKEY) is required for the first Tailscale login"
  log "Running tailscale up as $TS_HOSTNAME"
  # The key goes through a mode-600 temp file (file: syntax), never argv, so `ps` cannot show it.
  keyfile="$(mktemp)"
  trap 'rm -f "$keyfile"' EXIT
  printf '%s' "$TS_AUTHKEY" >"$keyfile"
  chmod 600 "$keyfile"
  sudo_ "$TS" --socket="$SOCK" up --auth-key="file:$keyfile" --hostname="$TS_HOSTNAME" >/dev/null
  rm -f "$keyfile"
fi

# ---------------------------------------------------------------- 6. app service
log "Configuring overseer-recs service on port $PORT_NUM"
svc_replace overseer-recs \
  --cmd "$NODE_BIN" \
  --args "--env-file=$ENV_FILE,dist-server/index.js" \
  --dir "$REPO_DIR" \
  --http-port "$PORT_NUM" \
  --needs tailscaled

log "Done. Check: sprite-env services list ; tail -n 100 /.sprite/logs/services/overseer-recs.log ; tail -n 100 /.sprite/logs/services/tailscaled.log"
