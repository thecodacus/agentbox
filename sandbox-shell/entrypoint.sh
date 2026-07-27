#!/bin/sh
set -e

# /workspace is a Docker volume mounted at runtime, so its ownership comes from
# the daemon (root) rather than the image. Fix it up here — as root — then drop
# to the unprivileged sandbox user for the actual workload, so nothing the agent
# runs has uid 0.
#
# The recursive chown only runs when ownership is actually wrong, so it is a
# one-time cost when upgrading an existing root-owned volume rather than a
# per-start penalty on large workspaces.
TARGET_UID=$(id -u sandbox)
TARGET_GID=$(id -g sandbox)

if [ -d /workspace ]; then
  if [ "$(stat -c %u /workspace)" != "$TARGET_UID" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" /workspace 2>/dev/null || true
  fi
fi

exec su-exec "${TARGET_UID}:${TARGET_GID}" "$@"
