# Partial codebase security scan report

- Task: `fa0f8827-682e-41bc-801e-4a5ea306e57a`
- Run: `7fceb066-f81f-4434-9de2-169e6acbaea6`
- Model: `openai:gpt-5.6-sol`
- Generated: 2026-09-05T20:49:08.334Z

**Research coverage is partial. Execution completion and full ledger retrieval do not establish a comprehensive audit.**

## Partial report and limitations

# Partial Security Investigation Report — Document Service

## 1. Executive verdict

The accessible repository code contains **two high-severity tenant-isolation failures**. Both allow an authenticated user to obtain documents belonging to another project:

1. A shared authorization cache is keyed by project only, causing one user’s authorization result to be reused for other users.
2. Export creation authorizes one caller-supplied project while the worker reads an independently supplied document, allowing cross-project exports.

These are source-validated findings, not scanner matches.

The research ledger was finalized and fully retrieved across two pages (`nextCursor: null`, `reportReady: true`). The scan’s terminal state is nevertheless **partial** because the trusted authentication gateway was unavailable, tests could not be executed with the authorized read-only tools, dependency verification was unavailable, and revocation semantics are unspecified.

### Finding counts

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 2 |
| Medium | 0 |
| Low | 0 |
| Unresolved hypotheses | 1 |

---

## 2. Scope, method, provenance, and repository state

### Scope

Target: Current Folder, explicitly scanned as `targetDirectory="."` using `mode="deep_research"`.

Reviewed components:

- `api.mjs` — request-boundary functions
- `policy.mjs` — session and project-membership policy
- `store.mjs` — shared in-memory projects, documents, jobs, and authorization cache
- `worker.mjs` — asynchronous export processing
- `behavior.test.mjs` — existing behavioral tests
- `README.md`, `package.json`, `.gitignore`
- Ignored `dist/generated.js`
- Git branch and ref metadata

### Architecture and trust boundaries

The service trusts a gateway to validate session cookies and supply `session.userId`. API functions then:

- read documents directly;
- preview documents using a fresh membership check;
- create asynchronous export jobs;
- return completed exports to the user who created the job.

Projects, documents, jobs, export results, and authorization decisions share one store across users. Client-controlled document and project identifiers cross from the request boundary into that shared state.

### Method

The investigation:

- mapped all repository files and security-relevant entry points;
- searched all definitions, callers, state assignments, membership checks, and data sinks;
- traced identity and caller-controlled identifiers through direct-read and export flows;
- compared cached and fresh authorization paths;
- actively checked job ownership, preview authorization, tests, and other potential countercontrols;
- recorded hypotheses, source evidence, counterevidence, findings, dismissals, coverage, and limitations in the scan ledger;
- performed no file modifications, external access, or code execution.

### Provenance and repository state

- Research model: `openai:gpt-5.6-sol`
- Scan mode: `deep_research`
- Checked-out branch: `master`
- Branch ref: `2931d290d2a85b4d07ebd4380ec57280cfa011f1`
- Git dirty/tracked status: unknown; authorized tools did not provide repository status/history operations.
- README describes the repository as synthetic, local-only, and not deployed.
- Ledger: finalized and completely paginated.
- Scan terminal state: `partial`, for the documented limitations below.

---

## 3. Immediate actions

| Priority | Action | Addresses |
|---|---|---|
| 1 | Disable or fix `readDecisions` before exposing direct reads. Key any cache by both immutable user identity and project, and define invalidation behavior. Prefer a fresh check until that is correct. | DOC-001 |
| 2 | Resolve `documentId` during export creation, derive the project from the document, authorize that actual project, and reject any supplied project mismatch. | DOC-002 |
| 3 | Revalidate the document/project relationship in the worker as defense in depth. Never let separate untrusted identifiers select authorization scope and protected object independently. | DOC-002 |
| 4 | Add negative regression tests for sequential cross-user reads and mismatched export identifiers. | Both |
| 5 | Define membership-revocation semantics for queued and completed exports, then implement cancellation, reauthorization, or explicit snapshot retention accordingly. | Open question |

