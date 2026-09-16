---
name: review-diff
description: Review the current diff or recent changes for bugs, regressions, risks, and style. Pass an optional path or scope in $ARGUMENTS to narrow what to review.
source: official
version: 1
---
Review the current diff / changeset as a senior engineer would. Be specific, cite file + line, and prioritize by severity. Do not rubber-stamp.

- **Bugs & correctness**: logic errors, off-by-ones, null/undefined mishandling, race conditions, wrong type, broken error paths, missing tests.
- **Regressions & blast radius**: callers of changed symbols, behavior changes that break existing contracts, migration/compat risks.
- **Security & data integrity**: input validation, authz, injection, secrets in logs, unsafe deserialization, money/data-loss paths.
- **Risks**: anything that could fail in production but not in the test suite. Name the failure mode.
- **Style & clarity**: misleading names, dead code, comments that narrate instead of explain intent, anything that makes the next reader slower.

If $ARGUMENTS is provided, narrow the review to that path / scope / commit range; still flag out-of-scope risks that the change introduces.

Output format:
1. **Verdict** — one line: ship / ship with fixes / block.
2. **Blocking issues** — bullets, each with file:line, what's wrong, and the fix.
3. **Non-blocking nits** — bullets.
4. **What I checked and looked fine** — one or two lines, so the reader knows what was covered.
