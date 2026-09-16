#!/usr/bin/env bash
#
# _lib/deploy.sh — shared deploy library, sourced by per-bundle install.sh
#                  scripts and by dev/tools/install-all.sh.
#
# Why this exists
# ---------------
# Every command bundle under dev/tools/<bundle>/ used to ship its own
# install.sh that was ~95% copy-pasted boilerplate (worktree discovery,
# companion-repo discovery, stamp-and-copy, env-var override). Adding a
# new bundle meant cloning that file, which guaranteed drift.
#
# This library is the single home for all of that logic. A per-bundle
# install.sh becomes a 3-line wrapper:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   HERE="$(cd "$(dirname "$0")" && pwd)"
#   . "$HERE/../_lib/deploy.sh"
#   deploy_bundle "$HERE" "<bundle-name>"
#
# Bundle layout (only the subdirs that exist are deployed):
#
#   dev/tools/<bundle>/
#     install.sh                            <-- thin wrapper
#     README.md
#     claude/agents/*.md                    -> <dst>/.claude/agents/
#     claude/commands/fb/*.md               -> <dst>/.claude/commands/fb/
#     cursor/commands/*.md                  -> <dst>/.cursor/commands/
#     cursor/rules/*.mdc                    -> <dst>/.cursor/rules/
#     cursor/skills/<name>/SKILL.md         -> <dst>/.cursor/skills/<name>/
#     cursor/hooks.json                     -> <dst>/.cursor/hooks.json   (raw)
#     cursor/hooks/*                         -> <dst>/.cursor/hooks/       (raw, +x)
#     codex/prompts/*.md                    -> <codex-home>/prompts/
#     codex/skills/<name>/**                -> <codex-home>/skills/<name>/
#
# Codex prompt source fallback:
#   If codex/prompts/ exists, deploy those files.
#   Else if cursor/commands/ exists, deploy those files as Codex prompts.
#   Else if claude/commands/fb/ exists, deploy those files as Codex prompts.
#
# Single source of truth per command file
# ---------------------------------------
# Bundle authors are encouraged to keep ONE real file (e.g. under
# claude/commands/fb/foo.md) and create the cursor/commands/foo.md as
# a relative symlink to it. Then editing the canonical file
# automatically updates both deploy shapes. install.sh stamps a
# "deployed copy — do not edit" banner onto every materialized copy.
#
# Destinations (auto-discovered, never hardcoded)
# -----------------------------------------------
#   .claude destinations:
#     [1] every git worktree of the nautilo repo
#     [2] sibling companion repos that already have .claude/ AND share
#         the same GitHub org AND whose repo name is nautilo / nautilo-* / nautilo_*
#     [3] paths in $NAUTILO_EXTRA_CLAUDE_DIRS (colon-separated)
#         (also honors legacy per-bundle vars like PRE_FLIGHT_EXTRA_CLAUDE_DIRS,
#         PR_REVIEW_EXTRA_CLAUDE_DIRS — supplied by the per-bundle wrapper)
#
#   .cursor destinations:
#     [4] the first ancestor directory of the nautilo checkout that
#         already has a .cursor/ directory (the enclosing workspace).
#         This is where the user opens Cursor as a workspace root.
#     [5] paths in $NAUTILO_EXTRA_CURSOR_DIRS (colon-separated)
#
#   Codex destinations:
#     [6] $NAUTILO_CODEX_HOME/{prompts,skills}, or
#         $CODEX_HOME/{prompts,skills}, or ~/.codex/{prompts,skills}
#     [7] paths in $NAUTILO_EXTRA_CODEX_HOMES (colon-separated; each path
#         is a Codex home directory, not the prompts subdirectory)
#
# Each destination is deployed to once per run (deduped by canonical path).
# Idempotent. Pure cp via stamp_and_copy. Never rm -rf. Only writes inside
# .claude/{agents,commands/fb}/, .cursor/{commands,rules,skills,hooks}/,
# .cursor/hooks.json, and <codex-home>/{prompts,skills}/.
#
# Optional stale-command prune (install-all only):
#   NAUTILO_DEPLOY_PRUNE=1 removes deployed command/prompt .md files whose
#   basename is not in the current bundle canonical set. Does NOT touch
#   .claude/agents/, .cursor/rules/, skills, or hooks. Only runs on a full
#   install-all (not when filtering to specific bundles).
#
# Sanity rails
# ------------
# - Refuses to write into anything that doesn't already look like a repo /
#   workspace root (the destination must already contain .claude/ for
#   companion mode, or .cursor/ for cursor mode; worktrees and the
#   nautilo repo itself are exempt because we create .claude/ on demand
#   for those).
# - Honors a global $NAUTILO_DEPLOY_DRY_RUN=1 to skip the actual cp/symlink
#   write while printing what would be done.

