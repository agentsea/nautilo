# Partial codebase security scan report

- Task: `49e40a82-fef0-43c2-afb8-211b0ea4a41f`
- Run: `dc7a6c06-9358-4f7a-9e8b-e892f2e26579`
- Model: `openrouter:z-ai/glm-5.3`
- Generated: 2026-09-06T20:17:10.625Z

**The finalized ledger is partial. Repository research coverage and scanner coverage are separate: inspect the recorded source gaps, probe failures and external assumptions below. Execution completion and full ledger retrieval do not establish a comprehensive audit.**

## Report and limitations

# Codebase Security Research Report — nautilo-d578-audit (Project Document Service)

## 1. Executive Verdict

**The authorization model of this service is broken in three distinct, confirmed ways.** All repository source was read in full (7 files, ~150 lines) and every requested section and cross-section boundary was traced.

**Findings: 1 Critical, 2 High, 0 Medium, 0 Low.**

- **C-1 (Critical):** The `readDecisions` authorization cache is keyed by project only — the first user to query a project sets the read permission for *every* user, and the cache is never invalidated.
- **H-2 (High):** Export creation authorizes the client-selected `projectId` but never binds the requested `documentId` to it — any member can exfiltrate any other project's documents via the export pipeline.
- **H-3 (High):** Queued/ready export jobs are perpetual grants — neither the worker at execution time nor `downloadExport` re-checks membership, violating the README's stated revocation requirement.

The service does have genuine protections (fail-closed session checks, fresh membership checks on preview/export-creation, job-owner-only download), but C-1 and H-2 each independently defeat document confidentiality.

Terminal state: **partial** — solely because the OSV dependency probe was unavailable (no supported package sources; the project intentionally has zero dependencies). All repository sections and boundaries are fully reviewed; there is no unread in-scope source.

## 2. Scope, Method, Provenance, Repository State

- **Target:** `<standalone-fixture>` (Current Folder), scanned as requested. Read-only; no code executed, no shell, no network, no mutations.
- **Method:** deep_research via `security_scan` (model: `openrouter:z-ai/glm-5.3`), plus full manual reads of every file: `README.md`, `package.json`, `behavior.test.mjs`, `packages/http/api.mjs` (39 lines), `packages/identity/policy.mjs` (16 lines), `packages/storage/store.mjs` (14 lines), `packages/jobs/worker.mjs` (9 lines).
- **Scanner provenance:** gitleaks ✅ completed (0 observations), semgrep ✅ completed (0 observations), trivy ✅ completed (0 observations), osv_scanner ⚠️ unavailable (no supported package sources — the repo has no dependencies by design; nothing to verify, nothing denied).
- **Repository state:** synthetic local fixture, Node ESM, no dependencies, not deployed. Git HEAD/dirty state unknown (no git-provenance tool available in this task; `.git` directory exists on disk).
- **Trust assumption (deployment fact, not repo fact):** a trusted upstream gateway supplies verified `session.userId` (README:3–5). The gateway implementation is external to the repository and was not reviewed; no bypass was inferred from this assumption.

## 3. Immediate Actions

| # | Finding | Action |
|---|---------|--------|
| 1 | C-1 | Fix `canRead` cache key to include `userId` (or drop the cache) and add invalidation on membership change |
| 2 | H-2 | In `createExport`, resolve the document and require `doc.projectId === body.projectId` before queueing |
| 3 | H-3 | Add membership re-check in the worker before materializing results and in `downloadExport` before returning them |

## 4. Findings

### C-1 (Critical — confidence: high — status: confirmed)
**readDecisions authorization cache ignores user identity — cross-user access control bypass**

- **Evidence:** `packages/identity/policy.mjs:6–12`; sink at `packages/http/api.mjs:5–12`; cache init `packages/storage/store.mjs:13`.
- **Trace:** session userId (trusted gateway) → `requireSession` → `canRead(store, userId, projectId)` → `store.readDecisions.get(projectId)` returns a cached boolean computed for a *previous, different* user → `doc.body` returned.
- **Exploit preconditions:** Shared store across users (stated in README); project queried at least once by anyone.
- **Impact:** If alice (orchard member) reads any orchard document first, bob (harbor-only, never an orchard member) is then granted `doc-orchard`. Conversely, a non-member's cached denial blocks all real members (DoS). No TTL or invalidation exists anywhere in the repo.
- **Counterevidence checked:** No invalidation hook, per-user key, or cache scoping anywhere; all callers of `canRead` traced (only `readDocument`).
- **Remediation:** Key the cache by `${userId}:${projectId}` or remove it entirely; invalidate on membership mutation.
- **Verification test:** `readDocument(store, {userId:'alice'}, 'doc-orchard'); assert.throws(() => readDocument(store, {userId:'bob'}, 'doc-orchard'))` — currently bob succeeds; must throw.

### H-2 (High — confidence: high — status: confirmed)
**Export creation does not bind documentId to the authorized projectId — cross-project document exfiltration**

