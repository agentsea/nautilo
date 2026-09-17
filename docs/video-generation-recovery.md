# Video reference compatibility and recovery

The shared Workspace logical-path validator is used by uploads/renames and
generation reference intent/binding. Generation previously imposed a smaller
512-character envelope. It now preserves the existing Workspace domain
(including exact whitespace identity) through Human and Genie approvals.
Namespace-scoped resolution, artifact revision/hash verification and reference
order are unchanged. Display labels may be abbreviated; the bound path is not.

After observation retries are exhausted, the editor says updates are paused.
Reconnect, focus or an online event checks existing takes; none submits a new
generation. Admission uses the existing idempotent Media Bin reconciliation.

Host-token expiry invalidates an open review and renews through the existing
host lifecycle. The saved direction can be reviewed again, without typing it
again. An expired price or revoked permission never triggers automatic paid
retry. Late list/status/quote/submit responses are fenced to the session that
started them and cannot invalidate or overwrite a newer session.

## Executable evidence

- Agent media-generation contract and approval tests: 512/513/4096
  character paths, invalid paths, Human/Genie projection and checkpoint replay.
- Server media-generation-reference-request tests: namespace-scoped exact
  lookup, persisted bindings, ordered byte delivery and substitution rejection.
- Video editor-interaction tests: prolonged read outage, explicit reconnect,
  one bin entry, preserved timeline edits, no submit and teardown.
- Workbench mini-app-surface tests: real host lease expiry, renewed review,
  permission/quote rejection, stale observations and late review/submission.

These use synthetic data and mocked provider operations. They are not live
provider, packaged Desktop or deployment acceptance.

## Known prompt and path limits

The shared Workspace path envelope remains 4096 characters for compatibility;
it is not a universal filesystem or platform maximum. Generation references
use that same envelope rather than a separate smaller path limit.

Some generation fields retain limits that need provider-specific review:
artifact IDs (256 characters), Seedance prompts (15000), MiniMax H3 prompts
(7000), Sonilo prompts (4096), and MiniMax Music prompts (300) and lyrics
(1000). These are implementation limits, not verified provider maxima. A
model-catalog seed repeating the same number is not independent evidence.
Before changing them, check the exact model contract and provider validation.
Do not silently truncate or split a user's prompt to fit.
