#!/bin/sh
# Lay out a built genie under /opt/genie (or $PREFIX) and prepare the service user.
#
#   cargo build --release -p genie && npm ci && npm run build:web
#   sudo deploy/install.sh
#
# Then, as the service user: install pi (npm install -g --prefix ~/.local
# @earendil-works/pi-coding-agent), log in to the model providers (pi, then /login),
# and check everything with `GENIE_DATA=/var/lib/genie /opt/genie/bin/genie doctor --web /opt/genie/web`.
set -eu

cd "$(dirname "$0")/.."
PREFIX=${PREFIX:-/opt/genie}
USER_NAME=${GENIE_USER:-genie}
DATA=${GENIE_DATA:-/var/lib/genie}
BACKUPS=${GENIE_BACKUPS:-/var/backups/genie}

test -x target/release/genie || { echo "build first: cargo build --release -p genie" >&2; exit 1; }
test -f web/dist/index.html || { echo "build the web UI first: npm ci && npm run build:web" >&2; exit 1; }

install -d "$PREFIX/bin"
install -m 0755 target/release/genie "$PREFIX/bin/genie"
rm -rf "$PREFIX/web.new"
cp -r web/dist "$PREFIX/web.new"
rm -rf "$PREFIX/web"
mv "$PREFIX/web.new" "$PREFIX/web"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /bin/bash "$USER_NAME"
fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$DATA"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$BACKUPS"
install -d -m 0750 /etc/genie
test -f /etc/genie/secrets.env || install -m 0640 -g "$USER_NAME" /dev/null /etc/genie/secrets.env

echo "genie installed in $PREFIX (data $DATA, backups $BACKUPS, user $USER_NAME)"
echo "next: cp deploy/systemd/* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now genie genie-backup.timer"
