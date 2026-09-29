#!/usr/bin/env bash
# `genie` for people inside the container (`docker exec genie genie …`).
#
# docker exec starts as root by default, and a root-owned server.db or WAL file would lock the
# server (running as the service user) out of its own database. So as root this wrapper re-runs
# the real binary as the service user; everyone else runs it directly.
set -euo pipefail

real=/opt/genie/bin/genie

if [ "$(id -u)" = 0 ]; then
  user=genie
  home="$(getent passwd "$user" | cut -d: -f6)"
  exec setpriv --reuid="$(id -u "$user")" --regid="$(id -g "$user")" --init-groups \
    env HOME="$home" USER="$user" LOGNAME="$user" "$real" "$@"
fi
exec "$real" "$@"
