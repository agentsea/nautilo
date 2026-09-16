# Board live Desktop qualification

2026-09-13. Isolated source Desktop against a populated test environment with
separate application state and test documents. Baseline `d3f3190bb` plus the
fixes recorded below. This is live development acceptance, not a packaged
release or production deployment.

## Passed in the actual application

- Environment admission, migrations, health, runtime identity, SPA and OIDC
  checks passed. Authenticated application state and the configured Genie
  survived clean stop/start and a forced app termination.
- Board appeared enabled under Nautilo Office with a verified manifest.
- Human Workspace create, typing, Save, close and reopen preserved exact
  canonical HTML. Typing observed the same Apps row throughout, with zero row
  removals and zero loading transitions. Font family and size controls were
  visible. Ivory/Tokyo changes preserved authored bytes.
- Human Current Folder creation used the native folder picker and wrote the
  chosen directory. The saved file reopened as a native read-only preview with
  identical bytes. Workspace and local files persisted across app restarts.
- The configured Genie calls discovered Board tools and schema, created a
  Workspace file,
  inserted two labelled notes and an attached connector, inspected the result,
  and returned a working Open in Board action. Open-board editing saved revision
  3; comparison proved only the requested two fills changed.
- The configured Genie Current Folder create/inspect/edit/verify wrote a blue
  “Local ideas”
  note to disk. Open in Board displayed that file in editable mode with the
  expected blue fill and readable text. Each approval was granted once; global
  auto-approval remained off.
- While a Human note was still being edited, an external change to the owned
  local test file triggered a conflict. The external canonical file remained
  unchanged and Save a copy matched the durable Human draft byte-for-byte.
- After forced Electron termination, reopening restored that exact draft in
  conflict. A second copy matched the first. Temporarily moving the original
  file aside and reopening still recovered the draft; a third copy was exact
  and the missing original was not silently recreated. The original was then
  restored and Reload latest returned to the saved canonical board.

Synthetic documents and exact-byte comparisons were retained as acceptance
evidence outside the source tree. No account history, credentials, device
identity or private paths are included in this source evidence document.

## Defects found and fixed

The host injects body padding by default. Board now explicitly resets it; live
computed padding is zero and the unwanted light border is gone.

Native literal colors are CSS strings. Bare OOXML-style hex from an initial
Genie edit rendered black. Source-derived schema guidance now explains the
leading `#`, and tool writes reject newly introduced bare-hex values before any
write. Existing malformed values may remain, move or be repaired incrementally;
there is no creative palette whitelist or silent normalization. CSS names and
functional colors remain available. The corrected live board rendered its
yellow/green notes correctly, and a subsequent natural-language Current Folder
request produced a valid blue note.

A missing-file recovery exposed a shared host session gap: initial issuance
failed while the original was unavailable, and later canonical changes only
refreshed already-existing sessions. The host now retries issuance on those
normal document events, deduplicates requests, and revokes late responses after
unmount or target/iframe changes. Live acceptance restored an exact draft after
a forced termination with the original absent, returned the original without
remounting, and established a new capability. The Genie then inspected, edited and
verified the same local board; only the requested title changed.

The focused Board suite passes 94 tests, including open/closed atomic refusal,
CSS syntax freedom and incremental legacy repair. Board types, lint, schema
consistency and prepared artifacts pass. The 118-test MiniAppSurface suite,
Workbench TypeScript/build and host-source lint pass; its three new tests cover
reissuance, unmount and target-switch races. Limit inventory/check remains 5123
observations, 1256 reviewed and 3867 frozen legacy observations.

## Data-integrity acceptance

The subsequent integrity pass uses baseline `43d2ce210` plus this change. It
passes 98 Board tests, 84 focused server tests and 68 shared app/asset regressions, plus ten prepared-app browser scenarios with zero browser errors.
Board and server types and changed-source lint pass. These are focused checks;
full release CI and packaged acceptance remain separate. Limit check passes
with 5123 observations, 1256 reviewed and 3867 frozen legacy observations.

- Actual Genie edits were refused while a Human image was pending, with no saved
  title, revision or object change. A deliberately stale revision was separately
  refused after the Human image finished saving.
- The Genie inserted an authorized Current Folder PNG into the open Workspace board.
  Independent decoding of the saved data URL matched all 190 source bytes and
  its SHA-256 receipt. The previous two objects and title were unchanged; one
  new image produced one new revision.
- A real Genie batch containing a title edit and an absent image was refused
  at the image operation. Independent rereading confirmed identical saved bytes
  and revision; the earlier title edit was not partially applied.
- Two different simultaneous writes against one Workspace revision, through the
  actual app document bridge, produced exactly one save and one conflict. The
  winner advanced the revision once. The same race through Desktop's authorized
  filesystem bridge produced one local SHA save and one conflict. Both synthetic
  originals were restored byte-for-byte using the winning version as the base.
  These are real storage races, not two simultaneous provider conversations.
- Duplicate delivery and changed-argument replay run through the registered,
  prepared Board handler with a hermetic `writeBound` seam: one concurrent
  invocation proceeds, an exact retry replays its receipt, changed arguments
  conflict, and a later turn can reuse a provider call ID. Definite write errors
  release the claim for retry in both document-version modes. This fixture is
  not a child-process worker or real storage proof; the separate live races
  exercise those canonical storage boundaries.
- A corrupt PNG previously advanced the saved revision despite identical model
  bytes. It now leaves both untouched in the actual Desktop. Pending placement
  still blocks Save/close and keeps an inexact recovery checkpoint. Releasing
  the delayed real file reader inserts the image and saves once.
- Forced termination preserved the inexact checkpoint and unchanged canonical
  board. It reopened in conflict against the newer revision created by the
  preceding race. Explicit Reload latest, including its discard confirmation,
  cleared only the synthetic incomplete operation. The browser fixture also
  proves the same-base unfinished-operation warning, reader abort/error, and
  zero canonical writes during incomplete recovery.

The fixes separate pending view work from real model changes and separate tool
invocation identity from its argument fingerprint. No creative-property or
layout whitelist was added. A transient live image refusal during testing came
from mismatched rebuilt and installed app hashes; reseeding the exact prepared
bundle restored authorized insertion without weakening the authority check.

## Remaining acceptance

Canonical delivery acceptance is complete with the combined live and focused
fixture evidence above. Cold release packaging, enable/disable/upgrade, backup,
restore, rollback and distinct sidebar/expanded-app artwork remained separate at
this point and are covered by the packaged qualification record. Writer, Sheets
and Slides remain outside this implementation scope; Notes remains deferred.
