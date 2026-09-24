ALTER TABLE "message_deletion_receipts" DROP CONSTRAINT "message_deletion_receipts_source_valid";--> statement-breakpoint
ALTER TABLE "message_deletion_receipts" DROP CONSTRAINT "message_deletion_receipts_authority_valid";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "delete_community_messages" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "community_messages_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_deletion_receipts" ADD COLUMN "moderation_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_message_cleanup_scope" CHECK (NOT "moderation_actions"."delete_community_messages" OR ("moderation_actions"."action" = 'ban' AND "moderation_actions"."room_id" IS NULL));--> statement-breakpoint
ALTER TABLE "message_deletion_receipts" ADD CONSTRAINT "message_deletion_receipts_moderation_source" CHECK (("message_deletion_receipts"."source" = 'moderation_ban') = ("message_deletion_receipts"."moderation_operation_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "message_deletion_receipts" ADD CONSTRAINT "message_deletion_receipts_moderation_authority" CHECK (("message_deletion_receipts"."source" = 'moderation_ban') = ("message_deletion_receipts"."authority" = 'server_ban'));--> statement-breakpoint
ALTER TABLE "message_deletion_receipts" ADD CONSTRAINT "message_deletion_receipts_source_valid" CHECK ("message_deletion_receipts"."source" in ('room_message', 'content_report', 'moderation_ban'));--> statement-breakpoint
ALTER TABLE "message_deletion_receipts" ADD CONSTRAINT "message_deletion_receipts_authority_valid" CHECK ("message_deletion_receipts"."authority" in ('author', 'room_owner', 'room_steward', 'manage_rooms', 'report_action', 'server_ban'));
--> statement-breakpoint
-- MODERATION_MESSAGE_CLEANUP_GUARD
CREATE OR REPLACE FUNCTION public.guard_moderation_action()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND (to_jsonb(NEW) - 'reason' - 'private_note' - 'audit_recorded_at' - 'converged_at' - 'community_messages_deleted_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'reason' - 'private_note' - 'audit_recorded_at' - 'converged_at' - 'community_messages_deleted_at')
    AND (NEW.reason IS NOT DISTINCT FROM OLD.reason OR NEW.reason IS NULL)
    AND (NEW.private_note IS NOT DISTINCT FROM OLD.private_note OR NEW.private_note IS NULL)
    AND (OLD.audit_recorded_at IS NULL OR NEW.audit_recorded_at IS NOT DISTINCT FROM OLD.audit_recorded_at)
    AND (OLD.community_messages_deleted_at IS NULL OR NEW.community_messages_deleted_at IS NOT DISTINCT FROM OLD.community_messages_deleted_at)
    AND (OLD.converged_at IS NULL OR NEW.converged_at IS NOT DISTINCT FROM OLD.converged_at)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Moderation action identity and outcome are immutable' USING ERRCODE = '23514';
END;
$$;
