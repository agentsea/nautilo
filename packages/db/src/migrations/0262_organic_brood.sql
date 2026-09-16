ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_repair_evidence_coherent";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_repair_evidence_coherent" CHECK ((
          "session_message_crypto_revisions"."repair_identity_digest" is null
          and "session_message_crypto_revisions"."repair_publisher_kind" is null
          and "session_message_crypto_revisions"."repair_publisher_id" is null
          and "session_message_crypto_revisions"."repair_attestation_digest" is null
        ) or (
          octet_length("session_message_crypto_revisions"."repair_identity_digest") = 32
          and (
            ("session_message_crypto_revisions"."repair_publisher_kind" is null
              and "session_message_crypto_revisions"."repair_publisher_id" is null
              and "session_message_crypto_revisions"."repair_attestation_digest" is null
              and "session_message_crypto_revisions"."completion" = 'pending')
            or ("session_message_crypto_revisions"."repair_publisher_kind" in ('foreground_runtime', 'human_device')
              and octet_length("session_message_crypto_revisions"."repair_publisher_id") between 1 and 128
              and "session_message_crypto_revisions"."repair_publisher_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
              and octet_length("session_message_crypto_revisions"."repair_attestation_digest") = 32
              and "session_message_crypto_revisions"."completion" in ('pending', 'complete'))
          )
        ));
--> statement-breakpoint
-- M313_PENDING_MESSAGE_RESERVATION_AUTHORITY
CREATE OR REPLACE FUNCTION public.protect_message_repair_publisher_human()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = 'nautilo_agent' AND (
    NEW.repair_publisher_human_id IS NOT NULL
    OR (OLD.repair_publisher_human_id IS NOT NULL AND (
      OLD.completion <> 'pending' OR NEW.repair_publisher_kind IS DISTINCT FROM 'foreground_runtime'
    ))
  ) THEN
    RAISE EXCEPTION 'Agent cannot create or rewrite Human Message publisher evidence' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.protect_message_repair_publisher_human() FROM PUBLIC, nautilo_crypto;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.protect_message_repair_publisher_human() TO nautilo, nautilo_agent;--> statement-breakpoint
CREATE TRIGGER message_repair_publisher_human_protected
BEFORE UPDATE OF repair_publisher_human_id ON session_message_crypto_revisions
FOR EACH ROW EXECUTE FUNCTION public.protect_message_repair_publisher_human();--> statement-breakpoint
GRANT UPDATE (repair_publisher_human_id) ON session_message_crypto_revisions TO nautilo_agent;
