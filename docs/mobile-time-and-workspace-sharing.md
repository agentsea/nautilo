# Mobile message time and workspace sharing

This contract covers Mobile message timestamps and sharing existing Workspace
artifacts. For connecting a phone, see the [Mobile guide](https://nautilo.ai/docs/use/mobile).

## Journey and contract

- Show an unobtrusive local time for messages with authoritative server time.
  Tap for exact date and timezone. Group dated messages by local calendar day;
  never invent a sent time for streaming, optimistic, or undated legacy rows.
- File actions → Add to workspace → select people → Add. Use the existing
  workspace share API and the file's origin Room context. It shares the same
  artifact, sends no DM, and does not transfer ownership.
- Files → Shared with me → open using the returned artifact internal ID and
  authorized Room ID. Preserve the separate Computer files source.
- The server enforces artifact write and recipient access. No client-side
  namespace attachment or new permission tier. Hide sharing for read-only files.

## Recovery and accessibility

Search has explicit loading/error/empty/retry states. Preserve selected people
across searches. Capture the server, user, file and Room scope for each sharing
session; stop queued work after scope change/unmount. Failed deliveries can be
retried individually as a batch without replaying successful deliveries; the
server's idempotency handles response loss. Display partial success truthfully.
Use native accessible controls, keyboard avoidance, safe-area padding, scalable
text and scrollable sheets. No motion is needed to communicate state.

## Verification

Test history/live timestamps, missing dates, optimistic/stream reconciliation,
day boundaries, exact-time disclosure, stale-scope fencing, double-submit,
partial success and retry. Test recipient search/list states and correct
authorized file opening. Run Mobile's isolated unit suite, TypeScript and lint;
separately verify both native clients. Rollback is the client-only UI patch;
existing server shares remain valid and visible on Desktop.

Encryption recovery and Desktop pairing have separate client and server
contracts. Test both native platforms with the software keyboard open on compact
screens: recipient selection, empty search, scrolling, Add, and Cancel must
remain usable. The [empty-search flow](../apps/mobile/.maestro/workspace-share-empty-search.yaml)
provides a repeatable UI check. Run the checks in
[Mobile package scripts](../apps/mobile/package.json) alongside native tests.