set -euo pipefail

# Guard against being executed directly (this file must be sourced).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  printf 'FATAL: %s must be sourced, not executed.\n' "${BASH_SOURCE[0]}" >&2
  exit 2
fi

# ---------- helpers ---------------------------------------------------------

# Extract "<org>/<repo>" from a GitHub remote URL.
# Handles: git@github.com:org/repo.git, https://github.com/org/repo.git,
# ssh://git@github.com/org/repo, and variants without .git suffix.
_deploy_parse_github_slug() {
  local url="$1"
  printf '%s' "$url" \
    | sed -E 's#^ssh://##; s#^git@github\.com:#github.com/#; s#^https?://##' \
    | sed -E 's#^github\.com/##; s#\.git$##'
}

# Walk up from $1 looking for the first ancestor dir that already
# contains a .cursor/ subdirectory. Echoes the path or empty.
_deploy_find_cursor_workspace() {
  local d="$1"
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    if [ -d "$d/.cursor" ]; then
      printf '%s\n' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 0
}

# ---------- dedup -----------------------------------------------------------

_DEPLOY_PATHS_CLAUDE=""
_DEPLOY_PATHS_CURSOR=""
_DEPLOY_PATHS_CODEX=""
_DEPLOY_PATHS_CODEX_SKILLS=""

_deploy_already() {
  local var="$1" p="$2"
  case ":${!var}:" in
    *":$p:"*) return 0 ;;
    *) return 1 ;;
  esac
}

_deploy_mark() {
  local var="$1" p="$2"
  if [ -z "${!var}" ]; then
    printf -v "$var" '%s' "$p"
  else
    printf -v "$var" '%s' "${!var}:$p"
  fi
}

# ---------- stamp_and_copy --------------------------------------------------

