---
name: release-notes
description: Draft release notes from recent changes. $ARGUMENTS is the version, tag, or commit range to cover (e.g. "v1.4.0", "since v1.3.0", "this sprint"). Write for the people who will upgrade.
source: official
version: 1
---
Draft release notes for the version / range given in $ARGUMENTS. Write for the operator who will read them when deciding whether and how to upgrade — not for the author who wrote the changes.

Source your material from the actual changeset (git log, merged PRs, diffs, CHANGELOG if present). Do not invent changes; if a category is empty, omit it rather than padding it.

Structure:
1. **Version + date** at the top.
2. **Summary** — two or three sentences: what this release is, why someone would upgrade, and anything they must know before they do.
3. **Added** — new features and capabilities, each as a bullet. Lead with the user-facing payoff, then the technical detail in parentheses.
4. **Changed** — behavior changes, updated APIs, renamed symbols, new defaults. Be explicit about what's different and whether it's backward-compatible.
5. **Fixed** — bugs and regressions, with enough context that a reader can recognize whether they were affected.
6. **Removed** — deprecated things that are now gone, and what to use instead.
7. **Upgrade notes** (only if needed) — concrete steps a user must take: a required migration, an env var rename, a config format change, a minimum runtime bump.
8. **Internal / contributor notes** (only if the audience is internal) — test infrastructure, build changes, anything that only matters to people working in the repo.

Rules:
- One bullet per change. Past tense, active voice ("Added X", "Fixed Y when Z").
- Group by category; do not invent a "Miscellaneous" bucket.
- If $ARGUMENTS is empty or ambiguous, infer the range from the most recent tag to HEAD and state the inferred range at the top so the user can correct it.
