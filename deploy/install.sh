#!/bin/sh
# Lay out a built genie under /opt/genie (or $PREFIX) and prepare the service user.
#
#   npm ci && npm run build:web && GENIE_WEB_DIST=web/dist cargo build --release -p genie
#   sudo deploy/install.sh
#
# The web UI goes into the binary, so it is built first (GENIE_WEB_DIST makes the
# build fail without it). Then, as the service user: install pi (npm install -g
# --prefix ~/.local @earendil-works/pi-coding-agent), log in to the model providers
# (pi, then /login), and check everything with `GENIE_DATA=/var/lib/genie /opt/genie/bin/genie doctor`.
set -eu

cd "$(dirname "$0")/.."
PREFIX=${PREFIX:-/opt/genie}
USER_NAME=${GENIE_USER:-genie}
DATA=${GENIE_DATA:-/var/lib/genie}
BACKUPS=${GENIE_BACKUPS:-/var/backups/genie}

BUILD="npm ci && npm run build:web && GENIE_WEB_DIST=web/dist cargo build --release -p genie"
test -x target/release/genie || { echo "build first: $BUILD" >&2; exit 1; }
if [ -f web/dist/index.html ] && [ web/dist/index.html -nt target/release/genie ]; then
  echo "the web UI is newer than the binary it goes into: $BUILD" >&2
  exit 1
fi

install -d "$PREFIX/bin"
install -m 0755 target/release/genie "$PREFIX/bin/genie"
# The web UI is inside the binary; a unit still passing --web must not serve an old copy.
rm -rf "$PREFIX/web"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /bin/bash "$USER_NAME"
fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$DATA"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$BACKUPS"
install -d -m 0750 /etc/genie
test -f /etc/genie/secrets.env || install -m 0640 -g "$USER_NAME" /dev/null /etc/genie/secrets.env

echo "genie installed in $PREFIX (data $DATA, backups $BACKUPS, user $USER_NAME)"
echo "next: cp deploy/systemd/* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now genie genie-backup.timer"
