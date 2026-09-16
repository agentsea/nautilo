# D501 Task 4.4 Desktop/mobile round-trip evidence

Use a populated, isolated Stack 302 clone with distinct Desktop Electron
profile/debug port, iOS simulator/runtime, and Android AVD/runtime. Do not stop,
restart, rebuild, or repoint any D468 notification runtime. The same disposable
fixtures may be used only when their identity is supplied outside this checked-in
directory; remove or restore them after the evidence run.

Task 4.4 is a live multi-client proof. Static adapter tests and screenshots do
not establish the required convergence. Record redacted measurements and an
approved secure comparison record in `manifest.json`, created from the template.
Never commit credentials, tokens, fixture IDs, private clone paths, document
content, or unredacted screenshots.

Use synthetic fixture aliases in the checked-in manifest. Record the exact
comparison method/version, revision and byte-count metadata, redacted result
reference, and `secureComparisonRecordRef` for each equality observation. The
secure record is the authority for exact values and must not be copied here.
Maestro failure recordings and raw reports remain outside this directory and are
purged after approved redacted retention; they do not establish a successful row.

Required direct observations:

- Android and iOS Markdown and plain-text intentional deltas each reopen
  byte-identical on Desktop and the originating client.
- Desktop Writer changes refresh as readable canonical Writer content on both
  mobile viewers without exposing an edit affordance.
- Both directions of live refresh while another client has the Files/viewer
  route open; include rename, delete, and Discuss continuity.
- A concurrent save race does not overwrite either revision silently; capture
  the stale recovery result and intentional final canonical value.

This template remains a non-claim until every row is actually observed and all
disposable fixtures are reconciled.
