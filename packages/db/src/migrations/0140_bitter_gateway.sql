ALTER TABLE "photo_library_operations" ADD COLUMN "artifact_cleanup_completed_at" timestamp with time zone;--> statement-breakpoint
-- A failed expired create may need a later, idempotent filesystem sweep. The
-- receipt itself stays terminal: the one permitted post-terminal transition is
-- an unset cleanup marker becoming set, with every other column unchanged.
CREATE OR REPLACE FUNCTION "public"."reject_photo_library_operation_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.state IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
    IF OLD.state = 'failed'
      AND OLD.operation_kind = 'create'
      AND OLD.artifact_cleanup_completed_at IS NULL
      AND NEW.artifact_cleanup_completed_at IS NOT NULL
      AND ROW(
        NEW.id, NEW.server_instance_id, NEW.viewer_user_id, NEW.owner_user_id,
        NEW.agent_id, NEW.operation_id, NEW.operation_kind,
        NEW.request_fingerprint, NEW.state, NEW.result, NEW.created_at,
        NEW.completed_at, NEW.expires_at, NEW.reserved_slots,
        NEW.reservation_expires_at, NEW.reservation_lease_token
      ) IS NOT DISTINCT FROM ROW(
        OLD.id, OLD.server_instance_id, OLD.viewer_user_id, OLD.owner_user_id,
        OLD.agent_id, OLD.operation_id, OLD.operation_kind,
        OLD.request_fingerprint, OLD.state, OLD.result, OLD.created_at,
        OLD.completed_at, OLD.expires_at, OLD.reserved_slots,
        OLD.reservation_expires_at, OLD.reservation_lease_token
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'completed photo library operation is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.server_instance_id, NEW.viewer_user_id, NEW.owner_user_id, NEW.agent_id, NEW.operation_id, NEW.operation_kind, NEW.request_fingerprint, NEW.created_at, NEW.expires_at, NEW.reserved_slots, NEW.reservation_expires_at, NEW.reservation_lease_token) IS DISTINCT FROM ROW(OLD.id, OLD.server_instance_id, OLD.viewer_user_id, OLD.owner_user_id, OLD.agent_id, OLD.operation_id, OLD.operation_kind, OLD.request_fingerprint, OLD.created_at, OLD.expires_at, OLD.reserved_slots, OLD.reservation_expires_at, OLD.reservation_lease_token) THEN RAISE EXCEPTION 'photo library operation identity is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_photo_library_operation_identity_update"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
