ALTER TABLE "photo_library_operations"
  ADD COLUMN "reserved_slots" smallint NOT NULL DEFAULT 0,
  ADD COLUMN "reservation_expires_at" timestamp with time zone,
  ADD COLUMN "reservation_lease_token" uuid;
--> statement-breakpoint
ALTER TABLE "photo_library_operations"
  ADD CONSTRAINT "photo_library_operations_reservation_check"
  CHECK (
    ("operation_kind" = 'create' AND "reserved_slots" BETWEEN 1 AND 4 AND "reservation_expires_at" IS NOT NULL AND "reservation_lease_token" IS NOT NULL)
    OR ("operation_kind" <> 'create' AND "reserved_slots" = 0 AND "reservation_expires_at" IS NULL AND "reservation_lease_token" IS NULL)
  );
--> statement-breakpoint
CREATE INDEX "idx_photo_library_operations_live_create_reservations"
  ON "photo_library_operations" USING btree ("server_instance_id", "owner_user_id", "agent_id", "reservation_expires_at")
  WHERE "operation_kind" = 'create' AND "state" = 'pending';
