CREATE OR REPLACE FUNCTION app_is_canonical_codex_utc_timestamp(p_value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_timestamp timestamptz; BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN RETURN false; END IF;
  BEGIN v_timestamp := p_value::timestamptz; EXCEPTION WHEN others THEN RETURN false; END;
  RETURN to_char(v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = p_value;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_canonical_codex_date(p_value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_date date; BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
  BEGIN v_date := make_date(substring(p_value FROM 1 FOR 4)::integer,substring(p_value FROM 6 FOR 2)::integer,substring(p_value FROM 9 FOR 2)::integer); EXCEPTION WHEN others THEN RETURN false; END;
  RETURN to_char(v_date,'YYYY-MM-DD') = p_value;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_codex_json_exact(p_value jsonb, p_keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_typeof(p_value) = 'object' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_value) key) IS NOT DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM unnest(p_keys) key)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_valid_codex_usage_snapshot(p_snapshot jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v jsonb; k text; daily jsonb; BEGIN
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' OR octet_length(p_snapshot::text) > 16384 OR NOT (p_snapshot ? 'schemaVersion') OR jsonb_typeof(p_snapshot -> 'schemaVersion') <> 'number' OR p_snapshot ->> 'schemaVersion' <> '1' OR NOT public.app_codex_json_exact(p_snapshot,ARRAY['schemaVersion','rateLimits','usage']) THEN
    -- Exactly one projection may be omitted, but no unknown top-level key may survive.
    IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' OR octet_length(p_snapshot::text) > 16384 OR NOT (p_snapshot ? 'schemaVersion') OR jsonb_typeof(p_snapshot -> 'schemaVersion') <> 'number' OR p_snapshot ->> 'schemaVersion' <> '1' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_snapshot) key WHERE key NOT IN ('schemaVersion','rateLimits','usage')) THEN RETURN false; END IF;
  END IF;
  IF NOT (p_snapshot ? 'rateLimits' OR p_snapshot ? 'usage') THEN RETURN false; END IF;
  IF p_snapshot ? 'rateLimits' THEN
    v := p_snapshot->'rateLimits';
    IF NOT public.app_codex_json_exact(v,ARRAY['primary','secondary','plan','credits','spendControl','reached','observedAt','freshness']) OR jsonb_typeof(v->'observedAt') <> 'string' OR NOT public.app_is_canonical_codex_utc_timestamp(v->>'observedAt') OR jsonb_typeof(v->'freshness') <> 'string' OR v->>'freshness' NOT IN ('live','cached','stale') THEN RETURN false; END IF;
    FOREACH k IN ARRAY ARRAY['primary','secondary'] LOOP
      v := (p_snapshot->'rateLimits')->k;
      IF v <> 'null'::jsonb AND (NOT public.app_codex_json_exact(v,ARRAY['usedPercent','windowDurationMins','resetsAt']) OR jsonb_typeof(v->'usedPercent') <> 'number' OR (v->>'usedPercent')::numeric NOT BETWEEN 0 AND 100 OR (v->'windowDurationMins'<>'null'::jsonb AND (jsonb_typeof(v->'windowDurationMins')<>'number' OR (v->>'windowDurationMins')::numeric <> trunc((v->>'windowDurationMins')::numeric) OR (v->>'windowDurationMins')::numeric NOT BETWEEN 0 AND 10080)) OR (v->'resetsAt'<>'null'::jsonb AND (jsonb_typeof(v->'resetsAt')<>'string' OR NOT public.app_is_canonical_codex_utc_timestamp(v->>'resetsAt')))) THEN RETURN false; END IF;
    END LOOP;
    v := (p_snapshot->'rateLimits')->'plan'; IF v <> 'null'::jsonb AND (jsonb_typeof(v)<>'string' OR v#>>'{}' NOT IN ('free','go','plus','pro','prolite','team','business','enterprise','edu','usage_based','unknown')) THEN RETURN false; END IF;
    v := (p_snapshot->'rateLimits')->'credits'; IF v <> 'null'::jsonb AND (NOT public.app_codex_json_exact(v,ARRAY['hasCredits','unlimited','balance']) OR jsonb_typeof(v->'hasCredits')<>'boolean' OR jsonb_typeof(v->'unlimited')<>'boolean' OR (v->'balance'<>'null'::jsonb AND (jsonb_typeof(v->'balance')<>'string' OR octet_length(convert_to(v->>'balance','UTF8')) NOT BETWEEN 1 AND 64))) THEN RETURN false; END IF;
    v := (p_snapshot->'rateLimits')->'spendControl'; IF v <> 'null'::jsonb AND (NOT public.app_codex_json_exact(v,ARRAY['limit','used','remainingPercent','resetsAt']) OR jsonb_typeof(v->'limit')<>'string' OR octet_length(convert_to(v->>'limit','UTF8')) NOT BETWEEN 1 AND 64 OR jsonb_typeof(v->'used')<>'string' OR octet_length(convert_to(v->>'used','UTF8')) NOT BETWEEN 1 AND 64 OR jsonb_typeof(v->'remainingPercent')<>'number' OR (v->>'remainingPercent')::numeric NOT BETWEEN 0 AND 100 OR jsonb_typeof(v->'resetsAt')<>'string' OR NOT public.app_is_canonical_codex_utc_timestamp(v->>'resetsAt')) THEN RETURN false; END IF;
    v := (p_snapshot->'rateLimits')->'reached'; IF v <> 'null'::jsonb AND (jsonb_typeof(v)<>'string' OR v#>>'{}' NOT IN ('rate_limit_reached','credits_depleted','usage_limit_reached')) THEN RETURN false; END IF;
  END IF;
  IF p_snapshot ? 'usage' THEN
    v := p_snapshot->'usage'; IF NOT public.app_codex_json_exact(v,ARRAY['summary','daily','observedAt','freshness']) OR jsonb_typeof(v->'daily')<>'array' OR jsonb_array_length(v->'daily') > 31 OR jsonb_typeof(v->'observedAt')<>'string' OR NOT public.app_is_canonical_codex_utc_timestamp(v->>'observedAt') OR jsonb_typeof(v->'freshness')<>'string' OR v->>'freshness' NOT IN ('live','cached','stale') THEN RETURN false; END IF;
    v := v->'summary'; IF NOT public.app_codex_json_exact(v,ARRAY['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays']) THEN RETURN false; END IF;
    FOREACH k IN ARRAY ARRAY['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'] LOOP IF v->k <> 'null'::jsonb AND (jsonb_typeof(v->k)<>'string' OR v->>k !~ '^[0-9]{1,32}$') THEN RETURN false; END IF; END LOOP;
    FOR daily IN SELECT value FROM jsonb_array_elements((p_snapshot->'usage')->'daily') LOOP IF NOT public.app_codex_json_exact(daily,ARRAY['startDate','tokens']) OR jsonb_typeof(daily->'startDate')<>'string' OR NOT public.app_is_canonical_codex_date(daily->>'startDate') OR jsonb_typeof(daily->'tokens')<>'string' OR daily->>'tokens' !~ '^[0-9]{1,32}$' THEN RETURN false; END IF; END LOOP;
  END IF; RETURN true;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_is_valid_codex_user_input_questions(p_questions jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_question jsonb;
  v_option jsonb;
  v_question_ids text[] := ARRAY[]::text[];
  v_option_ids text[];
BEGIN
  IF p_questions IS NULL
    OR jsonb_typeof(p_questions) <> 'array'
    OR jsonb_array_length(p_questions) > 3 THEN
    RETURN false;
  END IF;

  FOR v_question IN SELECT value FROM jsonb_array_elements(p_questions) LOOP
    IF NOT public.app_codex_json_exact(v_question, ARRAY['id','header','question','isOther','isSecret','options'])
      OR jsonb_typeof(v_question->'id') <> 'string'
      OR octet_length(convert_to(v_question->>'id', 'UTF8')) NOT BETWEEN 1 AND 512
      OR jsonb_typeof(v_question->'header') <> 'string'
      OR octet_length(convert_to(v_question->>'header', 'UTF8')) > 128
      OR jsonb_typeof(v_question->'question') <> 'string'
      OR octet_length(convert_to(v_question->>'question', 'UTF8')) NOT BETWEEN 1 AND 4096
      OR jsonb_typeof(v_question->'isOther') <> 'boolean'
      OR jsonb_typeof(v_question->'isSecret') <> 'boolean' THEN
      RETURN false;
    END IF;
    v_question_ids := array_append(v_question_ids, v_question->>'id');

    IF v_question->'options' = 'null'::jsonb THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_question->'options') <> 'array'
      OR jsonb_array_length(v_question->'options') > 3 THEN
      RETURN false;
    END IF;
    v_option_ids := ARRAY[]::text[];
    FOR v_option IN SELECT value FROM jsonb_array_elements(v_question->'options') LOOP
      IF NOT public.app_codex_json_exact(v_option, ARRAY['id','label','description'])
        OR jsonb_typeof(v_option->'id') <> 'string'
        OR octet_length(convert_to(v_option->>'id', 'UTF8')) NOT BETWEEN 1 AND 512
        OR jsonb_typeof(v_option->'label') <> 'string'
        OR octet_length(convert_to(v_option->>'label', 'UTF8')) NOT BETWEEN 1 AND 256
        OR jsonb_typeof(v_option->'description') <> 'string'
        OR octet_length(convert_to(v_option->>'description', 'UTF8')) NOT BETWEEN 1 AND 1024 THEN
        RETURN false;
      END IF;
      v_option_ids := array_append(v_option_ids, v_option->>'id');
    END LOOP;
    IF cardinality(v_option_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_option_ids))) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN cardinality(v_question_ids) = cardinality(ARRAY(SELECT DISTINCT unnest(v_question_ids)));
END;
$$;
--> statement-breakpoint



CREATE TABLE "codex_account_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"relay_id" text NOT NULL,
	"home_handle" text NOT NULL,
	"label" varchar(120) NOT NULL,
	"profile_generation" integer DEFAULT 0 NOT NULL,
	"account_generation" integer DEFAULT 0 NOT NULL,
	"auth_state" varchar(32) DEFAULT 'signed_out' NOT NULL,
	"plan_type" varchar(120),
	"usage_snapshot" jsonb,
	"usage_observed_at" timestamp with time zone,
	"last_error_code" varchar(96),
	"revision" integer DEFAULT 0 NOT NULL,
	"removal_state" varchar(16) DEFAULT 'active' NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_codex_account_profiles_user_id" UNIQUE("user_id","id"),
	CONSTRAINT "codex_account_profiles_auth_state_check" CHECK ("codex_account_profiles"."auth_state" IN ('signed_out', 'login_pending', 'signed_in', 'expired', 'error')),
	CONSTRAINT "codex_account_profiles_revision_check" CHECK ("codex_account_profiles"."revision" >= 0 AND "codex_account_profiles"."profile_generation" >= 0 AND "codex_account_profiles"."account_generation" >= 0),
	CONSTRAINT "codex_account_profiles_removal_state_check" CHECK (("codex_account_profiles"."removal_state" IN ('active', 'removing') AND "codex_account_profiles"."removed_at" IS NULL)
        OR ("codex_account_profiles"."removal_state" = 'removed' AND "codex_account_profiles"."removed_at" IS NOT NULL)),
	CONSTRAINT "codex_account_profiles_plan_type_check" CHECK ("codex_account_profiles"."plan_type" IS NULL OR "codex_account_profiles"."plan_type" IN ('free', 'go', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu', 'usage_based', 'unknown')),
	CONSTRAINT "codex_account_profiles_usage_snapshot_check" CHECK ("codex_account_profiles"."usage_snapshot" IS NULL OR app_is_valid_codex_usage_snapshot("codex_account_profiles"."usage_snapshot")),
	CONSTRAINT "codex_account_profiles_usage_freshness_check" CHECK (("codex_account_profiles"."usage_snapshot" IS NULL AND "codex_account_profiles"."usage_observed_at" IS NULL)
        OR ("codex_account_profiles"."usage_snapshot" IS NOT NULL
          AND "codex_account_profiles"."usage_observed_at" IS NOT NULL
          AND "codex_account_profiles"."usage_observed_at" >= "codex_account_profiles"."created_at"
          AND "codex_account_profiles"."usage_observed_at" <= "codex_account_profiles"."updated_at")),
	CONSTRAINT "codex_account_profiles_home_handle_check" CHECK (char_length("codex_account_profiles"."home_handle") BETWEEN 1 AND 512
        AND position('/' in "codex_account_profiles"."home_handle") = 0
        AND position(chr(92) in "codex_account_profiles"."home_handle") = 0
        AND position('..' in "codex_account_profiles"."home_handle") = 0)
);
--> statement-breakpoint
CREATE TABLE "codex_thread_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"room_id" uuid NOT NULL,
	"lane_key" text NOT NULL,
	"binding_kind" varchar(16) NOT NULL,
	"relay_id" text NOT NULL,
	"relay_session_id" text NOT NULL,
	"desktop_session_id" text NOT NULL,
	"pairing_generation_ref" text NOT NULL,
	"capability_revision" integer NOT NULL,
	"workspace_ref" text NOT NULL,
	"workspace_revision" integer NOT NULL,
	"workspace_fingerprint" text NOT NULL,
	"workspace_issued_at" timestamp with time zone NOT NULL,
	"workspace_expires_at" timestamp with time zone NOT NULL,
	"account_profile_id" uuid NOT NULL,
	"codex_thread_id" text NOT NULL,
	"profile_generation" integer NOT NULL,
	"account_generation" integer NOT NULL,
	"runtime_generation" integer NOT NULL,
	"child_generation" integer NOT NULL,
	"binding_generation" integer DEFAULT 0 NOT NULL,
	"selected_model" text,
	"codex_sandbox_mode" varchar(32) NOT NULL,
	"codex_approval_policy" varchar(32) NOT NULL,
	"state" varchar(32) DEFAULT 'opening' NOT NULL,
	"last_turn_id" text,
	"last_item_cursor" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "uq_codex_thread_bindings_user_id" UNIQUE("user_id","id"),
	CONSTRAINT "codex_thread_bindings_generations_check" CHECK ("codex_thread_bindings"."capability_revision" >= 0 AND "codex_thread_bindings"."workspace_revision" >= 0 AND "codex_thread_bindings"."profile_generation" >= 0 AND "codex_thread_bindings"."account_generation" >= 0 AND "codex_thread_bindings"."runtime_generation" >= 0 AND "codex_thread_bindings"."child_generation" >= 0 AND "codex_thread_bindings"."binding_generation" >= 0 AND "codex_thread_bindings"."revision" >= 0),
	CONSTRAINT "codex_thread_bindings_sandbox_check" CHECK ("codex_thread_bindings"."codex_sandbox_mode" IN ('default', 'workspace-write', 'danger-full-access')),
	CONSTRAINT "codex_thread_bindings_approval_check" CHECK ("codex_thread_bindings"."codex_approval_policy" IN ('default', 'on-request', 'never')),
	CONSTRAINT "codex_thread_bindings_state_check" CHECK ("codex_thread_bindings"."state" IN ('opening', 'active', 'queued', 'awaiting_approval', 'awaiting_input', 'needs_rebind', 'completed', 'cancelled', 'errored', 'recovery_required', 'archived')),
	CONSTRAINT "codex_thread_bindings_kind_check" CHECK ("codex_thread_bindings"."binding_kind" = 'task'),
	CONSTRAINT "codex_thread_bindings_workspace_receipt_time_check" CHECK ("codex_thread_bindings"."workspace_issued_at" < "codex_thread_bindings"."workspace_expires_at"),
	CONSTRAINT "codex_thread_bindings_archive_state_check" CHECK (("codex_thread_bindings"."archived_at" IS NULL AND "codex_thread_bindings"."state" <> 'archived') OR ("codex_thread_bindings"."archived_at" IS NOT NULL AND "codex_thread_bindings"."state" = 'archived'))
);
--> statement-breakpoint
CREATE TABLE "codex_user_input_requests" (
	"request_ref" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"codex_thread_id" text NOT NULL,
	"codex_turn_id" text NOT NULL,
	"codex_item_id" text NOT NULL,
	"questions" jsonb NOT NULL,
	"auto_resolution_ms" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"state" varchar(24) DEFAULT 'awaiting_human' NOT NULL,
	"failure_code" varchar(96),
	"revision" integer DEFAULT 0 NOT NULL,
	"dispatching_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codex_user_input_requests_ref_check" CHECK (octet_length(convert_to("codex_user_input_requests"."request_ref", 'UTF8')) BETWEEN 1 AND 512),
	CONSTRAINT "codex_user_input_requests_correlation_check" CHECK (octet_length(convert_to("codex_user_input_requests"."codex_thread_id", 'UTF8')) BETWEEN 1 AND 512
        AND octet_length(convert_to("codex_user_input_requests"."codex_turn_id", 'UTF8')) BETWEEN 1 AND 512
        AND octet_length(convert_to("codex_user_input_requests"."codex_item_id", 'UTF8')) BETWEEN 1 AND 512
        AND "codex_user_input_requests"."binding_generation" >= 0
        AND "codex_user_input_requests"."revision" >= 0),
	CONSTRAINT "codex_user_input_requests_questions_check" CHECK (app_is_valid_codex_user_input_questions("codex_user_input_requests"."questions")),
	CONSTRAINT "codex_user_input_requests_auto_resolution_check" CHECK ("codex_user_input_requests"."auto_resolution_ms" IS NULL OR "codex_user_input_requests"."auto_resolution_ms" BETWEEN 0 AND 300000),
	CONSTRAINT "codex_user_input_requests_expiry_check" CHECK ("codex_user_input_requests"."expires_at" > "codex_user_input_requests"."created_at"),
	CONSTRAINT "codex_user_input_requests_timestamp_order_check" CHECK ("codex_user_input_requests"."updated_at" >= "codex_user_input_requests"."created_at"
        AND ("codex_user_input_requests"."dispatching_at" IS NULL OR "codex_user_input_requests"."dispatching_at" >= "codex_user_input_requests"."created_at")
        AND ("codex_user_input_requests"."submitted_at" IS NULL OR ("codex_user_input_requests"."submitted_at" >= "codex_user_input_requests"."created_at"
          AND "codex_user_input_requests"."dispatching_at" IS NOT NULL
          AND "codex_user_input_requests"."submitted_at" >= "codex_user_input_requests"."dispatching_at"))
        AND ("codex_user_input_requests"."terminal_at" IS NULL OR "codex_user_input_requests"."terminal_at" >= "codex_user_input_requests"."created_at")),
	CONSTRAINT "codex_user_input_requests_state_check" CHECK ("codex_user_input_requests"."state" IN ('awaiting_human', 'dispatching', 'submitted', 'expired', 'cancelled', 'unavailable', 'terminal')),
	CONSTRAINT "codex_user_input_requests_failure_check" CHECK ("codex_user_input_requests"."failure_code" IS NULL OR "codex_user_input_requests"."failure_code" IN ('CODEX_REQUEST_EXPIRED', 'CODEX_REQUEST_CANCELLED', 'CODEX_REQUEST_UNAVAILABLE')),
	CONSTRAINT "codex_user_input_requests_transition_shape_check" CHECK (("codex_user_input_requests"."state" = 'awaiting_human'
          AND "codex_user_input_requests"."dispatching_at" IS NULL
          AND "codex_user_input_requests"."submitted_at" IS NULL
          AND "codex_user_input_requests"."terminal_at" IS NULL
          AND "codex_user_input_requests"."failure_code" IS NULL)
        OR ("codex_user_input_requests"."state" = 'dispatching'
          AND "codex_user_input_requests"."dispatching_at" IS NOT NULL
          AND "codex_user_input_requests"."submitted_at" IS NULL
          AND "codex_user_input_requests"."terminal_at" IS NULL
          AND "codex_user_input_requests"."failure_code" IS NULL)
        OR ("codex_user_input_requests"."state" = 'submitted'
          AND "codex_user_input_requests"."dispatching_at" IS NOT NULL
          AND "codex_user_input_requests"."submitted_at" IS NOT NULL
          AND "codex_user_input_requests"."terminal_at" IS NULL
          AND "codex_user_input_requests"."failure_code" IS NULL)
        OR ("codex_user_input_requests"."state" = 'expired'
          AND "codex_user_input_requests"."terminal_at" IS NOT NULL
          AND "codex_user_input_requests"."failure_code" = 'CODEX_REQUEST_EXPIRED')
        OR ("codex_user_input_requests"."state" = 'cancelled'
          AND "codex_user_input_requests"."terminal_at" IS NOT NULL
          AND "codex_user_input_requests"."failure_code" = 'CODEX_REQUEST_CANCELLED')
        OR ("codex_user_input_requests"."state" = 'unavailable'
          AND "codex_user_input_requests"."terminal_at" IS NOT NULL
          AND "codex_user_input_requests"."failure_code" = 'CODEX_REQUEST_UNAVAILABLE')
        OR ("codex_user_input_requests"."state" = 'terminal'
          AND "codex_user_input_requests"."terminal_at" IS NOT NULL
          AND "codex_user_input_requests"."failure_code" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "codex_user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"account_profile_id" uuid,
	"default_posture" varchar(32) DEFAULT 'codex_default' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codex_user_preferences_posture_check" CHECK ("codex_user_preferences"."default_posture" IN ('codex_default', 'prompted_workspace', 'full_access_headless')),
	CONSTRAINT "codex_user_preferences_revision_check" CHECK ("codex_user_preferences"."revision" >= 0),
	CONSTRAINT "codex_user_preferences_enabled_profile_check" CHECK ("codex_user_preferences"."enabled" = false OR "codex_user_preferences"."account_profile_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "codex_account_profiles" ADD CONSTRAINT "codex_account_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_bindings" ADD CONSTRAINT "codex_thread_bindings_profile_owner_fk" FOREIGN KEY ("user_id","account_profile_id") REFERENCES "public"."codex_account_profiles"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_input_requests" ADD CONSTRAINT "codex_user_input_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_input_requests" ADD CONSTRAINT "codex_user_input_requests_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_input_requests" ADD CONSTRAINT "codex_user_input_requests_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_input_requests" ADD CONSTRAINT "codex_user_input_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_input_requests" ADD CONSTRAINT "codex_user_input_requests_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_input_requests" ADD CONSTRAINT "codex_user_input_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_input_requests" ADD CONSTRAINT "codex_user_input_requests_binding_owner_fk" FOREIGN KEY ("user_id","binding_id") REFERENCES "public"."codex_thread_bindings"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_preferences" ADD CONSTRAINT "codex_user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_user_preferences" ADD CONSTRAINT "codex_user_preferences_profile_owner_fk" FOREIGN KEY ("user_id","account_profile_id") REFERENCES "public"."codex_account_profiles"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_codex_account_profiles_user_relay_home" ON "codex_account_profiles" USING btree ("user_id","relay_id","home_handle");--> statement-breakpoint
CREATE INDEX "idx_codex_account_profiles_user" ON "codex_account_profiles" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_codex_account_profiles_owner_visible" ON "codex_account_profiles" USING btree ("user_id","updated_at") WHERE "codex_account_profiles"."removal_state" <> 'removed';--> statement-breakpoint
CREATE INDEX "idx_codex_account_profiles_user_relay" ON "codex_account_profiles" USING btree ("user_id","relay_id");--> statement-breakpoint
CREATE INDEX "idx_codex_thread_bindings_user_created" ON "codex_thread_bindings" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_codex_thread_bindings_task" ON "codex_thread_bindings" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_codex_thread_bindings_task_run" ON "codex_thread_bindings" USING btree ("task_run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_codex_thread_bindings_job" ON "codex_thread_bindings" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_codex_thread_bindings_profile" ON "codex_thread_bindings" USING btree ("account_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_codex_thread_bindings_room_lane" ON "codex_thread_bindings" USING btree ("room_id","lane_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_codex_thread_bindings_active_task" ON "codex_thread_bindings" USING btree ("user_id","task_id") WHERE "codex_thread_bindings"."binding_kind" = 'task' AND "codex_thread_bindings"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_codex_user_input_requests_binding_turn_item" ON "codex_user_input_requests" USING btree ("binding_id","binding_generation","codex_thread_id","codex_turn_id","codex_item_id");--> statement-breakpoint
CREATE INDEX "idx_codex_user_input_requests_owner_state_expiry" ON "codex_user_input_requests" USING btree ("user_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "idx_codex_user_input_requests_terminal_retention" ON "codex_user_input_requests" USING btree ("terminal_at") WHERE "codex_user_input_requests"."terminal_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_codex_user_preferences_profile" ON "codex_user_preferences" USING btree ("account_profile_id") WHERE "codex_user_preferences"."account_profile_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION app_can_access_codex_binding(p_user_id uuid,p_source_agent_id uuid,p_task_id uuid,p_task_run_id uuid,p_job_id uuid,p_parent_task_id uuid,p_room_id uuid,p_lane_key text) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT app_current_user_id() IS NOT NULL AND app_current_agent_id() IS NOT NULL AND p_user_id=app_current_user_id() AND p_source_agent_id=app_current_agent_id() AND app_caller_in_room(p_room_id) AND app_agent_in_room(p_room_id,p_source_agent_id) AND EXISTS(SELECT 1 FROM tasks source_task JOIN task_runs source_run ON source_run.id=p_task_run_id AND source_run.task_id=source_task.id AND source_run.job_id=p_job_id JOIN jobs source_job ON source_job.id=p_job_id WHERE source_task.id=p_task_id AND source_task.owner_id=p_user_id AND source_task.agent_id=p_source_agent_id AND source_task.parent_task_id IS NOT DISTINCT FROM p_parent_task_id AND (source_task.calling_room_id=p_room_id OR source_task.target_room_id=p_room_id) AND source_job.owner_id=p_user_id AND source_job.room_id=p_room_id AND source_job.lane_key=p_lane_key)
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_can_access_codex_binding(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text) TO PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_reject_codex_binding_immutable_update() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE changed boolean; BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.source_agent_id IS DISTINCT FROM OLD.source_agent_id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.task_run_id IS DISTINCT FROM OLD.task_run_id OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.lane_key IS DISTINCT FROM OLD.lane_key OR NEW.binding_kind IS DISTINCT FROM OLD.binding_kind OR NEW.relay_id IS DISTINCT FROM OLD.relay_id OR NEW.pairing_generation_ref IS DISTINCT FROM OLD.pairing_generation_ref OR NEW.workspace_fingerprint IS DISTINCT FROM OLD.workspace_fingerprint OR NEW.account_profile_id IS DISTINCT FROM OLD.account_profile_id OR NEW.codex_thread_id IS DISTINCT FROM OLD.codex_thread_id OR NEW.profile_generation IS DISTINCT FROM OLD.profile_generation OR NEW.account_generation IS DISTINCT FROM OLD.account_generation OR NEW.runtime_generation IS DISTINCT FROM OLD.runtime_generation OR NEW.selected_model IS DISTINCT FROM OLD.selected_model OR NEW.codex_sandbox_mode IS DISTINCT FROM OLD.codex_sandbox_mode OR NEW.codex_approval_policy IS DISTINCT FROM OLD.codex_approval_policy THEN RAISE EXCEPTION 'codex_thread_bindings immutable provenance cannot change' USING ERRCODE='23514'; END IF;
 IF OLD.archived_at IS NOT NULL THEN RAISE EXCEPTION 'archived codex_thread_bindings rows are immutable' USING ERRCODE='23514'; END IF;
 changed := NEW.relay_session_id IS DISTINCT FROM OLD.relay_session_id OR NEW.desktop_session_id IS DISTINCT FROM OLD.desktop_session_id OR NEW.capability_revision IS DISTINCT FROM OLD.capability_revision OR NEW.workspace_ref IS DISTINCT FROM OLD.workspace_ref OR NEW.workspace_revision IS DISTINCT FROM OLD.workspace_revision OR NEW.workspace_issued_at IS DISTINCT FROM OLD.workspace_issued_at OR NEW.workspace_expires_at IS DISTINCT FROM OLD.workspace_expires_at OR NEW.child_generation IS DISTINCT FROM OLD.child_generation OR NEW.binding_generation IS DISTINCT FROM OLD.binding_generation;
 IF NEW.archived_at IS NOT NULL OR NEW.state='archived' THEN IF NEW.archived_at IS NULL OR NEW.state<>'archived' OR changed THEN RAISE EXCEPTION 'codex_thread_bindings must archive without changing live scope' USING ERRCODE='23514'; END IF; RETURN NEW; END IF;
 IF changed THEN IF OLD.state<>'needs_rebind' OR NEW.state<>'active' OR NEW.binding_generation<>OLD.binding_generation+1 OR NEW.revision<>OLD.revision+1 OR NEW.workspace_issued_at>=NEW.workspace_expires_at THEN RAISE EXCEPTION 'codex_thread_bindings rebind requires exact needs_rebind transition' USING ERRCODE='23514'; END IF; RETURN NEW; END IF;
 IF OLD.state='needs_rebind' AND NEW.state<>'needs_rebind' THEN RAISE EXCEPTION 'codex_thread_bindings must refresh receipt scope before leaving needs_rebind' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;

CREATE TRIGGER codex_thread_bindings_immutable_tuple BEFORE UPDATE ON codex_thread_bindings FOR EACH ROW EXECUTE FUNCTION app_reject_codex_binding_immutable_update();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_reject_nonactive_codex_profile_reference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_removal_state varchar(16); BEGIN
  IF NEW.account_profile_id IS NULL THEN RETURN NEW; END IF;
  SELECT removal_state INTO v_removal_state
    FROM public.codex_account_profiles
    WHERE id = NEW.account_profile_id AND user_id = NEW.user_id
    FOR KEY SHARE;
  IF NOT FOUND OR v_removal_state <> 'active' THEN
    RAISE EXCEPTION 'codex account profile must be active for a new preference or binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER codex_thread_bindings_require_active_profile
  BEFORE INSERT ON codex_thread_bindings
  FOR EACH ROW EXECUTE FUNCTION app_reject_nonactive_codex_profile_reference();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_enforce_codex_profile_removal_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.removal_state = 'active' THEN
    IF NEW.removal_state = 'active' THEN
      IF NEW.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'active codex profile cannot have removed_at' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.removal_state <> 'removing' OR NEW.removed_at IS NOT NULL
      OR NEW.revision <> OLD.revision + 1
      OR NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.relay_id IS DISTINCT FROM OLD.relay_id OR NEW.home_handle IS DISTINCT FROM OLD.home_handle
      OR NEW.profile_generation IS DISTINCT FROM OLD.profile_generation
      OR NEW.account_generation IS DISTINCT FROM OLD.account_generation
      OR NEW.label IS DISTINCT FROM OLD.label OR NEW.auth_state IS DISTINCT FROM OLD.auth_state
      OR NEW.plan_type IS DISTINCT FROM OLD.plan_type OR NEW.usage_snapshot IS DISTINCT FROM OLD.usage_snapshot
      OR NEW.usage_observed_at IS DISTINCT FROM OLD.usage_observed_at
      OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'codex profile removal must start as an exact active to removing transition' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.removal_state = 'removing' THEN
    IF NEW.removal_state <> 'removed' OR NEW.removed_at IS NULL
      OR NEW.auth_state <> 'signed_out' OR NEW.revision <> OLD.revision + 1
      OR NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.relay_id IS DISTINCT FROM OLD.relay_id OR NEW.home_handle IS DISTINCT FROM OLD.home_handle
      OR NEW.profile_generation IS DISTINCT FROM OLD.profile_generation
      OR NEW.account_generation IS DISTINCT FROM OLD.account_generation
      OR NEW.label IS DISTINCT FROM OLD.label OR NEW.plan_type IS DISTINCT FROM OLD.plan_type
      OR NEW.usage_snapshot IS DISTINCT FROM OLD.usage_snapshot
      OR NEW.usage_observed_at IS DISTINCT FROM OLD.usage_observed_at
      OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'codex profile removal must finalize as an exact removing to removed transition' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'removed codex account profiles are immutable' USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER codex_account_profiles_removal_lifecycle
  BEFORE UPDATE ON codex_account_profiles
  FOR EACH ROW EXECUTE FUNCTION app_enforce_codex_profile_removal_lifecycle();

CREATE TRIGGER codex_user_preferences_require_active_profile
  BEFORE INSERT OR UPDATE OF account_profile_id, enabled ON codex_user_preferences
  FOR EACH ROW EXECUTE FUNCTION app_reject_nonactive_codex_profile_reference();--> statement-breakpoint
ALTER TABLE codex_user_preferences ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE codex_user_preferences FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY codex_user_preferences_owner ON codex_user_preferences
  FOR ALL
  USING (user_id=app_current_user_id())
  WITH CHECK (user_id=app_current_user_id());--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON codex_user_preferences TO nautilo_agent;
  END IF;
END $$;

-- D453 — profile removal is owned by a Human across every Genie.  The normal
-- codex_thread_bindings RLS policy correctly requires a current Agent, so a
-- server-only owner operation cannot use an arbitrary Agent-scoped read.
-- These two narrow SECURITY DEFINER functions are the sole exception.

CREATE OR REPLACE FUNCTION app_list_codex_profile_removal_work(
  p_user_id uuid,
  p_profile_id uuid
)
RETURNS TABLE(task_id uuid, job_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_current_user_id() IS NULL OR app_current_user_id() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'codex profile removal owner is unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT binding.task_id, binding.job_id
  FROM public.codex_thread_bindings AS binding
  INNER JOIN public.codex_account_profiles AS profile
    ON profile.id = binding.account_profile_id
    AND profile.user_id = binding.user_id
  WHERE profile.id = p_profile_id
    AND profile.user_id = p_user_id
    AND profile.removal_state = 'removing'
    AND binding.user_id = p_user_id
    AND binding.account_profile_id = p_profile_id
    AND binding.archived_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_archive_codex_profile_removal_bindings(
  p_user_id uuid,
  p_profile_id uuid,
  p_relay_id text,
  p_home_handle text,
  p_profile_generation integer,
  p_account_generation integer,
  p_expected_revision integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF app_current_user_id() IS NULL OR app_current_user_id() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'codex profile removal owner is unauthorized' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.codex_account_profiles AS profile
  WHERE profile.id = p_profile_id
    AND profile.user_id = p_user_id
    AND profile.removal_state = 'removing'
    AND profile.revision = p_expected_revision
    AND profile.relay_id = p_relay_id
    AND profile.home_handle = p_home_handle
    AND profile.profile_generation = p_profile_generation
    AND profile.account_generation = p_account_generation
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.codex_thread_bindings AS binding
  SET state = 'archived',
      archived_at = now(),
      revision = binding.revision + 1,
      updated_at = now()
  WHERE binding.user_id = p_user_id
    AND binding.account_profile_id = p_profile_id
    AND binding.archived_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION app_list_codex_profile_removal_work(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_archive_codex_profile_removal_bindings(uuid, uuid, text, text, integer, integer, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo') THEN
    GRANT EXECUTE ON FUNCTION app_list_codex_profile_removal_work(uuid, uuid) TO nautilo;
    GRANT EXECUTE ON FUNCTION app_archive_codex_profile_removal_bindings(uuid, uuid, text, text, integer, integer, integer) TO nautilo;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_enforce_codex_user_input_request_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.request_ref IS DISTINCT FROM OLD.request_ref
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.source_agent_id IS DISTINCT FROM OLD.source_agent_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.task_run_id IS DISTINCT FROM OLD.task_run_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.binding_generation IS DISTINCT FROM OLD.binding_generation
    OR NEW.codex_thread_id IS DISTINCT FROM OLD.codex_thread_id
    OR NEW.codex_turn_id IS DISTINCT FROM OLD.codex_turn_id
    OR NEW.codex_item_id IS DISTINCT FROM OLD.codex_item_id
    OR NEW.questions IS DISTINCT FROM OLD.questions
    OR NEW.auto_resolution_ms IS DISTINCT FROM OLD.auto_resolution_ms
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'codex user input request provenance is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'codex user input request transitions require an exact revision increment' USING ERRCODE='23514';
  END IF;
  IF OLD.state IN ('expired', 'cancelled', 'unavailable', 'terminal') THEN
    RAISE EXCEPTION 'terminal codex user input request is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state = 'awaiting_human' AND NEW.state NOT IN ('dispatching', 'expired', 'cancelled', 'unavailable', 'terminal') THEN
    RAISE EXCEPTION 'awaiting codex user input request has an invalid transition' USING ERRCODE='23514';
  END IF;
  IF OLD.state = 'dispatching' AND NEW.state NOT IN ('submitted', 'expired', 'cancelled', 'unavailable', 'terminal') THEN
    RAISE EXCEPTION 'dispatching codex user input request has an invalid transition' USING ERRCODE='23514';
  END IF;
  IF OLD.state = 'submitted' AND NEW.state NOT IN ('cancelled', 'unavailable', 'terminal') THEN
    RAISE EXCEPTION 'submitted codex user input request has an invalid transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER codex_user_input_requests_lifecycle
  BEFORE UPDATE ON codex_user_input_requests
  FOR EACH ROW EXECUTE FUNCTION app_enforce_codex_user_input_request_lifecycle();
--> statement-breakpoint

ALTER TABLE codex_user_input_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE codex_user_input_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY codex_user_input_requests_owner ON codex_user_input_requests
  FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON codex_user_input_requests TO nautilo_agent;
  END IF;
END $$;

ALTER TABLE codex_account_profiles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE codex_account_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE codex_thread_bindings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE codex_thread_bindings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY codex_account_profiles_owner ON codex_account_profiles FOR ALL USING (user_id=app_current_user_id()) WITH CHECK (user_id=app_current_user_id());--> statement-breakpoint
CREATE POLICY codex_thread_bindings_owner_room_agent ON codex_thread_bindings FOR ALL USING (app_can_access_codex_binding(user_id,source_agent_id,task_id,task_run_id,job_id,parent_task_id,room_id,lane_key)) WITH CHECK (app_can_access_codex_binding(user_id,source_agent_id,task_id,task_run_id,job_id,parent_task_id,room_id,lane_key));--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON codex_account_profiles, codex_thread_bindings, codex_user_input_requests, codex_user_preferences TO nautilo_agent;
  END IF;
END $$;--> statement-breakpoint