# Resolves a possibly-symlinked src to its real path (for the banner),
# then writes <banner>\n<contents> into dst.
_deploy_stamp_and_copy() {
  local src="$1"
  local dst="$2"
  local bundle_name="$3"
  local nautilo_root="$4"

  local src_real
  src_real="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
  if [ -L "$src" ]; then
    # follow symlink, but report the canonical (target) path in the banner
    # so editors land on the real file, not the bundle alias.
    local link_target
    link_target="$(readlink "$src")"
    case "$link_target" in
      /*) src_real="$link_target" ;;
      *)  src_real="$(cd "$(dirname "$src")" && cd "$(dirname "$link_target")" && pwd)/$(basename "$link_target")" ;;
    esac
  fi

  local canonical_rel="${src_real#$nautilo_root/}"

  if [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" = "1" ]; then
    printf '    DRY: would write %s\n' "$dst"
    return
  fi

  {
    printf '%s\n' '<!--'
    printf '%s\n' '======================================================================'
    printf '%s\n' 'DEPLOYED COPY — DO NOT EDIT THIS FILE DIRECTLY.'
    printf '%s\n' ''
    printf 'Canonical source: nautilo/%s\n' "$canonical_rel"
    printf 'Deployed by:      nautilo/dev/tools/%s/install.sh\n' "$bundle_name"
    printf '%s\n' ''
    printf '%s\n' 'To modify this prompt:'
    printf '%s\n' '  1. Edit the canonical file at the path above (in the nautilo repo).'
    printf '%s\n' '  2. Run: bash dev/tools/install-all.sh        (all bundles)'
    printf '%s\n' '       or: bash dev/tools/<bundle>/install.sh  (just one)'
    printf '%s\n' '  3. Commit the canonical change. The .claude/, .cursor/, and'
    printf '%s\n' '     .codex/prompts copies are gitignored at every destination —'
    printf '%s\n' '     they are deployed copies, not the source.'
    printf '%s\n' ''
    printf '%s\n' 'Edits made directly to THIS file will be silently overwritten the'
    printf '%s\n' 'next time install.sh runs.'
    printf '%s\n' '======================================================================'
    printf '%s\n' '-->'
    printf '%s\n' ''
    cat "$src"
  } > "$dst"
}

_deploy_codex_prompt_source_dir() {
  local bundle_dir="$1"
  if [ -d "$bundle_dir/codex/prompts" ]; then
    printf '%s\n' "$bundle_dir/codex/prompts"
  elif [ -d "$bundle_dir/cursor/commands" ]; then
    printf '%s\n' "$bundle_dir/cursor/commands"
  elif [ -d "$bundle_dir/claude/commands/fb" ]; then
    printf '%s\n' "$bundle_dir/claude/commands/fb"
  fi
}

_deploy_default_codex_home() {
  if [ -n "${NAUTILO_CODEX_HOME:-}" ]; then
    printf '%s\n' "$NAUTILO_CODEX_HOME"
  elif [ -n "${CODEX_HOME:-}" ]; then
    printf '%s\n' "$CODEX_HOME"
  else
    printf '%s\n' "$HOME/.codex"
  fi
}

# Raw copy (no banner). For files whose syntax a markdown comment would break
# (JSON like hooks.json, or shell scripts). Preserves +x for *.sh.
_deploy_raw_copy() {
  local src="$1"
  local dst="$2"
  if [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" = "1" ]; then
    printf '    DRY: would copy (raw) %s\n' "$dst"
    return
  fi
  cp "$src" "$dst"
  case "$src" in
    *.sh) chmod +x "$dst" ;;
  esac
}

# ---------- per-shape deploy ------------------------------------------------

# Deploy claude/{agents,commands/fb}/ from $bundle_dir into <dst>/.claude/.
# Creates the destination subdirs on demand. Skips silently if the bundle
# has no claude/ subtree.
_deploy_claude_into() {
  local bundle_dir="$1" bundle_name="$2" dst="$3" label="$4" nautilo_root="$5"
  local src="$bundle_dir/claude"
  [ -d "$src" ] || return 0

  if _deploy_already _DEPLOY_PATHS_CLAUDE "$dst"; then
    printf '  skip (claude): %s (already deployed above)\n' "$dst"
    return 0
  fi

  if [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" != "1" ]; then
    mkdir -p "$dst/.claude/agents" "$dst/.claude/commands/fb"
  fi

  local count=0
  if [ -d "$src/agents" ]; then
    for f in "$src/agents/"*.md; do
      [ -e "$f" ] || continue
      _deploy_stamp_and_copy "$f" "$dst/.claude/agents/$(basename "$f")" "$bundle_name" "$nautilo_root"
      count=$((count + 1))
    done
  fi
  if [ -d "$src/commands/fb" ]; then
    for f in "$src/commands/fb/"*.md; do
      [ -e "$f" ] || continue
      _deploy_stamp_and_copy "$f" "$dst/.claude/commands/fb/$(basename "$f")" "$bundle_name" "$nautilo_root"
      count=$((count + 1))
    done
  fi

  _deploy_mark _DEPLOY_PATHS_CLAUDE "$dst"
  printf '  synced %s file(s) to .claude/ (%s): %s\n' "$count" "$label" "$dst"
}

# Deploy cursor/{commands,rules}/ from $bundle_dir into <dst>/.cursor/.
_deploy_cursor_into() {
  local bundle_dir="$1" bundle_name="$2" dst="$3" label="$4" nautilo_root="$5"
  local src="$bundle_dir/cursor"
  [ -d "$src" ] || return 0

  if _deploy_already _DEPLOY_PATHS_CURSOR "$dst"; then
    printf '  skip (cursor): %s (already deployed above)\n' "$dst"
    return 0
  fi

  if [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" != "1" ]; then
    mkdir -p "$dst/.cursor/commands" "$dst/.cursor/rules"
  fi

  local count=0
  if [ -d "$src/commands" ]; then
    for f in "$src/commands/"*.md; do
      [ -e "$f" ] || continue
      _deploy_stamp_and_copy "$f" "$dst/.cursor/commands/$(basename "$f")" "$bundle_name" "$nautilo_root"
      count=$((count + 1))
    done
  fi
  if [ -d "$src/rules" ]; then
    for f in "$src/rules/"*.mdc; do
      [ -e "$f" ] || continue
      _deploy_stamp_and_copy "$f" "$dst/.cursor/rules/$(basename "$f")" "$bundle_name" "$nautilo_root"
      count=$((count + 1))
    done
  fi

  # cursor/skills/<name>/SKILL.md (+ sibling files) -> .cursor/skills/<name>/
  # SKILL.md is markdown (banner ok); any non-markdown sibling is copied raw.
  if [ -d "$src/skills" ]; then
    for skill_dir in "$src/skills/"*/; do
      [ -d "$skill_dir" ] || continue
      local skill_name dst_skill_dir
      skill_name="$(basename "$skill_dir")"
      dst_skill_dir="$dst/.cursor/skills/$skill_name"
      [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" != "1" ] && mkdir -p "$dst_skill_dir"
      for f in "$skill_dir"*; do
        [ -e "$f" ] || continue
        case "$f" in
          *.md) _deploy_stamp_and_copy "$f" "$dst_skill_dir/$(basename "$f")" "$bundle_name" "$nautilo_root" ;;
          *)    _deploy_raw_copy "$f" "$dst_skill_dir/$(basename "$f")" ;;
        esac
        count=$((count + 1))
      done
    done
  fi

  # cursor/hooks.json -> .cursor/hooks.json ; cursor/hooks/* -> .cursor/hooks/
  # Raw copies (JSON / shell — a markdown banner would break them).
  if [ -f "$src/hooks.json" ]; then
    _deploy_raw_copy "$src/hooks.json" "$dst/.cursor/hooks.json"
    count=$((count + 1))
  fi
  if [ -d "$src/hooks" ]; then
    [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" != "1" ] && mkdir -p "$dst/.cursor/hooks"
    for f in "$src/hooks/"*; do
      [ -e "$f" ] || continue
      _deploy_raw_copy "$f" "$dst/.cursor/hooks/$(basename "$f")"
      count=$((count + 1))
    done
  fi

  _deploy_mark _DEPLOY_PATHS_CURSOR "$dst"
  printf '  synced %s file(s) to .cursor/ (%s): %s\n' "$count" "$label" "$dst"
}