---

## 4. Findings

## DOC-001 — Project-only authorization cache leaks documents across users

- **Severity:** High
- **Confidence:** High
- **Status:** Confirmed
- **CWE:** CWE-863, Incorrect Authorization
- **Primary locations:** `api.mjs:5-10`, `policy.mjs:6-11`, `store.mjs:11-13`

### Evidence and authority trace

1. `readDocument` obtains the current `userId`, resolves the requested document, and passes `userId` plus the document’s project to `canRead` (`api.mjs:5-10`).
2. `canRead` queries `store.readDecisions` using only `projectId` (`policy.mjs:6-8`).
3. If any cached result exists, it is returned without consulting the current user’s membership (`policy.mjs:7-8`).
4. New decisions are also stored using only `projectId` (`policy.mjs:9-11`).
5. `readDecisions` is shared service state (`store.mjs:11-13`).

The cache therefore represents “some prior user’s decision for this project,” not “this user’s decision for this project.”

### Attack path

Using the fixture identities:

1. Alice, a member of `orchard`, requests `doc-orchard`.
2. `canRead` evaluates Alice’s membership and stores `readDecisions['orchard'] = true`.
3. Bob, who is not an `orchard` member, requests `doc-orchard`.
4. `canRead` finds the cached `true` and skips Bob’s membership lookup.
5. `readDocument` returns the Orchard document body to Bob.

The reverse ordering is also harmful: a nonmember can cache `false`, causing a legitimate member’s subsequent request to fail.

### Exploit preconditions

- The attacker has any gateway-authenticated session.
- The attacker knows or can guess a target document ID.
- A legitimate member previously triggered a successful direct read for that project in the same store lifetime.
- The service instance shares `readDecisions` across users, as implemented.

### Impact

- Cross-project disclosure of document contents.
- Request-order-dependent authorization results.
- Potential denial of access to legitimate project members when a prior nonmember caches `false`.
- Indefinitely stale authorization because no expiry or invalidation path exists.

### Counterevidence checked

`previewDocument` and `createExport` call `requireFreshMembership`, which checks the current user directly (`api.mjs:14-18`, `api.mjs:33-38`, `policy.mjs:13-16`). This limits this specific cache collision to `readDocument`; it does not protect that route.

No other cache key construction, per-user namespace, expiry, invalidation, or clearing logic exists in the repository.

### Remediation

Preferred immediate fix:

- Remove this authorization cache and call `requireFreshMembership` for direct reads.

If caching is genuinely necessary:

- key entries by an unambiguous compound key such as `(userId, projectId)`;
- include tenant/environment identity if project IDs are not globally unique;
- invalidate entries on membership changes;
- apply a short, explicit TTL;
- avoid caching denials unless operationally necessary;
- ensure all service instances receive invalidation events.

Do not construct compound keys with ambiguous string concatenation. Use nested maps or a structured canonical key.

### Verification test

Add a test using one shared store:

1. Alice successfully reads `doc-orchard`.
2. Bob then attempts to read `doc-orchard`.
3. Assert that Bob receives a forbidden/not-found response.
4. Repeat in reverse order:
   - Bob is rejected first.
   - Alice must still succeed afterward.
5. Remove Alice’s membership after a successful read and verify the documented revocation behavior.

---

## DOC-002 — Export authorization is bound to one project while the worker reads a document from another

- **Severity:** High
- **Confidence:** High
- **Status:** Confirmed
- **CWE:** CWE-639, Authorization Bypass Through User-Controlled Key
- **Primary locations:** `api.mjs:13-20`, `api.mjs:24-29`, `worker.mjs:1-8`, `store.mjs:3-10`

### Evidence and data-flow trace

