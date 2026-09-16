# Partial codebase security scan report

- Task: `7a529089-ff10-45a7-8e42-c9224df8c0d6`
- Run: `eea2200e-f9b0-42d9-b0c2-9cb02966b1fe`
- Model: `openrouter:z-ai/glm-5.3`
- Generated: 2026-09-06T19:49:40.594Z

**Research coverage is partial. Execution completion and full ledger retrieval do not establish a comprehensive audit.**

## Partial report and limitations

Ledger finalized (terminal state: partial, solely due to the external gateway blocker). Full report:

---

# Security Audit Report — Nautilo Document Service Fixture
**Target:** `<standalone-fixture>` (exact directory scanned; nothing outside it was accessed)
**Mode:** deep_research, read-only · **Model:** GLM 5.3 (security-research) · **Scanners:** gitleaks, trivy, semgrep (0 observations each); osv_scanner unavailable (no supported package sources — no dependencies verified, consistent with `package.json`, which declares none)
**State:** 7 repository files read in full; 5 hypotheses resolved (3 supported, 2 rejected); 3 findings; 2 dismissals; 1 external blocker. Terminal state `partial` **only** because the upstream gateway implementation is external and uninspectable under the audit constraints — all in-repo sections are fully reviewed.

## Executive verdict

**The service's access-control model is broken in three independent ways.** The read-authorization cache is keyed per-project rather than per-user, so one user's successful access grants (or denies) every other user (F1). Export jobs never bind the requested document to the membership-checked project, allowing any member to exfiltrate any document in the store (F2). And authorization is snapshotted at enqueue time, never revalidated at download — a direct violation of the repository's own stated revocation requirement (F3). Findings: **2 high, 1 medium-high, 0 critical, 0 low**.

## Immediate actions

| # | Finding | Severity | Fix priority |
|---|---------|----------|--------------|
| F1 | Authorization cache keyed by projectId only — cross-user permission bleed | High | Now |
| F2 | Export document/project unbound — cross-project disclosure | High | Now |
| F3 | Queued export survives membership revocation | Medium-High | Now |
| — | Gateway/transport layer | Limited | Blocker, not a defect |

## Findings

### F1 — Authorization cache keyed by project only (HIGH, confidence: high, confirmed)
- **Evidence:** `packages/identity/policy.mjs:6-12` — `canRead(store, userId, projectId)` returns `store.readDecisions.get(projectId)` if defined, and otherwise caches the membership result **for the project, not the (user, project) pair**. `packages/storage/store.mjs:10-14` defines `readDecisions` as a plain shared Map. Sole caller: `readDocument` at `packages/http/api.mjs:5-10`.
- **Trace:** session → `readDocument` → `canRead` → shared cache keyed by project → any user's decision reused for every user.
- **Exploit preconditions:** authenticated attacker knows a document id of a project they're not in (ids are guessable slugs like `doc-orchard`), and any member of that project has read once first.
- **Impact:** bob (non-member of orchard) receives 'orchard quarterly results'; reversed order of first access wrongly denies legitimate members (availability). No invalidation on membership change exists anywhere, so revocation never affects `readDocument` either.
- **Counterevidence checked:** searched for any invalidation/`delete` on `readDecisions` — none exists; the cache is only written inside `canRead`. No per-user keying anywhere.
- **Remediation:** key the cache on `` `${userId}:${projectId}` `` (or drop it); add an explicit invalidation hook on membership mutation; cap TTL.
- **Verification test:** after alice reads `doc-orchard` on a fresh store, `readDocument(store, {userId:'bob'}, 'doc-orchard')` must throw. Currently it returns the body.

### F2 — Export document/project unbound (HIGH, confidence: high, confirmed)
- **Evidence:** `packages/http/api.mjs:12-20` — `createExport` checks `requireFreshMembership(store, userId, body.projectId)` and only that `documentId` is a string; it never loads the document, never compares `doc.projectId === body.projectId`, never checks read permission on the document's actual project. `packages/jobs/worker.mjs:1-9` resolves by `documentId` alone and copies `doc.body` into `job.result` regardless of `job.projectId`.
- **Trace:** HTTP (project-level check) → jobs queue (unbound `documentId` persists) → worker reads storage directly (no identity dependency at all) → `downloadExport` returns `job.result` because ownership/state checks pass (`api.mjs:23-28`).
- **Exploit preconditions:** any authenticated user with membership in ≥1 project; document ids are trivially guessable.
- **Impact:** alice pairs `projectId:'orchard'` with `documentId:'doc-harbor'` and receives 'harbor acquisition planning'. Complete membership-boundary bypass for the export pipeline.
- **Counterevidence checked:** no downstream check anywhere reconciles `job.projectId` with `doc.projectId`; the worker imports nothing from identity.
- **Remediation:** in `createExport`, load the document, require it to exist, require `doc.projectId === body.projectId`, and run the authorization check against `doc.projectId`. Better: derive the project from the document server-side and drop the client-supplied `projectId` entirely.
- **Verification test:** `createExport(store, {userId:'alice'}, {projectId:'orchard', documentId:'doc-harbor'})` must throw. Currently it enqueues and, after the worker runs, downloads successfully.

