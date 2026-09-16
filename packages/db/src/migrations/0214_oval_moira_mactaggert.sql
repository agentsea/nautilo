CREATE INDEX "idx_conversation_shared_agent_shadow_invocations_conductor" ON "conversation_shared_agent_shadow_invocations" USING btree ("policy_revision","created_at","state","terminal_reason");
--> statement-breakpoint
-- M299_RUNTIME_CONDUCTOR_LIFECYCLE
CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.sequence, NEW.invocation_id, NEW.policy_revision, NEW.session_id,
    NEW.room_id, NEW.invoking_human_id, NEW.invoking_device_id,
    NEW.authorization_device_id, NEW.client_action_session_id, NEW.input_count,
    NEW.input_set_digest, NEW.deadline_at, NEW.created_at)
  IS DISTINCT FROM
  ROW(OLD.sequence, OLD.invocation_id, OLD.policy_revision, OLD.session_id,
    OLD.room_id, OLD.invoking_human_id, OLD.invoking_device_id,
    OLD.authorization_device_id, OLD.client_action_session_id, OLD.input_count,
    OLD.input_set_digest, OLD.deadline_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization' AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('running', 'completed', 'fallback', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('completed', 'fallback', 'failed'))) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.authorization_plan_bytes IS NOT NULL AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.authorization_disposition IS NOT NULL AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL
      AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason
      AND NOT (
        (OLD.terminal_reason = 'conductor_pending'
          AND (NEW.terminal_reason ~ '^conductor_verified_(deterministic|floor_manager)_history_(not_requested|verified)_(wake|ask_user|silent)$'
            OR NEW.terminal_reason LIKE 'conductor_fallback_%'
            OR NEW.terminal_reason IN ('deadline_expired', 'process_lost')))
        OR (OLD.terminal_reason ~ '^conductor_verified_(deterministic|floor_manager)_history_(not_requested|verified)_(wake|ask_user|silent)$'
          AND (NEW.terminal_reason LIKE 'conductor_fallback_%'
            OR NEW.terminal_reason IN ('deadline_expired', 'process_lost')))
      ))
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
