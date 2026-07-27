#!/bin/bash
set -e

# See sandbox-shell/entrypoint.sh — same rationale. Root only long enough to fix
# the mounted volume's ownership, then drop to the sandbox user so Chromium and
# anything the agent drives run unprivileged.
TARGET_UID=$(id -u sandbox)
TARGET_GID=$(id -g sandbox)

if [ -d /workspace ]; then
  if [ "$(stat -c %u /workspace)" != "$TARGET_UID" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" /workspace 2>/dev/null || true
  fi
fi

exec gosu "${TARGET_UID}:${TARGET_GID}" "$@"