### F3 — Queued export survives membership revocation (MEDIUM-HIGH, confidence: high, confirmed)
- **Evidence:** `packages/http/api.mjs:15` — membership checked only at enqueue; `api.mjs:23-28` — `downloadExport` checks only `job.userId === userId` and `state === 'ready'`, never current membership of `job.projectId`; `worker.mjs:1-9` materializes the body with no recheck. `README.md:11-14` explicitly requires that "Membership revocation must invalidate cached grants and prevent queued exports from disclosing the former project's documents… a queued job is work to validate, not a perpetual grant."
- **Exploit preconditions:** member queues an export, membership revoked, worker runs, user downloads.
- **Impact:** former member retains full document access through the export channel — a stated security requirement is violated.
- **Counterevidence checked:** no invalidation hook for jobs exists; nothing in policy/storage touches queued jobs on revocation.
- **Remediation:** re-run `requireFreshMembership(store, job.userId, job.projectId)` inside `downloadExport` (and ideally in the worker before materializing); or invalidate/fail queued jobs on membership revocation.
- **Verification test:** alice queues export of `doc-orchard`; remove alice from orchard members; run worker; `downloadExport` must throw. Currently it returns the export.

## Scanner observations triaged
gitleaks, trivy, semgrep: completed, **0 observations** — nothing to confirm or dismiss. osv_scanner: **unavailable** ("no supported package sources") — not a clean bill of health for dependencies; the repo simply declares none (`package.json`).

## Dismissed hypotheses (with counterevidence)
- **H4 — job-state error enumeration in `downloadExport`:** rejected. Ownership (`job.userId === userId`) is checked *before* the state check (`api.mjs:24-26`), so 'not found' vs 'not ready' is only distinguishable for jobs the caller owns; job ids are `randomUUID` (`api.mjs:16`), unguessable.
- **H5 — unverified gateway session trust:** rejected as a finding. `README.md:3-5` documents the gateway as the trusted, external session authority and explicitly states not to infer a bypass; no in-repo spoofing surface exists. Retained as a deployment assumption limitation.

## Coverage matrix

| Section | State | Basis |
|---|---|---|
| http (packages/http/api.mjs) | **Reviewed** | All 4 handlers traced; F1/F2/F3 confirmed; H4 dismissed |
| identity (packages/identity/policy.mjs) | **Reviewed** | All 3 exports traced to callers; cache flaw confirmed |
| storage (packages/storage/store.mjs) | **Reviewed** | Entire file inspected; shared Maps and cache key confirmed |
| jobs (packages/jobs/worker.mjs) | **Reviewed** | Entire worker traced; no authorization layer in section |
| cross_boundary | **Reviewed** | HTTP→identity (inconsistent cached vs fresh checks), HTTP→jobs (enqueue-time snapshot, unbound params), identity→storage (cross-user cache), jobs→storage (no policy call at all) |
| gateway_and_transport | **Limited — blocked** | External to repo (README:3-5); uninspectable under read-only/no-network constraints |

## Concrete blockers, probe failures, and limitations
- **Blocker:** the upstream gateway (session verification, cookie handling, real HTTP routing, error-to-HTTP mapping) is external to the repository. Severity ratings assume the fixture's data model applies verbatim in deployment; end-to-end wire-level exploitability could not be verified.
- **Probe:** osv_scanner unavailable — no dependencies were vulnerability-checked (none exist to check).
- **Tests:** `behavior.test.mjs` covers only happy paths plus two denials (bob cannot download alice's job; preview rejects a non-member). It exercises none of the conditions behind F1–F3, which is exactly why the shipped suite passes despite three real authorization failures.
- Git provenance is unknown (no authorized git tool used); repository files were treated as on-disk state only. No code was executed and no files were modified.

## Prioritized action plan
- **Now:** fix F1 (composite cache key + revocation invalidation), F2 (bind documentId to server-derived project + document-level authz), F3 (re-check membership at download/worker time). All three are small, localized changes to `policy.mjs` and `api.mjs`.
- **Next:** add regression tests for each finding's exact scenario (cross-user cache order, foreign documentId, revocation between queue and download).
- **Later:** if deployed behind the real gateway, audit the gateway's session verification and error mapping to close the limited-coverage gap; consider a policy dependency for the jobs section so the worker itself consults identity before materializing content.