- **Evidence:** `packages/http/api.mjs:14–21` (creation), `packages/jobs/worker.mjs:2–8` (worker), `packages/http/api.mjs:23–28` (download).
- **Trace:** client-controlled `body.documentId` → `requireFreshMembership(store, userId, body.projectId)` authorizes only the *declared* project → job persisted with unvalidated `documentId` → worker reads `store.documents.get(job.documentId)` with no authorization check → CSV `job.result` → `downloadExport` checks only `job.userId === creator` and returns the content.
- **Exploit preconditions:** Authenticated member of any project; knowledge/guess of a foreign document id (ids are plain slugs like `doc-harbor`); worker runs before download.
- **Impact:** Any member of 'orchard' can POST `{projectId:'orchard', documentId:'doc-harbor'}` and receive harbor's document body. Full cross-tenant exfiltration.
- **Counterevidence checked:** All four handlers and the worker read in full — no path re-validates document/project ownership.
- **Remediation:** In `createExport`, look up the document, throw if missing, and require `doc.projectId === body.projectId` (or derive `projectId` from the document and check membership on that).
- **Verification test:** `assert.throws(() => createExport(store, {userId:'alice'}, {projectId:'orchard', documentId:'doc-harbor'}))`.

### H-3 (High — confidence: high — status: confirmed, latent)
**Queued/ready export jobs bypass membership revocation — a job result is a perpetual disclosure grant**

- **Evidence:** `packages/jobs/worker.mjs:2–8`; `packages/http/api.mjs:23–28`; stated requirement `README.md:13–15` ("A queued job is work to validate, not a perpetual grant"; revocation "must prevent queued exports from disclosing the former project's documents").
- **Trace:** job `{userId, projectId, documentId}` persisted at creation → worker copies `doc.body` into `job.result` unconditionally, with no membership re-check at execution → `downloadExport` returns the stored result after only an ownership check, with no fresh membership check.
- **Exploit preconditions:** Job created while a member; membership later revoked; user downloads own job (queued-then-processed or already-ready).
- **Impact:** Former members retain permanent access to former project documents through exports. Note: no membership-revocation API exists in the repo yet, so the flaw is latent — but the README's security requirements explicitly demand it, and any revocation feature built on this code will fail them.
- **Counterevidence checked:** No membership re-validation at either execution or download; no expiry/cancellation of jobs anywhere.
- **Remediation:** Re-check `requireFreshMembership` in the worker before building the result (fail the job otherwise) and again in `downloadExport` before returning `job.result`; alternatively re-render at download time instead of storing the body.
- **Verification test:** create job as alice for orchard; remove alice from orchard's members; run worker; `assert.throws(() => downloadExport(store, {userId:'alice'}, id))`.

## 5. Scanner Observations Triage

All four scanner lanes returned **zero observations** (gitleaks, semgrep, trivy completed clean; osv unavailable — no dependencies to scan). Nothing to confirm, dismiss, or resolve; all findings above originate from manual cross-file investigation, as expected for logic-level authorization flaws that deterministic scanners don't catch.

## 6. Dismissed Hypotheses

- **H4 — input validation / prototype pollution:** `body.projectId` lacks a string type check, but nonexistent projects fail closed with `forbidden` (`policy.mjs:14–16`), all storage uses `Map.get` (prototype-safe), `requireSession` fails closed on missing sessions, and there is no eval/shell/file-write/network sink anywhere. **Dismissed as non-exploitable**; a type check is a robustness nicety only.

## 7. Coverage Matrix

| Surface | State | Notes |
|---|---|---|
| HTTP (`packages/http/api.mjs`) | ✅ Reviewed | All 4 handlers traced; C-1 sink, H-2/H-3 live here |
| Identity (`packages/identity/policy.mjs`) | ✅ Reviewed | `requireSession` fail-closed; `requireFreshMembership` correct; `canRead` broken (C-1) |
| Storage (`packages/storage/store.mjs`) | ✅ Reviewed | Maps only, prototype-safe; no membership-mutation APIs |
| Jobs (`packages/jobs/worker.mjs`) | ✅ Reviewed | No auth check on document read (H-2/H-3); no code-exec sinks |
| HTTP→identity | ✅ Reviewed | userId passed correctly; defect is in the cache, not the boundary |
| HTTP→storage | ✅ Reviewed | Map lookups fail closed; H-2 binding gap |
| HTTP/identity/storage→jobs | ✅ Reviewed | H-2 and H-3 |
| Jobs→storage | ✅ Reviewed | H-2 and H-3 |
| Output/error disclosure → HTTP | ✅ Reviewed | doc.body/job.result gated (incorrectly) by the defective checks; errors are generic (no info leak) |
| External gateway impl | ➖ Not applicable | Not in repository (README:3–5); trust assumption retained, no bypass inferred |

## 8. Limitations, Blockers, Unresolved Questions

- **osv_scanner lane unavailable** (probe_unavailable, non-retryable): the target has no supported package sources — the project has zero dependencies by design, so no dependency vulnerability coverage exists. This is the sole cause of the "partial" terminal state; it does not limit repository code review.
- **Gateway/session implementation** is external and unreviewed — a documented scope exclusion, not a blocker.
- **Git provenance unknown** — no git tool available; commit state not verified.
- No unresolved questions remain; no open records.

## 9. Prioritized Action Plan

**Now:** Fix C-1 (cache key + invalidation) and H-2 (document/project binding at export creation). Both are single-function changes in `policy.mjs` and `api.mjs`.

**Next:** Implement H-3's revocation semantics (worker-time and download-time membership re-checks); add regression tests for all three exploits — the existing `behavior.test.mjs` only covers happy paths and one denial, and explicitly warns it isn't comprehensive.

**Later:** Add explicit input type validation for `body.projectId`; when the external gateway lands, verify it actually authenticates sessions before trusting `session.userId`; consider re-rendering export content at download time instead of storing document bodies in job results.
