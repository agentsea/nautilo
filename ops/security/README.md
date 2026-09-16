# ops/security/

Security audits, red-team probes, and policy-enforcement scripts that run from
a developer machine or CI. These are NOT user-facing operator tools — they're
defense-in-depth checks against regression.

## Scripts here

| Script | Purpose | When to run |
|---|---|---|
| `red-team-env-var.sh` | D060 G5.6 — verifies the four banned policy-affecting env vars (`NAUTILO_SECURITY_LEVEL`, `NAUTILO_SANDBOX_RELAY`, `NAUTILO_DEPLOYMENT`, `NAUTILO_TLS`) have ZERO reads in `packages/`, `bin/`, `apps/` production source, AND that the corresponding ESLint rule (`no-policy-env-var`) fires correctly on a synthetic positive probe. | Locally before cutting a release build; in CI on every PR (TODO — not wired into a workflow yet; see "Future" below). |
| `google-key-probe.sh` | Detects Google API key strings (G-prefixed bare strings) in production source. | Locally before cutting a release build. |

## Conventions

- Scripts here MUST be self-contained and resolve their working directory robustly.
  Use `cd "$(dirname "$0")/../.."` to reach the repo root (note the TWO `..`),
  because these scripts live two levels deep (`ops/security/`) under the repo root.
- Exit code `0` = clean, non-zero = caller should fail.
- Don't print secret values. Pattern-match only; print the path + line range of any hit.

## Future

- Wire `red-team-env-var.sh` into the GitHub Actions `ci.yml` workflow on every PR.
  (Currently runs only on demand.)
- Add a `secrets-leak-probe.sh` companion that scans for leaked Anthropic / OpenAI keys
  by pattern (`sk-ant-`, `sk-proj-`, etc.).
