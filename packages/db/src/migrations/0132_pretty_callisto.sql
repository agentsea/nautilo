CREATE TABLE "session_message_crypto_revisions" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" integer NOT NULL,
	"edit_revision" integer NOT NULL,
	"room_id" uuid NOT NULL,
	"namespace_id_at_allocation" uuid NOT NULL,
	"crypto_object_id" text NOT NULL,
	"payload_version" smallint DEFAULT 2 NOT NULL,
	"key_class" text NOT NULL,
	"author_role" text NOT NULL,
	"append_idempotency_key" text,
	"allocation_request_digest" "bytea" NOT NULL,
	"completion" text DEFAULT 'pending' NOT NULL,
	"disposition" text DEFAULT 'active' NOT NULL,
	"parity_status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"terminal_operation_id" text,
	"terminal_operation_type" text,
	"terminal_expected_revision" integer,
	"terminal_request_digest" "bytea",
	"crypto_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_session_message_crypto_revisions_coordinate" UNIQUE("session_id","message_id","edit_revision"),
	CONSTRAINT "uq_session_message_crypto_revisions_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "session_message_crypto_revisions_revision_nonnegative" CHECK ("session_message_crypto_revisions"."edit_revision" >= 0),
	CONSTRAINT "session_message_crypto_revisions_message_id_positive" CHECK ("session_message_crypto_revisions"."message_id" > 0),
	CONSTRAINT "session_message_crypto_revisions_payload_version" CHECK ("session_message_crypto_revisions"."payload_version" = 2),
	CONSTRAINT "session_message_crypto_revisions_key_class" CHECK ("session_message_crypto_revisions"."key_class" in ('ai', 'human')),
	CONSTRAINT "session_message_crypto_revisions_author_role" CHECK ("session_message_crypto_revisions"."author_role" in ('user', 'assistant', 'tool', 'system')),
	CONSTRAINT "session_message_crypto_revisions_append_receipt_coherent" CHECK ((
          "session_message_crypto_revisions"."edit_revision" = 0
          and "session_message_crypto_revisions"."append_idempotency_key" is not null
        ) or (
          "session_message_crypto_revisions"."edit_revision" > 0
          and "session_message_crypto_revisions"."append_idempotency_key" is null
        )),
	CONSTRAINT "session_message_crypto_revisions_allocation_digest_size" CHECK (octet_length("session_message_crypto_revisions"."allocation_request_digest") = 32),
	CONSTRAINT "session_message_crypto_revisions_completion" CHECK ("session_message_crypto_revisions"."completion" in ('pending', 'complete')),
	CONSTRAINT "session_message_crypto_revisions_disposition" CHECK ("session_message_crypto_revisions"."disposition" in (
          'active', 'mapped', 'blocked', 'quarantined',
          'superseded', 'hard_delete', 'stale_mapping'
        )),
	CONSTRAINT "session_message_crypto_revisions_completion_coherent" CHECK ((
          "session_message_crypto_revisions"."completion" = 'pending'
          and "session_message_crypto_revisions"."crypto_completed_at" is null
          and "session_message_crypto_revisions"."disposition" not in ('mapped', 'stale_mapping')
        ) or (
          "session_message_crypto_revisions"."completion" = 'complete'
          and "session_message_crypto_revisions"."crypto_completed_at" is not null
        )),
	CONSTRAINT "session_message_crypto_revisions_parity_status" CHECK ("session_message_crypto_revisions"."parity_status" in (
          'pending', 'server_verified', 'client_verified'
        )),
	CONSTRAINT "session_message_crypto_revisions_parity_author_coherent" CHECK ("session_message_crypto_revisions"."parity_status" = 'pending'
          or (
            "session_message_crypto_revisions"."completion" = 'complete'
            and (
              (
                "session_message_crypto_revisions"."parity_status" = 'client_verified'
                and (
                  "session_message_crypto_revisions"."author_role" = 'user'
                  or "session_message_crypto_revisions"."key_class" = 'human'
                )
              )
              or (
                "session_message_crypto_revisions"."parity_status" = 'server_verified'
                and "session_message_crypto_revisions"."author_role" <> 'user'
                and "session_message_crypto_revisions"."key_class" = 'ai'
              )
            )
          )),
	CONSTRAINT "session_message_crypto_revisions_attempt_bound" CHECK ("session_message_crypto_revisions"."attempt_count" between 0 and 8),
	CONSTRAINT "session_message_crypto_revisions_retry_coherent" CHECK ((
          "session_message_crypto_revisions"."disposition" = 'active'
          and "session_message_crypto_revisions"."next_attempt_at" is not null
          and "session_message_crypto_revisions"."attempt_count" < 8
        ) or (
          "session_message_crypto_revisions"."disposition" <> 'active'
          and "session_message_crypto_revisions"."next_attempt_at" is null
        )),
	CONSTRAINT "session_message_crypto_revisions_lease_coherent" CHECK ((
          "session_message_crypto_revisions"."lease_token" is null
          and "session_message_crypto_revisions"."lease_expires_at" is null
        ) or (
          "session_message_crypto_revisions"."disposition" = 'active'
          and "session_message_crypto_revisions"."lease_token" is not null
          and "session_message_crypto_revisions"."lease_expires_at" is not null
        )),
	CONSTRAINT "session_message_crypto_revisions_terminal_operation_coherent" CHECK ((
          "session_message_crypto_revisions"."disposition" = 'superseded'
          and "session_message_crypto_revisions"."terminal_operation_id" is not null
          and "session_message_crypto_revisions"."terminal_operation_type" = 'edit'
          and "session_message_crypto_revisions"."terminal_expected_revision" = "session_message_crypto_revisions"."edit_revision"
          and "session_message_crypto_revisions"."terminal_request_digest" is not null
        ) or (
          "session_message_crypto_revisions"."disposition" = 'hard_delete'
          and "session_message_crypto_revisions"."terminal_operation_id" is not null
          and "session_message_crypto_revisions"."terminal_operation_type" = 'delete'
          and "session_message_crypto_revisions"."terminal_expected_revision" = "session_message_crypto_revisions"."edit_revision"
          and "session_message_crypto_revisions"."terminal_request_digest" is not null
        ) or (
          "session_message_crypto_revisions"."disposition" not in ('superseded', 'hard_delete')
          and "session_message_crypto_revisions"."terminal_operation_id" is null
          and "session_message_crypto_revisions"."terminal_operation_type" is null
          and "session_message_crypto_revisions"."terminal_expected_revision" is null
          and "session_message_crypto_revisions"."terminal_request_digest" is null
        )),
	CONSTRAINT "session_message_crypto_revisions_terminal_digest_size" CHECK ("session_message_crypto_revisions"."terminal_request_digest" is null
          or octet_length("session_message_crypto_revisions"."terminal_request_digest") = 32),
	CONSTRAINT "session_message_crypto_revisions_object_id_portable" CHECK ("session_message_crypto_revisions"."crypto_object_id" is null or (
      octet_length("session_message_crypto_revisions"."crypto_object_id") between 1 and 128
      and "session_message_crypto_revisions"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    )),
	CONSTRAINT "session_message_crypto_revisions_append_idempotency_portable" CHECK ("session_message_crypto_revisions"."append_idempotency_key" is null or (
      octet_length("session_message_crypto_revisions"."append_idempotency_key") between 1 and 128
      and "session_message_crypto_revisions"."append_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    )),
	CONSTRAINT "session_message_crypto_revisions_operation_id_portable" CHECK ("session_message_crypto_revisions"."terminal_operation_id" is null or (
      octet_length("session_message_crypto_revisions"."terminal_operation_id") between 1 and 128
      and "session_message_crypto_revisions"."terminal_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    )),
	CONSTRAINT "session_message_crypto_revisions_failure_code" CHECK ("session_message_crypto_revisions"."failure_code" is null or "session_message_crypto_revisions"."failure_code" in (
          'namespace_unresolved', 'namespace_mismatch', 'crypto_absent',
          'crypto_incomplete', 'crypto_mismatch',
          'authorization_unavailable', 'recipient_unavailable',
          'storage_transient', 'mapping_conflict', 'retry_exhausted'
        )),
	CONSTRAINT "session_message_crypto_revisions_failure_coherent" CHECK ((
          "session_message_crypto_revisions"."disposition" in ('blocked', 'quarantined')
          and "session_message_crypto_revisions"."failure_code" is not null
        ) or (
          "session_message_crypto_revisions"."disposition" in ('mapped', 'superseded', 'hard_delete')
          and "session_message_crypto_revisions"."failure_code" is null
        ) or "session_message_crypto_revisions"."disposition" in ('active', 'stale_mapping')),
	CONSTRAINT "session_message_crypto_revisions_retry_exhausted_coherent" CHECK ("session_message_crypto_revisions"."failure_code" <> 'retry_exhausted'
          or (
            "session_message_crypto_revisions"."disposition" = 'quarantined'
            and "session_message_crypto_revisions"."attempt_count" = 8
          )),
	CONSTRAINT "session_message_crypto_revisions_attempt_exhaustion_terminal" CHECK ("session_message_crypto_revisions"."attempt_count" < 8
          or (
            "session_message_crypto_revisions"."disposition" = 'quarantined'
            and "session_message_crypto_revisions"."failure_code" = 'retry_exhausted'
          )),
	CONSTRAINT "session_message_crypto_revisions_time_order" CHECK ("session_message_crypto_revisions"."updated_at" >= "session_message_crypto_revisions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "uq_rooms_id_namespace_id" UNIQUE("id","namespace_id");--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_room_namespace_fk" FOREIGN KEY ("room_id","namespace_id_at_allocation") REFERENCES "public"."rooms"("id","namespace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_message_crypto_revisions_append_idempotency" ON "session_message_crypto_revisions" USING btree ("session_id","append_idempotency_key") WHERE "session_message_crypto_revisions"."append_idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_message_crypto_revisions_terminal_operation" ON "session_message_crypto_revisions" USING btree ("terminal_operation_id") WHERE "session_message_crypto_revisions"."terminal_operation_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_session_message_crypto_revisions_due" ON "session_message_crypto_revisions" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "session_message_crypto_revisions"."disposition" = 'active';--> statement-breakpoint
CREATE POLICY "session_message_crypto_revisions_product_all" ON "session_message_crypto_revisions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "session_message_crypto_revisions_agent_select" ON "session_message_crypto_revisions" AS PERMISSIVE FOR SELECT TO "nautilo_agent" USING (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and (
      exists (
        select 1
          from "room_members"
          inner join "actors"
            on "actors"."id" = "room_members"."actor_id"
           and "actors"."kind" = 'user'
         where "room_members"."room_id" = "session_message_crypto_revisions"."room_id"
           and "actors"."owner_id" = app_current_user_id()
      )
      or app_agent_in_room("session_message_crypto_revisions"."room_id")
    ));--> statement-breakpoint
CREATE POLICY "session_message_crypto_revisions_agent_insert" ON "session_message_crypto_revisions" AS PERMISSIVE FOR INSERT TO "nautilo_agent" WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and (
      exists (
        select 1
          from "room_members"
          inner join "actors"
            on "actors"."id" = "room_members"."actor_id"
           and "actors"."kind" = 'user'
         where "room_members"."room_id" = "session_message_crypto_revisions"."room_id"
           and "actors"."owner_id" = app_current_user_id()
      )
      or app_agent_in_room("session_message_crypto_revisions"."room_id")
    ));--> statement-breakpoint
CREATE POLICY "session_message_crypto_revisions_agent_update" ON "session_message_crypto_revisions" AS PERMISSIVE FOR UPDATE TO "nautilo_agent" USING (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and (
      exists (
        select 1
          from "room_members"
          inner join "actors"
            on "actors"."id" = "room_members"."actor_id"
           and "actors"."kind" = 'user'
         where "room_members"."room_id" = "session_message_crypto_revisions"."room_id"
           and "actors"."owner_id" = app_current_user_id()
      )
      or app_agent_in_room("session_message_crypto_revisions"."room_id")
    )) WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from "sessions"
       where "sessions"."id" = "session_message_crypto_revisions"."session_id"
         and "sessions"."room_id" = "session_message_crypto_revisions"."room_id"
    )
    and (
      exists (
        select 1
          from "room_members"
          inner join "actors"
            on "actors"."id" = "room_members"."actor_id"
           and "actors"."kind" = 'user'
         where "room_members"."room_id" = "session_message_crypto_revisions"."room_id"
           and "actors"."owner_id" = app_current_user_id()
      )
      or app_agent_in_room("session_message_crypto_revisions"."room_id")
    ));
--> statement-breakpoint
-- M237_MESSAGE_CRYPTO_LIFECYCLE_AUTHORITY
CREATE FUNCTION "public"."reject_room_namespace_id_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id THEN
    RAISE EXCEPTION 'rooms.namespace_id is immutable after Room creation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_room_namespace_id_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "rooms_namespace_id_immutable"
BEFORE UPDATE OF "namespace_id" ON "rooms"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_room_namespace_id_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition IN ('superseded', 'hard_delete')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal session message crypto revision is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence,
    NEW.session_id,
    NEW.message_id,
    NEW.edit_revision,
    NEW.room_id,
    NEW.namespace_id_at_allocation,
    NEW.crypto_object_id,
    NEW.payload_version,
    NEW.key_class,
    NEW.author_role,
    NEW.append_idempotency_key,
    NEW.allocation_request_digest,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.session_id,
    OLD.message_id,
    OLD.edit_revision,
    OLD.room_id,
    OLD.namespace_id_at_allocation,
    OLD.crypto_object_id,
    OLD.payload_version,
    OLD.key_class,
    OLD.author_role,
    OLD.append_idempotency_key,
    OLD.allocation_request_digest,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'session message crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "session_message_crypto_revisions_identity_immutable"
BEFORE UPDATE ON "session_message_crypto_revisions"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_session_message_crypto_revision_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."validate_session_message_crypto_revision_session_room"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session message crypto revision Session/Room mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_session_message_crypto_revision_session_room"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "session_message_crypto_revisions_session_room_valid"
BEFORE INSERT ON "session_message_crypto_revisions"
FOR EACH ROW
EXECUTE FUNCTION "public"."validate_session_message_crypto_revision_session_room"();--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "session_message_crypto_revisions"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "session_message_crypto_revisions"
  TO "nautilo_agent";--> statement-breakpoint
GRANT UPDATE (
  "completion",
  "disposition",
  "parity_status",
  "attempt_count",
  "next_attempt_at",
  "lease_token",
  "lease_expires_at",
  "failure_code",
  "terminal_operation_id",
  "terminal_operation_type",
  "terminal_expected_revision",
  "terminal_request_digest",
  "crypto_completed_at",
  "updated_at"
) ON TABLE "session_message_crypto_revisions"
  TO "nautilo_agent";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "session_message_crypto_revisions_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "session_message_crypto_revisions_sequence_seq"
  TO "nautilo_agent";
