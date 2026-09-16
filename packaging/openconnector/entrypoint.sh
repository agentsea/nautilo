#!/bin/sh
set -eu

if [ -n "${OOMOL_CONNECT_ENCRYPTION_KEY_FILE:-}" ]; then
  if [ -n "${OOMOL_CONNECT_ENCRYPTION_KEY:-}" ]; then
    echo "OpenConnector encryption key must use either OOMOL_CONNECT_ENCRYPTION_KEY or OOMOL_CONNECT_ENCRYPTION_KEY_FILE, not both." >&2
    exit 1
  fi
  if [ ! -r "${OOMOL_CONNECT_ENCRYPTION_KEY_FILE}" ]; then
    echo "OpenConnector encryption key file is not readable." >&2
    exit 1
  fi
  OOMOL_CONNECT_ENCRYPTION_KEY="$(tr -d '\r\n' < "${OOMOL_CONNECT_ENCRYPTION_KEY_FILE}")"
  export OOMOL_CONNECT_ENCRYPTION_KEY
fi

exec /usr/local/bin/open-connector-upstream "$@"
