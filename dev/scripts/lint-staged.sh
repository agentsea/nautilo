#!/usr/bin/env bash
# Lint only the staged files, from the package CWD that owns their lint policy.
# Bash 3 is still the macOS system shell, so grouping deliberately uses indexed
# arrays rather than associative arrays.
set -euo pipefail

repo_root="${LINT_STAGED_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"

if [ "$#" -eq 0 ]; then
  exit 0
fi

lint_driver_for_manifest() {
  local manifest="$1"

  node -e '
    const fs = require("fs");
    const lint = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).scripts?.lint;
    if (lint === "eslint .") process.stdout.write("eslint");
    if (lint === "expo lint") process.stdout.write("expo");
  ' "$manifest"
}

lint_workspace_for() {
  local file="$1"
  local directory
  local manifest
  local driver

  directory="$(dirname "$file")"
  while [ "$directory" != "." ] && [ "$directory" != "/" ]; do
    manifest="$repo_root/$directory/package.json"
    if [ -f "$manifest" ]; then
      driver="$(lint_driver_for_manifest "$manifest")"
      if [ -n "$driver" ]; then
        printf '%s\t%s\n' "$directory" "$driver"
        return
      fi
    fi
    directory="$(dirname "$directory")"
  done

  # Files outside a package retain the repository ESLint policy.
  printf '.\teslint\n'
}

for staged_file in "$@"; do
  case "$staged_file" in
    ""|/*|..|../*|*/..|*/../*)
      echo "lint-staged: refusing non-repository path: $staged_file" >&2
      exit 2
      ;;
  esac
done

# First retain each workspace once, in input order. A second pass builds the
# argument array for that workspace; this keeps filenames with spaces intact.
staged_files=("$@")
workspaces=()
file_workspaces=()
for staged_file in "${staged_files[@]}"; do
  workspace="$(lint_workspace_for "$staged_file")"
  file_workspaces+=("$workspace")
  known=false
  for existing_workspace in "${workspaces[@]:-}"; do
    if [ "$existing_workspace" = "$workspace" ]; then
      known=true
      break
    fi
  done
  if [ "$known" = false ]; then
    workspaces+=("$workspace")
  fi
done

for workspace in "${workspaces[@]}"; do
  workspace_dir="${workspace%%$'\t'*}"
  driver="${workspace#*$'\t'}"
  paths=()

  for index in "${!staged_files[@]}"; do
    if [ "${file_workspaces[$index]}" = "$workspace" ]; then
      staged_file="${staged_files[$index]}"
      if [ "$workspace_dir" = "." ]; then
        paths+=("$staged_file")
      else
        paths+=("${staged_file#"$workspace_dir/"}")
      fi
    fi
  done

  (
    cd "$repo_root/$workspace_dir"
    case "$driver" in
      eslint)
        bunx eslint --fix -- "${paths[@]}"
        ;;
      expo)
        bunx expo lint --fix "${paths[@]}"
        ;;
      *)
        echo "lint-staged: unsupported lint driver: $driver" >&2
        exit 2
        ;;
    esac
  )
done