1. Export creation receives separate caller-controlled `projectId` and `documentId` values (`api.mjs:13-17`).
2. Membership is checked only against `body.projectId` (`api.mjs:15-16`).
3. `documentId` is validated only as a string; the document is not resolved and its actual project is not compared with `body.projectId` (`api.mjs:17-19`).
4. Both unbound identifiers are stored in the job (`api.mjs:19`).
5. The worker later loads the document solely by `job.documentId` (`worker.mjs:4`).
6. It serializes that document’s ID and body without checking `doc.projectId`, `job.projectId`, or current membership (`worker.mjs:4-7`).
7. `downloadExport` permits the job owner to retrieve the result (`api.mjs:24-29`).

Authorization scope and protected-object selection are therefore independently controlled.

### Attack path

Using the synthetic data:

1. Alice is a member of `orchard`, not `harbor` (`store.mjs:3-6`).
2. Alice submits an export request containing:
   - `projectId: "orchard"`
   - `documentId: "doc-harbor"`
3. Export creation approves Alice based on Orchard membership and queues `doc-harbor`.
4. The worker resolves `doc-harbor` and serializes the Harbor document body.
5. Alice owns the export job and can download the completed result.

This bypasses the fresh membership logic used by both export creation and preview because the check is applied to the wrong object.

### Exploit preconditions

- The attacker has a valid session.
- The attacker belongs to at least one project.
- The attacker knows or guesses another project’s document ID.
- The worker processes the queued job.
- The attacker downloads their own completed job.

### Impact

An authenticated user can exfiltrate documents from projects or tenants they do not belong to through the asynchronous export path.

### Counterevidence checked

`downloadExport` correctly:

- hides missing or foreign jobs;
- requires `job.userId === userId`;
- requires the job to be ready (`api.mjs:24-29`).

These controls prevent one user from downloading another user’s job. They do not prevent this attack because the attacker legitimately owns the malicious job.

The existing export test uses matching Orchard project and document IDs (`behavior.test.mjs:10-16`), so it does not exercise the mismatch.

### Remediation

At export creation:

1. Resolve `documentId` immediately.
2. Return not found if the document does not exist.
3. Derive authorization scope from `doc.projectId`.
4. Check the requester’s membership in that actual project.
5. Prefer removing caller-supplied `projectId`. If it must remain, require exact equality with `doc.projectId` and reject mismatches.
6. Store the resolved project identity with the job.

At worker execution, apply defense in depth:

- resolve the document;
- verify `doc.projectId === job.projectId`;
- fail closed on mismatch;
- if revocation must take immediate effect, recheck the requesting user’s current membership before serializing data.

Where supported by the storage layer, fetch the document with both keys in one constrained lookup, such as `(authorizedProjectId, documentId)`, rather than loading globally by document ID.

### Verification test

Add a test that:

1. Creates an export as Alice with `projectId: "orchard"` and `documentId: "doc-harbor"`.
2. Asserts that creation is rejected, or that the job fails without containing Harbor data.
3. Confirms a matching Orchard export still succeeds.
4. Confirms Bob cannot download Alice’s legitimate job.
5. Inserts or mutates a queued job with inconsistent project/document values and confirms the worker fails closed.

---

## 5. Scanner observations

| Probe | Result | Triage |
|---|---|---|
| Semgrep | Completed, 0 observations | No scanner findings. Limited coverage; it did not identify the two confirmed business-logic vulnerabilities. |
| Gitleaks | Completed, 0 observations | No detected secrets. This is not proof that history or external deployment secrets are absent. |
| Trivy | Completed, 0 observations | No observations; coverage marked limited. |
| OSV Scanner | Unavailable | No supported package source was found, so no dependency vulnerabilities were verified. |

No scanner observations required confirmation or dismissal. Both confirmed findings originated from architecture and end-to-end authority tracing.

---

## 6. Dismissed and unresolved hypotheses

### Dismissed — Local session forgery as a demonstrated repository vulnerability

`requireSession` accepts any truthy `session.userId` (`policy.mjs:1-4`), which is weak defense in depth. However:

- the documented architecture explicitly delegates cookie validation to a trusted gateway (`README.md:3`);
- API functions receive an already-derived session object;
- no HTTP adapter or gateway implementation is present.

