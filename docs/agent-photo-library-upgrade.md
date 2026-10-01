# Agent photo library upgrade

The current media contract accepts imported uploaded PNG originals at either
256 or 1024 pixels square. Generated originals remain 1024 pixels square.
Hashes, byte limits, image format, ownership, and filesystem checks still apply.
Existing owned photo rows and media paths remain unchanged. Backfill recognizes
already adopted rows by their exact owner, subject, reference, and media facts;
new backfill receipts use the current fingerprint domain.

New creation candidates use the version 2 blob hash domain. Their reservation
lease is an application-defined UUID version 8. This lets the server distinguish
new staging artifacts from unfinished work produced by the previous version.
Completed creation receipts still replay unchanged. The new server refuses to
adopt untagged legacy staging, finalize old reservations, or clean up legacy artifacts using the new hash
domain; it never renames existing media or marks unknown old artifacts cleaned.
Current-version direct staging callers that use an older UUID format receive
an exact protocol marker in a new staging directory. Cleanup retains that marker
so a retry after file removal can still prove which hash contract produced it.

Before upgrading an existing server:

1. Enter exclusive maintenance admission and prevent new photo creation.
2. Keep the previous server running until its outstanding creation workers
   finish or expire and its reservation recovery completes artifact cleanup.
3. Run the read-only check from the candidate source against that same database:
   `bun run --cwd packages/server photo-library:check-upgrade`.
   Use the deployment's normal database environment. A failed check blocks the
   upgrade; reconcile the exact reservations with the previous server first.
4. Replace the server only after the check passes, keeping admission closed
   between the check and replacement. Retain the database and avatar volumes.
5. Run the ordinary current-reference backfill dry-run, then apply under its
   explicit server-identity and exclusive-maintenance checks when needed.

The picker can also replace an unindexed current photo. It explicitly requests
missing-current replacement after the authenticated catalogue establishes the
selection revision. The server preserves the previous reference in the selection
record, but does not grant Undo to unowned media. Other selection callers keep
the strict default. Authority failures never trigger picker recovery.
