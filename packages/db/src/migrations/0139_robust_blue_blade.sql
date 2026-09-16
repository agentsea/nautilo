DROP INDEX "uq_photo_library_operations_scoped_operation";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_photo_library_operations_scoped_operation" ON "photo_library_operations" USING btree ("server_instance_id","viewer_user_id","owner_user_id","agent_id","operation_id");--> statement-breakpoint
-- Reservation slots, expiry, and lease bind the immutable creation request.
-- Terminalization changes only lifecycle fields (`state`, `result`,
-- `completed_at`); a worker may never rewrite the reservation it received.
CREATE OR REPLACE FUNCTION "public"."reject_photo_library_operation_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.state IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'completed photo library operation is immutable' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW.id, NEW.server_instance_id, NEW.viewer_user_id, NEW.owner_user_id, NEW.agent_id, NEW.operation_id, NEW.operation_kind, NEW.request_fingerprint, NEW.created_at, NEW.expires_at, NEW.reserved_slots, NEW.reservation_expires_at, NEW.reservation_lease_token) IS DISTINCT FROM ROW(OLD.id, OLD.server_instance_id, OLD.viewer_user_id, OLD.owner_user_id, OLD.agent_id, OLD.operation_id, OLD.operation_kind, OLD.request_fingerprint, OLD.created_at, OLD.expires_at, OLD.reserved_slots, OLD.reservation_expires_at, OLD.reservation_lease_token) THEN RAISE EXCEPTION 'photo library operation identity is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_photo_library_operation_identity_update"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
