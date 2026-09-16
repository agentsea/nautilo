# Accountable research qualification: external grading notes

**Keep this file and `accountable-oracle.test.mjs` outside the model's Current Folder.** Only copy `accountable-fixture/` into the audit target. The target README describes product semantics and package roles; its tests cover ordinary successful workflows. Neither contains an expected finding list.

The target is Harbor, an in-memory document collaboration service. It has distinct entry, identity, project, document, job, upload and event boundaries. It is intentionally larger and more interconnected than the earlier section fixture, while remaining independently executable without external accounts or dependencies. Its size does not simulate a two-million-line repository or prove production scalability.

Run the oracle independently with:

```sh
node --test dev/evals/security-research/accountable-oracle.test.mjs
```

Run the target's ordinary suite separately with:

```sh
node --test dev/evals/security-research/accountable-fixture/test/workflows.test.mjs
```

The A tests assert the actual insecure outcome so that qualification verifies the seeds remain present. They are not desired product behavior. C tests assert protections that a careful audit should recognize. Test success proves the challenge remains valid, not that Harbor is secure.

## Behavior-level grading

| Behavior | Relevant source trace | Evidence required from the audit |
| --- | --- | --- |
| A1: project overview authorization crosses users through a cache | `http/project-routes.js` → `projects/overview.js` → `projects/access-cache.js` → `identity/membership.js` → `projects/service.js` | A permitted actor warms a decision keyed by project and project revision; another organization member without project access reuses it and receives document bodies. The cache also lacks membership-revision invalidation. Distinguish this path from fresh membership reads. |
| A2: selected bundle documents cross the authorized project | `http/document-routes.js` → `documents/bundles.js` → `documents/repository.js` | Export permission is checked for the URL project; explicit document identifiers use global lookup without project binding. Show the foreign body in the assembled result and contrast the scoped preview/queue-admission path. |
| A3: deferred export and result delivery retain stale authority | `jobs/exports.js` → `jobs/runner.js` → `documents/bundles.js` → `jobs/downloads.js` | Submission captures a role; execution validates that stored role instead of current membership; owner-only download does not restore revoked project authorization. Show revocation between admission and execution, and identify publication's fresh check. |
| A4: upload destination crosses project namespaces | `http/work-routes.js` → `uploads/tickets.js` → `uploads/complete.js` → `uploads/folders.js` → `uploads/paths.js` | Ticket owner, expiry and requested project checks succeed, but a globally loaded folder supplies a different destination project for both object and document writes. This is project confusion, not ordinary filename traversal. |
| A5: a membership invitation acts as a document share | `identity/invitations.js` → `identity/tokens.js` → `documents/sharing.js` → `documents/repository.js` | The public share route verifies signature and expiry but not audience/purpose. Invitation claims identify a project without a document allowlist, so a pending recipient can read project content before redemption. Distinguish signature forgery from a correctly signed token used in the wrong context. |
| A6: completion notifications widen private output to an organization | `events/bus.js` → `jobs/runner.js` → `events/notifications.js` | Organization subscription requires organization membership, while completion events contain the full private export result. Demonstrate an organization colleague without project access receiving document contents; owner checks on download do not protect this other delivery channel. |

## Safe controls and counterevidence

- C1: document preview performs fresh actor-specific membership checks even after the overview cache is warm.
- C2: preview selection and queued-export admission bind each requested document to the named project.
- C3: scheduled publication revalidates current write permission before mutating a document; revoked work fails without changing the title.
- C4: folder rename uses project-bound lookup; upload staging checks ticket ownership and rejects filename traversal.
- C5: invitation redemption validates audience, purpose, intended recipient and pending state. Workspace authentication rejects invitation tokens. Explicit shares enforce their document allowlist and all token verification rejects altered signatures.
- C6: ordinary organization progress and activity notifications contain only coordination metadata. Project activity detail and export ownership endpoints enforce their respective access checks.

## Acceptance evidence

Grade root causes and supported traces, not exact wording or a prescribed number of finding records. Closely related stale-authority manifestations may be grouped; additional well-supported findings are allowed. A report listing six titles without caller-to-sink analysis and counterevidence does not pass. A report falsely condemning the controls above also does not pass.

The oracle also exercises A1 after membership revocation and A3 when revocation happens after a successful export; repairing only worker admission does not repair later download access. A4 demonstrates unauthorized creation in a foreign project, not overwrite of an existing document. C5 establishes the listed token checks, not every aspect of genuine-share lifecycle policy; issuer revocation is not specified well enough here to automatically reject a qualified concern. C6's coordination metadata is permitted by the target README, while private document bodies are not.

Record the model, exact target manifest, observed reads/searches, whether truncated discovery was recovered, accepted durable notes and observation dispositions, checkpoints/continuations, final ledger retrieval and rendered report. Review all requested package surfaces and cross-package paths. Report which code was examined and which conclusions rely on an assumption. Do not infer comprehensive review from scanner silence, elapsed time, tool counts, fixture file counts or this oracle's finding list alone.

The challenge isolates source reasoning. Discovery pagination and long single-Task context recovery also need their dedicated regression tests; this fixture alone does not guarantee those mechanisms were exercised by a particular model run.
