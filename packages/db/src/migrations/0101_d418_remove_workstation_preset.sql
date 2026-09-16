-- 0101_d418_remove_workstation_preset.sql
-- D418 Wave 2 / Stack 193 — compatibility cleanup after immutable
-- migration 0100.
--
-- Immutable 0100 marks a pre-existing retired `workstation_users` Group and
-- `workstation-user` Role system-managed. Existing local databases can
-- therefore retain those rows. On a fresh migration sequence with no legacy
-- rows, both DELETEs are no-ops; when legacy rows do exist, 0100 may
-- transiently backfill them and this migration removes them before startup.
--
-- `approval_challenges.group_id` is the sole Group FK with ON DELETE NO
-- ACTION, so remove challenges scoped to the retired Group before deleting
-- it. The other Group FKs are verified ON DELETE CASCADE: group_roles,
-- group_members, standing_approvals, and invites. Deleting the Role last
-- cascades any remaining role_capabilities and group_roles. Exact predicates
-- make the cleanup idempotent and preserve all canonical and user-managed
-- authorization objects.

DELETE FROM "approval_challenges"
WHERE "group_id" IN (
  SELECT "id" FROM "groups" WHERE "type" = 'workstation_users'
);--> statement-breakpoint
DELETE FROM "groups"
WHERE "type" = 'workstation_users';--> statement-breakpoint
DELETE FROM "roles"
WHERE "slug" = 'workstation-user';
