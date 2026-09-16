CREATE TABLE "push_notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"token_generation" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"room_id" uuid,
	"top_level_room_id" uuid,
	"message_id" integer,
	"attention_request_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"state" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"receipt_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" varchar(256),
	"ticket_accepted_at" timestamp with time zone,
	"claim_owner" varchar(128),
	"claim_purpose" varchar(16),
	"claim_expires_at" timestamp with time zone,
	"last_failure_code" varchar(64),
	"terminal_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_notification_deliveries_generation_check" CHECK ("push_notification_deliveries"."token_generation" > 0),
	CONSTRAINT "push_notification_deliveries_kind_check" CHECK ("push_notification_deliveries"."kind" IN ('important_message', 'needs_you', 'test')),
	CONSTRAINT "push_notification_deliveries_state_check" CHECK ("push_notification_deliveries"."state" IN ('pending', 'claimed', 'receipt_pending', 'retry', 'delivered', 'terminal')),
	CONSTRAINT "push_notification_deliveries_attempt_bounds_check" CHECK ("push_notification_deliveries"."attempt_count" >= 0 AND "push_notification_deliveries"."attempt_count" <= 8
        AND "push_notification_deliveries"."receipt_attempt_count" >= 0 AND "push_notification_deliveries"."receipt_attempt_count" <= 24),
	CONSTRAINT "push_notification_deliveries_target_shape_check" CHECK ((
        "push_notification_deliveries"."kind" = 'important_message'
        AND "push_notification_deliveries"."room_id" IS NOT NULL
        AND "push_notification_deliveries"."top_level_room_id" IS NOT NULL
        AND "push_notification_deliveries"."message_id" IS NOT NULL
        AND "push_notification_deliveries"."attention_request_id" IS NULL
      ) OR (
        "push_notification_deliveries"."kind" = 'needs_you'
        AND "push_notification_deliveries"."room_id" IS NOT NULL
        AND "push_notification_deliveries"."top_level_room_id" IS NOT NULL
        AND "push_notification_deliveries"."message_id" IS NULL
        AND "push_notification_deliveries"."attention_request_id" IS NOT NULL
      ) OR (
        "push_notification_deliveries"."kind" = 'test'
        AND "push_notification_deliveries"."room_id" IS NULL
        AND "push_notification_deliveries"."top_level_room_id" IS NULL
        AND "push_notification_deliveries"."message_id" IS NULL
        AND "push_notification_deliveries"."attention_request_id" IS NULL
      )),
	CONSTRAINT "push_notification_deliveries_expiry_bound_check" CHECK ("push_notification_deliveries"."expires_at" > "push_notification_deliveries"."created_at"
        AND "push_notification_deliveries"."expires_at" <= "push_notification_deliveries"."created_at" + interval '2 days'),
	CONSTRAINT "push_notification_deliveries_lease_shape_check" CHECK ((
        "push_notification_deliveries"."state" = 'claimed'
        AND "push_notification_deliveries"."claim_owner" IS NOT NULL
        AND "push_notification_deliveries"."claim_purpose" IN ('send', 'receipt')
        AND "push_notification_deliveries"."claim_expires_at" IS NOT NULL
        AND "push_notification_deliveries"."terminal_at" IS NULL
      ) OR (
        "push_notification_deliveries"."state" IN ('pending', 'retry', 'receipt_pending')
        AND "push_notification_deliveries"."claim_owner" IS NULL
        AND "push_notification_deliveries"."claim_purpose" IS NULL
        AND "push_notification_deliveries"."claim_expires_at" IS NULL
        AND "push_notification_deliveries"."terminal_at" IS NULL
      ) OR (
        "push_notification_deliveries"."state" IN ('delivered', 'terminal')
        AND "push_notification_deliveries"."claim_owner" IS NULL
        AND "push_notification_deliveries"."claim_purpose" IS NULL
        AND "push_notification_deliveries"."claim_expires_at" IS NULL
        AND "push_notification_deliveries"."terminal_at" IS NOT NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "push_message_candidates" DROP CONSTRAINT "push_message_candidates_state_check";--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" DROP CONSTRAINT "push_notification_test_intents_state_check";--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" DROP CONSTRAINT "push_notification_test_intents_terminal_shape_check";--> statement-breakpoint
DROP INDEX "idx_push_message_candidates_pending";--> statement-breakpoint
ALTER TABLE "push_message_candidates" ADD COLUMN "claim_owner" varchar(128);--> statement-breakpoint
ALTER TABLE "push_message_candidates" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_message_candidates" ADD COLUMN "terminal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" ADD COLUMN "claim_owner" varchar(128);--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_notification_deliveries" ADD CONSTRAINT "push_notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_notification_deliveries" ADD CONSTRAINT "push_notification_deliveries_binding_id_push_installation_bindings_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."push_installation_bindings"("binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_notification_deliveries_logical_generation" ON "push_notification_deliveries" USING btree ("kind","event_id","binding_id","token_generation");--> statement-breakpoint
CREATE INDEX "idx_push_notification_deliveries_due" ON "push_notification_deliveries" USING btree ("next_attempt_at","created_at") WHERE "push_notification_deliveries"."state" IN ('pending', 'retry', 'receipt_pending');--> statement-breakpoint
CREATE INDEX "idx_push_notification_deliveries_terminal_retention" ON "push_notification_deliveries" USING btree ("terminal_at") WHERE "push_notification_deliveries"."terminal_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_push_message_candidates_pending" ON "push_message_candidates" USING btree ("created_at","message_id") WHERE "push_message_candidates"."state" IN ('pending', 'claimed');--> statement-breakpoint
ALTER TABLE "push_message_candidates" ADD CONSTRAINT "push_message_candidates_lease_shape_check" CHECK ((
        "push_message_candidates"."state" = 'claimed'
        AND "push_message_candidates"."claim_owner" IS NOT NULL
        AND "push_message_candidates"."claim_expires_at" IS NOT NULL
        AND "push_message_candidates"."terminal_at" IS NULL
      ) OR (
        "push_message_candidates"."state" = 'pending'
        AND "push_message_candidates"."claim_owner" IS NULL
        AND "push_message_candidates"."claim_expires_at" IS NULL
        AND "push_message_candidates"."terminal_at" IS NULL
      ) OR (
        "push_message_candidates"."state" = 'terminal'
        AND "push_message_candidates"."claim_owner" IS NULL
        AND "push_message_candidates"."claim_expires_at" IS NULL
        AND "push_message_candidates"."terminal_at" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "push_message_candidates" ADD CONSTRAINT "push_message_candidates_state_check" CHECK ("push_message_candidates"."state" IN ('pending', 'claimed', 'terminal'));--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" ADD CONSTRAINT "push_notification_test_intents_state_check" CHECK ("push_notification_test_intents"."state" IN ('pending', 'claimed', 'terminal'));--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" ADD CONSTRAINT "push_notification_test_intents_terminal_shape_check" CHECK ((
        "push_notification_test_intents"."state" = 'pending'
        AND "push_notification_test_intents"."claim_owner" IS NULL
        AND "push_notification_test_intents"."claim_expires_at" IS NULL
        AND "push_notification_test_intents"."terminal_at" IS NULL
      ) OR (
        "push_notification_test_intents"."state" = 'claimed'
        AND "push_notification_test_intents"."claim_owner" IS NOT NULL
        AND "push_notification_test_intents"."claim_expires_at" IS NOT NULL
        AND "push_notification_test_intents"."terminal_at" IS NULL
      ) OR (
        "push_notification_test_intents"."state" = 'terminal'
        AND "push_notification_test_intents"."claim_owner" IS NULL
        AND "push_notification_test_intents"."claim_expires_at" IS NULL
        AND "push_notification_test_intents"."terminal_at" IS NOT NULL
      ));
--> statement-breakpoint

-- Delivery records are per-Human operational metadata.  The normal request
-- path is owner-scoped; the small SECURITY DEFINER claim/maintenance
-- functions below are the sole cross-owner worker capability and return no
-- plaintext Expo token, title/body, message content, URL, or arbitrary copy.
ALTER TABLE "push_notification_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_notification_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "push_notification_deliveries_owner" ON "push_notification_deliveries"
  FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    REVOKE ALL ON TABLE "push_notification_deliveries" FROM "nautilo_agent";
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_claim_next_push_notification_test_intent(
  p_claim_owner text,
  p_now timestamptz,
  p_claim_expires_at timestamptz
)
RETURNS TABLE(notification_id uuid, user_id uuid, binding_id uuid, token_generation integer, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF length(trim(p_claim_owner)) = 0 OR length(p_claim_owner) > 128
    OR p_now IS NULL OR p_claim_expires_at IS NULL OR p_claim_expires_at <= p_now THEN
    RAISE EXCEPTION 'invalid push test claim' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH selected AS (
    SELECT pti.notification_id
    FROM push_notification_test_intents pti
    WHERE pti.state = 'pending'
       OR (pti.state = 'claimed' AND pti.claim_expires_at <= p_now)
    ORDER BY pti.created_at, pti.notification_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE push_notification_test_intents pti
    SET state = 'claimed',
        claim_owner = p_claim_owner,
        claim_expires_at = p_claim_expires_at
    FROM selected
    WHERE pti.notification_id = selected.notification_id
    RETURNING pti.notification_id, pti.user_id, pti.binding_id, pti.token_generation, pti.created_at
  )
  SELECT claimed.notification_id, claimed.user_id, claimed.binding_id, claimed.token_generation, claimed.created_at
  FROM claimed;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_claim_next_push_notification_delivery(
  p_claim_purpose text,
  p_claim_owner text,
  p_now timestamptz,
  p_claim_expires_at timestamptz
)
RETURNS TABLE(delivery_id uuid, user_id uuid, claim_purpose text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_claim_purpose NOT IN ('send', 'receipt')
    OR length(trim(p_claim_owner)) = 0 OR length(p_claim_owner) > 128
    OR p_now IS NULL OR p_claim_expires_at IS NULL OR p_claim_expires_at <= p_now THEN
    RAISE EXCEPTION 'invalid push delivery claim' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH selected AS (
    SELECT d.id
    FROM push_notification_deliveries d
    WHERE d.expires_at > p_now
      AND (
        (p_claim_purpose = 'send' AND d.state IN ('pending', 'retry'))
        OR (p_claim_purpose = 'receipt' AND d.state = 'receipt_pending')
        OR (
          d.state = 'claimed'
          AND d.claim_purpose = p_claim_purpose
          AND d.claim_expires_at <= p_now
        )
      )
      AND d.next_attempt_at <= p_now
      AND (
        (p_claim_purpose = 'send' AND d.attempt_count < 8)
        OR (p_claim_purpose = 'receipt' AND d.receipt_attempt_count < 24)
      )
    ORDER BY d.next_attempt_at, d.created_at, d.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE push_notification_deliveries d
    SET state = 'claimed',
        claim_owner = p_claim_owner,
        claim_purpose = p_claim_purpose,
        claim_expires_at = p_claim_expires_at,
        attempt_count = CASE
          WHEN p_claim_purpose = 'send' THEN d.attempt_count + 1
          ELSE d.attempt_count
        END,
        receipt_attempt_count = CASE
          WHEN p_claim_purpose = 'receipt' THEN d.receipt_attempt_count + 1
          ELSE d.receipt_attempt_count
        END,
        updated_at = p_now
    FROM selected
    WHERE d.id = selected.id
    RETURNING d.id, d.user_id, d.claim_purpose
  )
  SELECT claimed.id, claimed.user_id, claimed.claim_purpose::text
  FROM claimed;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_terminalize_expired_push_notification_deliveries(
  p_now timestamptz,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  IF p_now IS NULL OR p_limit < 1 OR p_limit > 256 THEN
    RAISE EXCEPTION 'invalid push delivery cleanup bound' USING ERRCODE = '22023';
  END IF;

  WITH selected AS (
    SELECT d.id
    FROM push_notification_deliveries d
    WHERE d.state NOT IN ('delivered', 'terminal')
      AND (
        d.expires_at <= p_now
        OR (d.state IN ('pending', 'retry') AND d.attempt_count >= 8)
        OR (d.state = 'receipt_pending' AND d.receipt_attempt_count >= 24)
      )
    ORDER BY d.expires_at, d.created_at, d.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), terminalized AS (
    UPDATE push_notification_deliveries d
    SET state = 'terminal',
        claim_owner = NULL,
        claim_purpose = NULL,
        claim_expires_at = NULL,
        last_failure_code = CASE
          WHEN d.expires_at <= p_now THEN 'expired'
          ELSE 'attempts_exhausted'
        END,
        terminal_at = p_now,
        updated_at = p_now
    FROM selected
    WHERE d.id = selected.id
    RETURNING d.id
  )
  SELECT count(*)::integer INTO v_count FROM terminalized;
  RETURN v_count;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_terminalize_stale_push_notification_deliveries(
  p_now timestamptz,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  IF p_now IS NULL OR p_limit < 1 OR p_limit > 256 THEN
    RAISE EXCEPTION 'invalid push delivery cleanup bound' USING ERRCODE = '22023';
  END IF;

  WITH selected AS (
    SELECT d.id
    FROM push_notification_deliveries d
    LEFT JOIN push_installation_bindings b
      ON b.binding_id = d.binding_id
     AND b.user_id = d.user_id
     AND b.token_generation = d.token_generation
     AND b.state = 'active'
     AND b.enabled = true
     AND b.permission = 'granted'
    WHERE d.state NOT IN ('delivered', 'terminal')
      AND b.binding_id IS NULL
    ORDER BY d.created_at, d.id
    FOR UPDATE OF d SKIP LOCKED
    LIMIT p_limit
  ), terminalized AS (
    UPDATE push_notification_deliveries d
    SET state = 'terminal',
        claim_owner = NULL,
        claim_purpose = NULL,
        claim_expires_at = NULL,
        last_failure_code = 'binding_inactive_or_rotated',
        terminal_at = p_now,
        updated_at = p_now
    FROM selected
    WHERE d.id = selected.id
    RETURNING d.id
  )
  SELECT count(*)::integer INTO v_count FROM terminalized;
  RETURN v_count;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_purge_terminal_push_notification_delivery_history(
  p_before timestamptz,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  IF p_before IS NULL OR p_limit < 1 OR p_limit > 256 THEN
    RAISE EXCEPTION 'invalid push delivery retention bound' USING ERRCODE = '22023';
  END IF;

  WITH selected AS (
    SELECT d.id
    FROM push_notification_deliveries d
    WHERE d.terminal_at IS NOT NULL AND d.terminal_at < p_before
    ORDER BY d.terminal_at, d.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM push_notification_deliveries d
    USING selected
    WHERE d.id = selected.id
    RETURNING d.id
  )
  SELECT count(*)::integer INTO v_count FROM deleted;
  RETURN v_count;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_purge_terminal_push_notification_test_intents(
  p_before timestamptz,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  IF p_before IS NULL OR p_limit < 1 OR p_limit > 256 THEN
    RAISE EXCEPTION 'invalid push test retention bound' USING ERRCODE = '22023';
  END IF;

  WITH selected AS (
    SELECT pti.notification_id
    FROM push_notification_test_intents pti
    WHERE pti.terminal_at IS NOT NULL AND pti.terminal_at < p_before
    ORDER BY pti.terminal_at, pti.notification_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM push_notification_test_intents pti
    USING selected
    WHERE pti.notification_id = selected.notification_id
    RETURNING pti.notification_id
  )
  SELECT count(*)::integer INTO v_count FROM deleted;
  RETURN v_count;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_claim_next_push_notification_test_intent(text,timestamptz,timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_claim_next_push_notification_delivery(text,text,timestamptz,timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_terminalize_expired_push_notification_deliveries(timestamptz,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_terminalize_stale_push_notification_deliveries(timestamptz,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_terminal_push_notification_delivery_history(timestamptz,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_terminal_push_notification_test_intents(timestamptz,integer) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo') THEN
    GRANT EXECUTE ON FUNCTION app_claim_next_push_notification_test_intent(text,timestamptz,timestamptz) TO "nautilo";
    GRANT EXECUTE ON FUNCTION app_claim_next_push_notification_delivery(text,text,timestamptz,timestamptz) TO "nautilo";
    GRANT EXECUTE ON FUNCTION app_terminalize_expired_push_notification_deliveries(timestamptz,integer) TO "nautilo";
    GRANT EXECUTE ON FUNCTION app_terminalize_stale_push_notification_deliveries(timestamptz,integer) TO "nautilo";
    GRANT EXECUTE ON FUNCTION app_purge_terminal_push_notification_delivery_history(timestamptz,integer) TO "nautilo";
    GRANT EXECUTE ON FUNCTION app_purge_terminal_push_notification_test_intents(timestamptz,integer) TO "nautilo";
  END IF;
END $$;
