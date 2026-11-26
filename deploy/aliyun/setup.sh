#!/usr/bin/env bash
# One-shot server setup for the Christmas cards app on a fresh Ubuntu 22.04/24.04
# box. Idempotent: safe to re-run after a git pull.
#
#   sudo bash deploy/aliyun/setup.sh
#
# Installs Node 22 + pnpm, builds the app, and starts it under systemd on
# 127.0.0.1:3000. Nginx + TLS is a separate step (deploy/aliyun/nginx.conf).
set -euo pipefail

APP_USER=cards
APP_DIR=/srv/christmas-cards
PORT=3000
NODE_MAJOR=22
PNPM_VERSION=10.24.0
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "run this with sudo" >&2
  exit 1
fi

log "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git nginx rsync ufw

log "node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  # NodeSource first; the npmmirror binary mirror is the fallback for boxes that
  # cannot reach deb.nodesource.com.
  if ! curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource.sh; then
    echo "NodeSource unreachable, falling back to npmmirror" >&2
    VER="$(curl -fsSL https://cdn.npmmirror.com/binaries/node/index.json | grep -o "\"v${NODE_MAJOR}\.[0-9.]*\"" | head -n 1 | tr -d '"')"
    curl -fsSL "https://cdn.npmmirror.com/binaries/node/${VER}/node-${VER}-linux-x64.tar.xz" -o /tmp/node.tar.xz
    mkdir -p /usr/local/lib/nodejs
    tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
    ln -sf "/usr/local/lib/nodejs/node-${VER}-linux-x64/bin/node" /usr/local/bin/node
    ln -sf "/usr/local/lib/nodejs/node-${VER}-linux-x64/bin/npm" /usr/local/bin/npm
  else
    bash /tmp/nodesource.sh
    apt-get install -y -qq nodejs
  fi
fi
node -v

log "pnpm ${PNPM_VERSION}"
npm install -g "pnpm@${PNPM_VERSION}" >/dev/null
pnpm -v

log "app user + directory"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude .open-next --exclude data \
  "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/data/uploads"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

log "install + build"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && pnpm install --frozen-lockfile && pnpm build"

log "systemd unit"
install -m 0644 "$SRC_DIR/deploy/aliyun/christmas-cards.service" /etc/systemd/system/christmas-cards.service
sed -i "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g; s|__PORT__|$PORT|g" \
  /etc/systemd/system/christmas-cards.service
systemctl daemon-reload
systemctl enable --now christmas-cards
sleep 2
systemctl --no-pager --lines=5 status christmas-cards || true

log "firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

log "smoke test"
if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "app answers on 127.0.0.1:${PORT}"
else
  echo "app did NOT answer - check: journalctl -u christmas-cards -n 50" >&2
  exit 1
fi

cat <<EOF

Done. Next:
  public IP:  http://<server-ip>:${PORT}   (works before ICP filing)
  with a domain, after DNS resolves:  deploy/aliyun/nginx.conf, then certbot
  logs:  journalctl -u christmas-cards -f
  data:  ${APP_DIR}/data  (letters.db + uploads/, back this up)
EOF