Consequently, a session-forgery vulnerability cannot be established without assuming an undocumented direct invocation path. Gateway authentication strength remains unreviewed rather than safe.

### Unresolved — Membership revocation and export retention

Authorization freshness differs by path:

- previews always check current membership;
- direct reads use an indefinitely cached result;
- exports check membership at creation;
- worker execution and download do not recheck membership.

Direct-read staleness is part of DOC-001. For exports, the repository does not specify whether a completed export is an authorized snapshot that remains available after revocation or must be invalidated immediately.

Required product/security decision:

> Should project-member removal cancel queued exports and prevent later downloads of completed results?

If yes, add fresh worker/download authorization, cancellation, result deletion, and expiry. If no, explicitly document snapshot retention and define a bounded retention period.

---

## 7. Coverage matrix

| Surface | State | Work completed | Remaining gap |
|---|---|---|---|
| Direct document reads | Reviewed | Traced session identity, document lookup, cache behavior, membership source, response body, preview counterpath, callers, and tests. | Runtime regression tests were not executed. |
| Export create → worker → download | Reviewed | Traced both identifiers, membership check, queue state, worker lookup, serialization, ownership, and output. | Runtime tests were not executed; revocation behavior is unspecified. |
| Project/tenant isolation | Reviewed | Reviewed memberships, document project association, shared cache, shared jobs/results, owner checks, and authorization freshness. | External persistence/tenant schema does not exist in scope. |
| Local session enforcement | Reviewed | Confirmed every API function calls `requireSession`. | Gateway authenticity, cookie controls, CSRF, expiry, logout, and service-to-service integrity unavailable. |
| Tests | Limited | Read every test and identified missing negative cases. | No code-execution tool was authorized, so tests were not run. |
| Dependencies/configuration | Limited | Read package metadata and available configuration; no declared runtime dependencies were present. | OSV verification unavailable; deployment/runtime configuration absent. |
| Generated/ignored output | Reviewed | Read the only ignored generated artifact; it contains only a local-generation comment. | Tracked/untracked status could not be independently established. |
| Git provenance | Limited | Established `master` and its ref value from `.git`. | Dirty state and broader history unavailable. |

---

## 8. Probe failures, limitations, and unresolved questions

- The finalized scan is marked `terminalState: partial`.
- The external trusted gateway is absent. Authentication, session integrity, cookie flags, CSRF, gateway routing, and header trust were not assessed.
- Tests were not executed because only read-only `file` and `security_scan` tools were authorized.
- OSV dependency verification was unavailable because no supported dependency source was found.
- Semgrep, Gitleaks, and Trivy completed with limited coverage and zero observations; scanner silence is not treated as a clean bill of health.
- Git dirty state and tracked status are unknown.
- No deployment files, network listener, persistent datastore, authorization-service integration, or production configuration exist in scope.
- Membership mutation and export-retention semantics are unspecified.
- Existing tests do not cover:
  - shared-store cross-user read ordering;
  - mismatched export project/document IDs;
  - membership revocation;
  - missing sessions;
  - malformed identifiers or bodies.
- No files were edited and no external accounts or systems were accessed.

---

## 9. Prioritized action plan

### Now

1. Remove or correct the project-only authorization cache.
2. Resolve and authorize the actual document during export creation.
3. Add a worker-side document/project consistency check.
4. Add regression tests for both confirmed attack paths.
5. Do not expose the affected paths until those tests pass.

### Next

1. Define membership-revocation behavior for direct reads, queued jobs, and completed exports.
2. Add cache invalidation or use fresh authorization consistently.
3. Add export cancellation, expiry, and result-retention controls.
4. Validate session identity type and format locally as defense in depth.
5. Review the real gateway and transport configuration when available.

### Later

1. Add integration tests spanning gateway identity, service authorization, worker processing, and download.
2. Add tenant-isolation invariants at the storage-query level.
3. Run the test suite and negative security tests in an execution-enabled environment.
4. Add a supported dependency manifest/lockfile if dependencies are introduced, then rerun OSV and container/configuration analysis.
