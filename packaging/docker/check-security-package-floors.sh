#!/bin/sh
# Fail closed when an apt mirror or cached layer predates the reviewed fixes.
set -eu
while read -r package minimum; do
  case "$package" in ''|'#'*) continue ;; esac
  installed=$(dpkg-query -W -f='${Version}' "$package")
  if ! dpkg --compare-versions "$installed" ge "$minimum"; then
    echo "$package: installed $installed is below security floor $minimum" >&2
    exit 1
  fi
  echo "$package: $installed (security floor $minimum)"
done < "$1"
