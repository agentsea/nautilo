ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_repair_source_coherent";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_repair_source_coherent" CHECK (
        ("session_message_crypto_revisions"."repair_source_revision" is null and "session_message_crypto_revisions"."repair_source_digest" is null)
        or ("session_message_crypto_revisions"."repair_source_revision" is not null and "session_message_crypto_revisions"."repair_source_digest" is not null
          and "session_message_crypto_revisions"."repair_source_revision" >= 0 and octet_length("session_message_crypto_revisions"."repair_source_digest") = 32
          and "session_message_crypto_revisions"."author_role" = 'tool' and "session_message_crypto_revisions"."repair_identity_digest" is not null)
      );
--> statement-breakpoint
-- M313_PENDING_TOOL_SOURCE_AUTHORITY
CREATE OR REPLACE FUNCTION public.protect_pending_tool_repair_source()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.repair_source_revision, NEW.repair_source_digest)
    IS DISTINCT FROM ROW(OLD.repair_source_revision, OLD.repair_source_digest)
    AND (current_user <> 'nautilo' OR OLD.completion <> 'pending'
      OR OLD.disposition <> 'active' OR OLD.author_role <> 'tool'
      OR NEW.repair_source_revision IS NULL OR NEW.repair_source_digest IS NULL
      OR (OLD.repair_source_revision IS NOT NULL
        AND NEW.repair_source_revision <= OLD.repair_source_revision)) THEN
    RAISE EXCEPTION 'Only current pending Tool source can change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.protect_pending_tool_repair_source() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.protect_pending_tool_repair_source() TO nautilo;--> statement-breakpoint
CREATE TRIGGER pending_tool_repair_source_protected
BEFORE UPDATE OF repair_source_revision, repair_source_digest ON session_message_crypto_revisions
FOR EACH ROW EXECUTE FUNCTION public.protect_pending_tool_repair_source();
