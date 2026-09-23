# Sensitive tables matrix — new entries

This addendum extends `sensitive-tables-matrix.md` without rewriting its legacy
classifications. The database unit test checks the union of both files against
the exported schema. New entries follow the same classification taxonomy.

| `table_name` | schema | classification | readers | writers | encryption_needed_at_rest | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `message_deletion_receipts` | nautilo | OPERATOR-INTERNAL | Authorized `view_audit_log` lookup in `packages/server/src/lib/message-deletion-receipts.ts`; content-report retry recovery | Canonical hard-delete transaction in `packages/server/src/messaging/message-deletion.ts` | no (content-free metadata only) | Deletion facts with Room/message and actor identifiers, bounded source/authority/outcome codes, optional report ID, and commit time. No message body or preview. Receipts survive the deleted message; the security route restricts non-owner lookups to the caller's actor. |
