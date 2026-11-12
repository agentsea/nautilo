#!/usr/bin/env sh
# Container entrypoint. Compose injects DB_* + most NAUTILO_* env
# vars; we only fill in safe defaults so `docker run` smoke tests work
# without a full compose env. Host-dev `bun run server` never goes
# through this script.
set -eu

# Updating userspace does not update the host kernel. Refuse a detected
# vulnerable Ubuntu build before opening database or network connections.
/usr/local/bin/bun /srv/host-kernel-check.ts

export NAUTILO_HOSTING_MODE="${NAUTILO_HOSTING_MODE:-local}"
export NAUTILO_DB_BOOTSTRAP="${NAUTILO_DB_BOOTSTRAP:-container}"
export NAUTILO_MIGRATIONS_DIR="${NAUTILO_MIGRATIONS_DIR:-/srv/migrations}"
export NAUTILO_WORKBENCH_DIST="${NAUTILO_WORKBENCH_DIST:-/srv/workbench}"

# Run TS source directly via bun (no pre-bundle). This is the documented
# fallback from the Dockerfile header: argon2's native addon + dynamic
# requires don't survive `bun build --target=bun`, so we ship source +
# node_modules instead.
cd /srv/repo
exec /usr/local/bin/bun bin/nautilo-server/src/index.ts