# Deploy codex/prompts/*.md into <codex-home>/prompts/. If a bundle does not
# ship a Codex-specific prompt directory, reuse cursor/commands/ or
# claude/commands/fb/ so existing slash-command bundles stay single-source.
_deploy_codex_into() {
  local bundle_dir="$1" bundle_name="$2" codex_home="$3" label="$4" nautilo_root="$5"
  local src
  src="$(_deploy_codex_prompt_source_dir "$bundle_dir")"
  [ -n "$src" ] || return 0
  [ -d "$src" ] || return 0

  local codex_home_canon="$codex_home"
  if [ -d "$codex_home" ]; then
    codex_home_canon="$(cd "$codex_home" && pwd)"
  fi

  if _deploy_already _DEPLOY_PATHS_CODEX "$codex_home_canon"; then
    printf '  skip (codex): %s (already deployed above)\n' "$codex_home"
    return 0
  fi

  if [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" != "1" ]; then
    mkdir -p "$codex_home/prompts"
  fi

  local count=0
  for f in "$src/"*.md; do
    [ -e "$f" ] || continue
    _deploy_stamp_and_copy "$f" "$codex_home/prompts/$(basename "$f")" "$bundle_name" "$nautilo_root"
    count=$((count + 1))
  done

  _deploy_mark _DEPLOY_PATHS_CODEX "$codex_home_canon"
  printf '  synced %s file(s) to Codex prompts (%s): %s/prompts\n' "$count" "$label" "$codex_home"
}

# Deploy codex/skills/<name> recursively into <codex-home>/skills/<name>.
# Skill frontmatter must remain the first bytes of SKILL.md, so these files are
# copied raw rather than receiving the deployed Markdown banner used by prompts.
_deploy_codex_skills_into() {
  local bundle_dir="$1" bundle_name="$2" codex_home="$3" label="$4"
  local src="$bundle_dir/codex/skills"
  [ -d "$src" ] || return 0

  local codex_home_canon="$codex_home"
  if [ -d "$codex_home" ]; then
    codex_home_canon="$(cd "$codex_home" && pwd)"
  fi
  if _deploy_already _DEPLOY_PATHS_CODEX_SKILLS "$codex_home_canon"; then
    printf '  skip (codex skills): %s (already deployed above)\n' "$codex_home"
    return 0
  fi

  local count=0 skill_dir skill_name file relative_path destination
  for skill_dir in "$src/"*/; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    while IFS= read -r -d '' file; do
      relative_path="${file#"$skill_dir"}"
      destination="$codex_home/skills/$skill_name/$relative_path"
      [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" != "1" ] && mkdir -p "$(dirname "$destination")"
      _deploy_raw_copy "$file" "$destination"
      count=$((count + 1))
    done < <(find "$skill_dir" -type f -print0)
  done

  _deploy_mark _DEPLOY_PATHS_CODEX_SKILLS "$codex_home_canon"
  printf '  synced %s file(s) to Codex skills (%s, bundle %s): %s/skills\n' "$count" "$label" "$bundle_name" "$codex_home"
}

# ---------- main entry: deploy_bundle ---------------------------------------

# deploy_bundle <bundle_dir> <bundle_name> [legacy_extra_claude_var]
#
# bundle_dir: absolute path to the bundle directory (typically $HERE in
#             the wrapper).
# bundle_name: short name used in log lines and the deployed-copy banner
#              (typically the directory basename — e.g. "phase-end").
# legacy_extra_claude_var: optional name of a legacy env var (e.g.
#              PRE_FLIGHT_EXTRA_CLAUDE_DIRS) to honor in addition to the
#              global NAUTILO_EXTRA_CLAUDE_DIRS. Pass nothing to skip.
deploy_bundle() {
  local bundle_dir="$1"
  local bundle_name="$2"
  local legacy_var="${3:-}"

  # bundle_dir = <repo>/dev/tools/<bundle>  ->  three levels up
  local nautilo_root
  nautilo_root="$(cd "$bundle_dir/../../.." && pwd)"

  if [ ! -d "$bundle_dir/claude" ] && [ ! -d "$bundle_dir/cursor" ] && [ ! -d "$bundle_dir/codex" ]; then
    printf 'FATAL: bundle %s has none of claude/, cursor/, or codex/ subdirs.\n' "$bundle_dir" >&2
    exit 1
  fi

  printf '=== %s bundle install ===\n' "$bundle_name"
  printf 'bundle:  %s\n' "$bundle_dir"
  printf 'nautilo: %s\n' "$nautilo_root"
  [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" = "1" ] && printf 'mode:    DRY RUN (no writes)\n'
  printf '\n'

  # Reset dedup tables per bundle, since the same bundle's files go into
  # the same destination dir and dedup is per-(destination, shape).
  _DEPLOY_PATHS_CLAUDE=""
  _DEPLOY_PATHS_CURSOR=""
  _DEPLOY_PATHS_CODEX=""
  _DEPLOY_PATHS_CODEX_SKILLS=""

  # Resolve nautilo's GitHub slug to find companion repos.
  local nautilo_remote nautilo_slug nautilo_org nautilo_repo
  nautilo_remote="$(git -C "$nautilo_root" config --get remote.origin.url 2>/dev/null || echo '')"
  nautilo_slug="$(_deploy_parse_github_slug "$nautilo_remote")"
  nautilo_org="${nautilo_slug%%/*}"
  nautilo_repo="${nautilo_slug##*/}"
  if [ -z "$nautilo_slug" ] || [ "$nautilo_org" = "$nautilo_slug" ]; then
    printf 'warn: could not parse github slug from %s — companion discovery off.\n' "$nautilo_remote" >&2
    nautilo_slug=""
  fi

  # ---- [1] nautilo worktrees -> .claude ------------------------------------
  printf '[1] nautilo worktrees (.claude):\n'
  while IFS= read -r wt; do
    case "$wt" in
      /tmp/*|'') continue ;;
    esac
    [ -d "$wt" ] || continue
    local wt_canon
    wt_canon="$(cd "$wt" && pwd)"
    _deploy_claude_into "$bundle_dir" "$bundle_name" "$wt_canon" "worktree" "$nautilo_root"
  done < <(git -C "$nautilo_root" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')

  # ---- [2] companion repos -> .claude --------------------------------------
  printf '\n[2] companion repos (.claude, sibling repos with .claude/ in same org, prefix "%s"):\n' "$nautilo_repo"
  if [ -n "$nautilo_slug" ]; then
    local parent_dir
    parent_dir="$(cd "$nautilo_root/.." 2>/dev/null && pwd || true)"
    if [ -n "$parent_dir" ] && [ -d "$parent_dir" ]; then
      local found_companion=0
      for sibling in "$parent_dir"/*/; do
        sibling="${sibling%/}"
        [ -d "$sibling" ] || continue
        [ -e "$sibling/.git" ] || continue
        [ -d "$sibling/.claude" ] || continue

        local sibling_remote sibling_slug sibling_org sibling_repo
        sibling_remote="$(git -C "$sibling" config --get remote.origin.url 2>/dev/null || echo '')"
        [ -z "$sibling_remote" ] && continue
        sibling_slug="$(_deploy_parse_github_slug "$sibling_remote")"
        sibling_org="${sibling_slug%%/*}"
        sibling_repo="${sibling_slug##*/}"

        [ "$sibling_org" = "$nautilo_org" ] || continue
        case "$sibling_repo" in
          "$nautilo_repo"|"${nautilo_repo}-"*|"${nautilo_repo}_"*) ;;
          *) continue ;;
        esac

        local sibling_canon
        sibling_canon="$(cd "$sibling" && pwd)"
        _deploy_already _DEPLOY_PATHS_CLAUDE "$sibling_canon" && continue

        found_companion=1
        _deploy_claude_into "$bundle_dir" "$bundle_name" "$sibling_canon" "companion:$sibling_slug" "$nautilo_root"
      done
      [ "$found_companion" = "0" ] && printf '  (none found — no sibling repos with .claude/ matching %s/%s*)\n' "$nautilo_org" "$nautilo_repo"
    else
      printf '  skip: parent dir %s/.. not accessible\n' "$nautilo_root"
    fi
  else
    printf '  skip: no nautilo remote slug\n'
  fi

  # ---- [3] env-override extra .claude dirs ---------------------------------
  printf '\n[3] env-override .claude dirs (NAUTILO_EXTRA_CLAUDE_DIRS'
  [ -n "$legacy_var" ] && printf ' + %s' "$legacy_var"
  printf '):\n'
  local extra_claude="${NAUTILO_EXTRA_CLAUDE_DIRS:-}"
  if [ -n "$legacy_var" ]; then
    local legacy_val="${!legacy_var:-}"
    if [ -n "$legacy_val" ]; then
      extra_claude="${extra_claude:+$extra_claude:}$legacy_val"
    fi
  fi
  if [ -n "$extra_claude" ]; then
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      [ -d "$p" ] || { printf '  skip: %s (does not exist)\n' "$p"; continue; }
      _deploy_claude_into "$bundle_dir" "$bundle_name" "$(cd "$p" && pwd)" "env-override" "$nautilo_root"
    done < <(printf '%s' "$extra_claude" | tr ':' '\n')
  else
    printf '  (env vars not set; skip)\n'
  fi

  # ---- [4] cursor workspace root -> .cursor --------------------------------
  printf '\n[4] cursor workspace root (.cursor, first ancestor of nautilo with .cursor/):\n'
  if [ -d "$bundle_dir/cursor" ]; then
    local cursor_root
    cursor_root="$(_deploy_find_cursor_workspace "$(dirname "$nautilo_root")")"
    if [ -n "$cursor_root" ]; then
      _deploy_cursor_into "$bundle_dir" "$bundle_name" "$cursor_root" "ancestor" "$nautilo_root"
    else
      printf '  (no ancestor of %s contains .cursor/; skip)\n' "$nautilo_root"
    fi
  else
    printf '  (bundle has no cursor/ subdir; skip)\n'
  fi

  # ---- [5] env-override extra .cursor dirs ---------------------------------
  printf '\n[5] env-override .cursor dirs (NAUTILO_EXTRA_CURSOR_DIRS):\n'
  if [ -d "$bundle_dir/cursor" ] && [ -n "${NAUTILO_EXTRA_CURSOR_DIRS:-}" ]; then
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      [ -d "$p" ] || { printf '  skip: %s (does not exist)\n' "$p"; continue; }
      _deploy_cursor_into "$bundle_dir" "$bundle_name" "$(cd "$p" && pwd)" "env-override" "$nautilo_root"
    done < <(printf '%s' "${NAUTILO_EXTRA_CURSOR_DIRS}" | tr ':' '\n')
  else
    printf '  (env var not set or bundle has no cursor/ subdir; skip)\n'
  fi

  # ---- [6] Codex home -> prompts ------------------------------------------
  printf '\n[6] Codex prompts and skills (NAUTILO_CODEX_HOME, CODEX_HOME, or ~/.codex):\n'
  local codex_home
  codex_home="$(_deploy_default_codex_home)"
  if [ -n "$(_deploy_codex_prompt_source_dir "$bundle_dir")" ]; then
    _deploy_codex_into "$bundle_dir" "$bundle_name" "$codex_home" "default" "$nautilo_root"
  else
    printf '  (bundle has no Codex-compatible prompts; skip prompts)\n'
  fi
  _deploy_codex_skills_into "$bundle_dir" "$bundle_name" "$codex_home" "default"

  # ---- [7] env-override extra Codex homes ---------------------------------
  printf '\n[7] env-override Codex homes (NAUTILO_EXTRA_CODEX_HOMES):\n'
  if { [ -n "$(_deploy_codex_prompt_source_dir "$bundle_dir")" ] || [ -d "$bundle_dir/codex/skills" ]; } && [ -n "${NAUTILO_EXTRA_CODEX_HOMES:-}" ]; then
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      [ -n "$(_deploy_codex_prompt_source_dir "$bundle_dir")" ] && _deploy_codex_into "$bundle_dir" "$bundle_name" "$p" "env-override" "$nautilo_root"
      _deploy_codex_skills_into "$bundle_dir" "$bundle_name" "$p" "env-override"
    done < <(printf '%s' "${NAUTILO_EXTRA_CODEX_HOMES}" | tr ':' '\n')
  else
    printf '  (env var not set or bundle has no Codex content; skip)\n'
  fi

  printf '\n=== %s done ===\n\n' "$bundle_name"
}

# ---------- prune stale deployed commands -----------------------------------

# Return 0 if $1 is a line in newline-separated list $2.
_deploy_list_contains() {
  local needle="$1" haystack="$2"
  case "$haystack" in
    *$'\n'"$needle"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Build newline-wrapped canonical basename lists from every bundle under
# $tools_dir. Sets global vars _PRUNE_CLAUDE_FB, _PRUNE_CURSOR, _PRUNE_CODEX.
_deploy_collect_canonical_command_lists() {
  local tools_dir="$1"
  _PRUNE_CLAUDE_FB=$'\n'
  _PRUNE_CURSOR=$'\n'
  _PRUNE_CODEX=$'\n'

  local inst bundle_dir base
  for inst in "$tools_dir"/*/install.sh; do
    [ -e "$inst" ] || continue
    bundle_dir="$(dirname "$inst")"
    case "$(basename "$bundle_dir")" in
      _*) continue ;;
    esac

    if [ -d "$bundle_dir/claude/commands/fb" ]; then
      for f in "$bundle_dir/claude/commands/fb/"*.md; do
        [ -e "$f" ] || continue
        base="$(basename "$f")"
        _deploy_list_contains "$base" "$_PRUNE_CLAUDE_FB" || _PRUNE_CLAUDE_FB="${_PRUNE_CLAUDE_FB}${base}"$'\n'
        _deploy_list_contains "$base" "$_PRUNE_CODEX" || _PRUNE_CODEX="${_PRUNE_CODEX}${base}"$'\n'
      done
    fi
    if [ -d "$bundle_dir/cursor/commands" ]; then
      for f in "$bundle_dir/cursor/commands/"*.md; do
        [ -e "$f" ] || continue
        base="$(basename "$f")"
        _deploy_list_contains "$base" "$_PRUNE_CURSOR" || _PRUNE_CURSOR="${_PRUNE_CURSOR}${base}"$'\n'
        _deploy_list_contains "$base" "$_PRUNE_CODEX" || _PRUNE_CODEX="${_PRUNE_CODEX}${base}"$'\n'
      done
    fi
    if [ -d "$bundle_dir/codex/prompts" ]; then
      for f in "$bundle_dir/codex/prompts/"*.md; do
        [ -e "$f" ] || continue
        base="$(basename "$f")"
        _deploy_list_contains "$base" "$_PRUNE_CODEX" || _PRUNE_CODEX="${_PRUNE_CODEX}${base}"$'\n'
      done
    fi
  done
}

# Remove stale *.md in $dir whose basename is not in canonical list $2.
# $3 = label for log lines (e.g. ".claude/commands/fb").
_deploy_prune_md_dir() {
  local dir="$1" canonical_list="$2" label="$3"
  [ -d "$dir" ] || return 0

  local f base removed=0
  for f in "$dir"/*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if _deploy_list_contains "$base" "$canonical_list"; then
      continue
    fi
    if [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" = "1" ]; then
      printf '  would prune: %s/%s\n' "$label" "$base"
    else
      rm -f "$f"
      printf '  pruned: %s/%s\n' "$label" "$base"
    fi
    removed=$((removed + 1))
  done
  return 0
}

# Prune stale command copies at one destination root ($1).
_deploy_prune_destination() {
  local dst="$1" label="$2"
  _deploy_prune_md_dir "$dst/.claude/commands/fb" "$_PRUNE_CLAUDE_FB" "$label/.claude/commands/fb"
  _deploy_prune_md_dir "$dst/.cursor/commands" "$_PRUNE_CURSOR" "$label/.cursor/commands"
}

# Prune stale Codex prompts in one Codex home ($1).
_deploy_prune_codex_home() {
  local codex_home="$1" label="$2"
  _deploy_prune_md_dir "$codex_home/prompts" "$_PRUNE_CODEX" "$label/prompts"
}

# deploy_prune_stale_commands <dev/tools/dir>
#
# Called by install-all.sh after all bundles deploy when NAUTILO_DEPLOY_PRUNE=1.
# Removes deployed command .md files that no longer have a bundle canonical.
deploy_prune_stale_commands() {
  local tools_dir="$1"
  local nautilo_root
  nautilo_root="$(cd "$tools_dir/../.." && pwd)"

  printf '\n===== prune: stale deployed commands =====\n'
  printf 'tools:   %s\n' "$tools_dir"
  printf 'nautilo: %s\n' "$nautilo_root"
  [ "${NAUTILO_DEPLOY_DRY_RUN:-0}" = "1" ] && printf 'mode:    DRY RUN (no deletes)\n'
  printf '\n'

  _deploy_collect_canonical_command_lists "$tools_dir"

  # ---- [1] nautilo worktrees -----------------------------------------------
  printf '[1] nautilo worktrees:\n'
  while IFS= read -r wt; do
    case "$wt" in
      /tmp/*|'') continue ;;
    esac
    [ -d "$wt" ] || continue
    local wt_canon
    wt_canon="$(cd "$wt" && pwd)"
    _deploy_prune_destination "$wt_canon" "worktree:$wt_canon"
  done < <(git -C "$nautilo_root" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')

  # ---- [2] companion repos -------------------------------------------------
  printf '\n[2] companion repos:\n'
  local nautilo_remote nautilo_slug nautilo_org nautilo_repo
  nautilo_remote="$(git -C "$nautilo_root" config --get remote.origin.url 2>/dev/null || echo '')"
  nautilo_slug="$(_deploy_parse_github_slug "$nautilo_remote")"
  nautilo_org="${nautilo_slug%%/*}"
  nautilo_repo="${nautilo_slug##*/}"
  if [ -n "$nautilo_slug" ] && [ "$nautilo_org" != "$nautilo_slug" ]; then
    local parent_dir
    parent_dir="$(cd "$nautilo_root/.." 2>/dev/null && pwd || true)"
    if [ -n "$parent_dir" ] && [ -d "$parent_dir" ]; then
      local found_companion=0 sibling
      for sibling in "$parent_dir"/*/; do
        sibling="${sibling%/}"
        [ -d "$sibling" ] || continue
        [ -e "$sibling/.git" ] || continue
        [ -d "$sibling/.claude" ] || continue

        local sibling_remote sibling_slug sibling_org sibling_repo sibling_canon
        sibling_remote="$(git -C "$sibling" config --get remote.origin.url 2>/dev/null || echo '')"
        [ -z "$sibling_remote" ] && continue
        sibling_slug="$(_deploy_parse_github_slug "$sibling_remote")"
        sibling_org="${sibling_slug%%/*}"
        sibling_repo="${sibling_slug##*/}"
        [ "$sibling_org" = "$nautilo_org" ] || continue
        case "$sibling_repo" in
          "$nautilo_repo"|"${nautilo_repo}-"*|"${nautilo_repo}_"*) ;;
          *) continue ;;
        esac
        sibling_canon="$(cd "$sibling" && pwd)"
        _deploy_prune_destination "$sibling_canon" "companion:$sibling_canon"
        found_companion=$((found_companion + 1))
      done
      [ "$found_companion" = "0" ] && printf '  (none found)\n'
    fi
  else
    printf '  skip: no nautilo remote slug\n'
  fi

  # ---- [3] env-override .claude / .cursor dirs -----------------------------
  if [ -n "${NAUTILO_EXTRA_CLAUDE_DIRS:-}${NAUTILO_EXTRA_CURSOR_DIRS:-}" ]; then
    printf '\n[3] env-override dirs:\n'
    if [ -n "${NAUTILO_EXTRA_CLAUDE_DIRS:-}" ]; then
      while IFS= read -r p; do
        [ -z "$p" ] && continue
        [ -d "$p" ] || continue
        _deploy_prune_destination "$(cd "$p" && pwd)" "env-claude:$p"
      done < <(printf '%s' "${NAUTILO_EXTRA_CLAUDE_DIRS}" | tr ':' '\n')
    fi
    if [ -n "${NAUTILO_EXTRA_CURSOR_DIRS:-}" ]; then
      while IFS= read -r p; do
        [ -z "$p" ] && continue
        [ -d "$p" ] || continue
        _deploy_prune_destination "$(cd "$p" && pwd)" "env-cursor:$p"
      done < <(printf '%s' "${NAUTILO_EXTRA_CURSOR_DIRS}" | tr ':' '\n')
    fi
  fi

  # ---- [4] cursor workspace root -------------------------------------------
  printf '\n[4] cursor workspace root:\n'
  local cursor_root
  cursor_root="$(_deploy_find_cursor_workspace "$(dirname "$nautilo_root")")"
  if [ -n "$cursor_root" ]; then
    _deploy_prune_destination "$cursor_root" "cursor-root:$cursor_root"
  else
    printf '  (no ancestor with .cursor/; skip)\n'
  fi

  # ---- [5] Codex homes -----------------------------------------------------
  printf '\n[5] Codex prompts:\n'
  local codex_home
  codex_home="$(_deploy_default_codex_home)"
  _deploy_prune_codex_home "$codex_home" "codex:$codex_home"
  if [ -n "${NAUTILO_EXTRA_CODEX_HOMES:-}" ]; then
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      _deploy_prune_codex_home "$p" "codex-env:$p"
    done < <(printf '%s' "${NAUTILO_EXTRA_CODEX_HOMES}" | tr ':' '\n')
  fi

  printf '\n===== prune done =====\n\n'
}
