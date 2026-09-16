# D501 Task 4.2 Android source-actions evidence

Run `d501-android-source-actions.yaml` only against the isolated, authenticated
`D501_Wave10` runtime. Supply the disposable Markdown fixture ID at runtime as
`D501_MARKDOWN_ID`; never write it into the checked-in flow. Do not add
credentials, artifact IDs, tokens, or screenshots containing private cloned
content to this directory.

The deterministic flow covers route admission, real source input, Markdown
toolbar actions, Preview/Edit continuity, quiet capability copy, and Save-action
reachability with native-buffer retention.
The final Save tap proves only that the action remains reachable and the native
buffer stays mounted; it does not prove server acceptance or byte fidelity. The
flow does not automate native selection handles, Gboard composition/paste,
plain-text fidelity, long-source keyboard scrolling, Desktop conflict handoff,
Writer-viewer-only inspection, Discuss continuity, rename, delete, or exact
byte comparison. Those remain visible manual rows because hiding them behind
brittle coordinate automation would weaken the evidence.

## Evidence rule

The task/issue narrative and Git history record prior operator reports, but
neither is retained per-row evidence. They must not be used to change a
`not-run` row. At this audit, this directory has no retained Maestro result,
redacted screenshot, fixture receipt, or before/after comparison record;
therefore no live acceptance row is eligible to be marked.

Create `manifest.json` from the template during the next live run. For every
executed row, retain only redacted evidence and record:

- branch HEAD, APK byte count and SHA-256, AVD serial, Metro port, start time,
  exact Maestro command, exit result, and SHA-256 of its redacted output;
- SHA-256s of redacted screenshots (never their private fixture content), with
  a short state label and the matching manifest row;
- for source save/reopen rows, redacted fixture receipt plus exact before/after
  UTF-8 byte counts and SHA-256s; and
- for conflict, Writer viewer, Discuss, rename, delete, and cleanup rows, a
  redacted fixture lifecycle receipt that identifies the observed state without
  disclosing an artifact ID, server URL, token, or content.

The final Save tap proves only that the action remains reachable and the native
buffer stays mounted; it does not prove server acceptance or byte fidelity.
Do not use it as evidence for either save/reopen row.

## Minimal live rerun checklist

1. Install the current branch APK on the isolated authenticated AVD, capture
   the build and runtime provenance, then run the Maestro harness with the
   disposable Markdown ID supplied only in the process environment.
2. Manually record native selection/Gboard composition and paste recovery,
   keyboard-open long-source scroll, Markdown and plain-text save/reopen byte
   comparisons, and stale-conflict choices with preserved local input.
3. Open the canonical Writer fixture and prove readable scrolling, no Writer
   edit admission, and no D501 capability/future copy; then record viewer /
   Discuss continuity, rename, delete, and fixture restoration or removal.
4. Redact the retained receipts and screenshots, hash them, fill every manifest
   row from direct observation, and leave any unexercised row `not-run`.

This scaffold and template are not live acceptance evidence. Replace
`manifest.template.json` with a redacted `manifest.json` only after every row is
actually exercised and the disposable fixtures are restored or removed.
Every automated and manual row in that manifest must pass before Task 4.2 can
be marked complete.
