#!/usr/bin/env bash
# Installs Web-Proxy as a systemd service on a Raspberry Pi (or any Debian-like Linux).
# Usage (from the project folder):  sudo ./deploy/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo ./deploy/install.sh" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20 or newer first, e.g.:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -" >&2
  echo "  sudo apt-get install -y nodejs" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "Node.js $NODE_MAJOR is too old. Install Node.js 20 or newer (see README)." >&2
  exit 1
fi

echo "==> Installing dependencies (this can take a few minutes on a Pi)"
sudo -u "$RUN_USER" bash -c "cd '$DIR' && npm ci --omit=dev"

if [[ ! -f "$DIR/.env" ]]; then
  echo "==> Creating .env"
  cp "$DIR/.env.example" "$DIR/.env"
  read -r -s -p "Choose a password for the proxy (leave empty for none): " PW; echo
  if [[ -n "$PW" ]]; then
    # escape characters that are special to sed
    ESCAPED=$(printf '%s' "$PW" | sed -e 's/[\/&|]/\\&/g')
    sed -i "s|^PROXY_PASSWORD=.*|PROXY_PASSWORD=$ESCAPED|" "$DIR/.env"
  fi
  chown "$RUN_USER" "$DIR/.env"
  chmod 600 "$DIR/.env"
fi

echo "==> Installing systemd service"
sed -e "s|__USER__|$RUN_USER|" -e "s|__DIR__|$DIR|" "$DIR/deploy/web-proxy.service" > /etc/systemd/system/web-proxy.service
systemctl daemon-reload
systemctl enable web-proxy
systemctl restart web-proxy
sleep 2
systemctl --no-pager --lines=5 status web-proxy || true

PORT="$(grep -E '^PORT=' "$DIR/.env" | cut -d= -f2)"
echo
echo "Done. Web-Proxy is running on port ${PORT:-8080}."
echo "Next: point your web server (nginx / Apache / Caddy) at it with HTTPS. See README.md."
