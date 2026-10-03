#!/bin/sh
# Fail closed when an apt mirror or cached layer predates the reviewed fixes.
set -eu
architecture=$(dpkg --print-architecture)
case "$architecture" in amd64|arm64) ;; *) echo "unsupported architecture: $architecture" >&2; exit 1 ;; esac
while read -r package minimum selected extra; do
  case "$package" in ''|'#'*) continue ;; esac
  test -n "$minimum" && test -z "$extra"
  case "$selected" in ''|amd64|arm64) ;; *) echo "invalid architecture selector: $selected" >&2; exit 1 ;; esac
  if [ -n "$selected" ] && [ "$selected" != "$architecture" ]; then continue; fi
  installed=$(dpkg-query -W -f='${Version}' "$package")
  if ! dpkg --compare-versions "$installed" ge "$minimum"; then
    echo "$package: installed $installed is below security floor $minimum" >&2
    exit 1
  fi
  echo "$package: $installed (security floor $minimum)"
done < "$1"
