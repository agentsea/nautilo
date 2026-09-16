CREATE TABLE "encryption_transition_history_read_admissions" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"client_request_key" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"subject_human_id" text NOT NULL,
	"reader_device_id" text,
	"reader_device_signing_key_generation" bigint,
	"host_authorization_revision" bigint,
	"room_id" uuid NOT NULL,
	"selected_coordinate_digest" "bytea" NOT NULL,
	"eligible_count" integer NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"consumption_kind" text,
	"acknowledgement_digest" "bytea",
	"ordered_result_set_digest" "bytea",
	"verified_count" integer DEFAULT 0 NOT NULL,
	"client_crypto_unavailable_count" integer DEFAULT 0 NOT NULL,
	"client_custody_unavailable_count" integer DEFAULT 0 NOT NULL,
	"current_read_authority_unavailable_count" integer DEFAULT 0 NOT NULL,
	"retained_key_material_unavailable_count" integer DEFAULT 0 NOT NULL,
	"signer_evidence_unavailable_count" integer DEFAULT 0 NOT NULL,
	"live_shadow_lifecycle_unavailable_count" integer DEFAULT 0 NOT NULL,
	"integrity_failure_count" integer DEFAULT 0 NOT NULL,
	"parity_mismatch_count" integer DEFAULT 0 NOT NULL,
	"client_observation_expired_count" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_transition_history_read_admissions_identity_shape" CHECK (length("encryption_transition_history_read_admissions"."operation_id") between 1 and 255
        and length("encryption_transition_history_read_admissions"."client_request_key") between 1 and 255
        and length("encryption_transition_history_read_admissions"."subject_human_id") between 1 and 255
        and "encryption_transition_history_read_admissions"."policy_revision" > 0
        and octet_length("encryption_transition_history_read_admissions"."selected_coordinate_digest") = 32
        and octet_length("encryption_transition_history_read_admissions"."token_digest") = 32
        and "encryption_transition_history_read_admissions"."eligible_count" between 1 and 50),
	CONSTRAINT "encryption_transition_history_read_admissions_device_shape" CHECK (("encryption_transition_history_read_admissions"."reader_device_id" is null) =
          ("encryption_transition_history_read_admissions"."reader_device_signing_key_generation" is null)
        and ("encryption_transition_history_read_admissions"."reader_device_id" is null) =
          ("encryption_transition_history_read_admissions"."host_authorization_revision" is null)
        and ("encryption_transition_history_read_admissions"."reader_device_id" is null
          or (length("encryption_transition_history_read_admissions"."reader_device_id") between 1 and 255
            and "encryption_transition_history_read_admissions"."reader_device_signing_key_generation" > 0
            and "encryption_transition_history_read_admissions"."host_authorization_revision" >= 0))),
	CONSTRAINT "encryption_transition_history_read_admissions_time_shape" CHECK ("encryption_transition_history_read_admissions"."expires_at" > "encryption_transition_history_read_admissions"."issued_at"
        and "encryption_transition_history_read_admissions"."updated_at" >= "encryption_transition_history_read_admissions"."issued_at"
        and ("encryption_transition_history_read_admissions"."terminal_at" is null or "encryption_transition_history_read_admissions"."terminal_at" >= "encryption_transition_history_read_admissions"."issued_at")),
	CONSTRAINT "encryption_transition_history_read_admissions_counts_nonnegative" CHECK ("encryption_transition_history_read_admissions"."verified_count" >= 0
        and "encryption_transition_history_read_admissions"."client_crypto_unavailable_count" >= 0
        and "encryption_transition_history_read_admissions"."client_custody_unavailable_count" >= 0
        and "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count" >= 0
        and "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count" >= 0
        and "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count" >= 0
        and "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count" >= 0
        and "encryption_transition_history_read_admissions"."integrity_failure_count" >= 0
        and "encryption_transition_history_read_admissions"."parity_mismatch_count" >= 0
        and "encryption_transition_history_read_admissions"."client_observation_expired_count" >= 0),
	CONSTRAINT "encryption_transition_history_read_admissions_state_shape" CHECK ((
        "encryption_transition_history_read_admissions"."state" = 'planned'
        and "encryption_transition_history_read_admissions"."consumption_kind" is null
        and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
        and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
        and "encryption_transition_history_read_admissions"."terminal_at" is null
        and "encryption_transition_history_read_admissions"."verified_count" + "encryption_transition_history_read_admissions"."client_crypto_unavailable_count"
          + "encryption_transition_history_read_admissions"."client_custody_unavailable_count"
          + "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count"
          + "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count"
          + "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count"
          + "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count"
          + "encryption_transition_history_read_admissions"."integrity_failure_count" + "encryption_transition_history_read_admissions"."parity_mismatch_count"
          + "encryption_transition_history_read_admissions"."client_observation_expired_count" = 0
      ) or (
        "encryption_transition_history_read_admissions"."state" = 'consumed'
        and "encryption_transition_history_read_admissions"."consumption_kind" in (
          'signed_acknowledgement', 'unavailable_token', 'server_unavailable'
        )
        and "encryption_transition_history_read_admissions"."terminal_at" is not null
        and "encryption_transition_history_read_admissions"."terminal_at" < "encryption_transition_history_read_admissions"."expires_at"
        and "encryption_transition_history_read_admissions"."client_observation_expired_count" = 0
        and "encryption_transition_history_read_admissions"."verified_count" + "encryption_transition_history_read_admissions"."client_crypto_unavailable_count"
          + "encryption_transition_history_read_admissions"."client_custody_unavailable_count"
          + "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count"
          + "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count"
          + "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count"
          + "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count"
          + "encryption_transition_history_read_admissions"."integrity_failure_count" + "encryption_transition_history_read_admissions"."parity_mismatch_count"
          = "encryption_transition_history_read_admissions"."eligible_count"
        and (
          ("encryption_transition_history_read_admissions"."consumption_kind" = 'signed_acknowledgement'
            and "encryption_transition_history_read_admissions"."reader_device_id" is not null
            and octet_length("encryption_transition_history_read_admissions"."acknowledgement_digest") = 32
            and octet_length("encryption_transition_history_read_admissions"."ordered_result_set_digest") = 32)
          or ("encryption_transition_history_read_admissions"."consumption_kind" = 'unavailable_token'
            and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
            and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
            and "encryption_transition_history_read_admissions"."verified_count" = 0
            and "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."integrity_failure_count" = 0
            and "encryption_transition_history_read_admissions"."parity_mismatch_count" = 0
            and ("encryption_transition_history_read_admissions"."client_crypto_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."client_custody_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"))
          or ("encryption_transition_history_read_admissions"."consumption_kind" = 'server_unavailable'
            and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
            and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
            and "encryption_transition_history_read_admissions"."verified_count" = 0
            and "encryption_transition_history_read_admissions"."client_custody_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."integrity_failure_count" = 0
            and "encryption_transition_history_read_admissions"."parity_mismatch_count" = 0
            and (
              "encryption_transition_history_read_admissions"."client_crypto_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
            ))
        )
      ) or (
        "encryption_transition_history_read_admissions"."state" = 'expired'
        and "encryption_transition_history_read_admissions"."consumption_kind" = 'expiry'
        and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
        and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
        and "encryption_transition_history_read_admissions"."terminal_at" = "encryption_transition_history_read_admissions"."expires_at"
        and "encryption_transition_history_read_admissions"."client_observation_expired_count" = "encryption_transition_history_read_admissions"."eligible_count"
        and "encryption_transition_history_read_admissions"."verified_count" + "encryption_transition_history_read_admissions"."client_crypto_unavailable_count"
          + "encryption_transition_history_read_admissions"."client_custody_unavailable_count"
          + "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count"
          + "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count"
          + "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count"
          + "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count"
          + "encryption_transition_history_read_admissions"."integrity_failure_count" + "encryption_transition_history_read_admissions"."parity_mismatch_count" = 0
      ))
);
--> statement-breakpoint
ALTER TABLE "encryption_transition_history_read_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" DROP CONSTRAINT "encryption_transition_observations_operation_check";--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" DROP CONSTRAINT "encryption_transition_observations_outcome_reason_coherent";--> statement-breakpoint
ALTER TABLE "encryption_transition_outcome_totals" DROP CONSTRAINT "encryption_transition_outcome_totals_vocabulary_check";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_encryption_transition_history_read_request" ON "encryption_transition_history_read_admissions" USING btree ("policy_revision","subject_human_id","client_request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_encryption_transition_history_read_token_digest" ON "encryption_transition_history_read_admissions" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "idx_encryption_transition_history_read_admissions_expiry" ON "encryption_transition_history_read_admissions" USING btree ("state","expires_at");--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" ADD CONSTRAINT "encryption_transition_observations_operation_check" CHECK ("encryption_transition_observation_buckets"."operation" in ('create', 'update', 'access_update', 'read', 'read_repair', 'unsupported'));--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" ADD CONSTRAINT "encryption_transition_observations_outcome_reason_coherent" CHECK ((
        ("encryption_transition_observation_buckets"."outcome" in ('verified', 'pending') and "encryption_transition_observation_buckets"."reason" = 'none')
        or ("encryption_transition_observation_buckets"."outcome" = 'reconciling' and "encryption_transition_observation_buckets"."reason" = 'response_lost')
        or ("encryption_transition_observation_buckets"."outcome" = 'unavailable' and "encryption_transition_observation_buckets"."reason" in (
          'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
          'client_crypto_preparation_failed', 'client_custody_unavailable',
          'current_read_authority_unavailable',
          'retained_key_material_unavailable', 'signer_evidence_unavailable',
          'live_shadow_lifecycle_unavailable',
          'namespace_encryption_not_ready', 'stale_authority_product',
          'client_observation_expired'
        ))
        or ("encryption_transition_observation_buckets"."outcome" = 'failed' and "encryption_transition_observation_buckets"."reason" in (
          'parity_mismatch', 'integrity_failure', 'publication_failure'
        ))
      ) and (
        ("encryption_transition_observation_buckets"."operation" = 'unsupported' and "encryption_transition_observation_buckets"."reason" = 'unsupported_operation')
        or ("encryption_transition_observation_buckets"."operation" <> 'unsupported' and "encryption_transition_observation_buckets"."reason" <> 'unsupported_operation')
      ) and (
        "encryption_transition_observation_buckets"."operation" <> 'read'
        or ("encryption_transition_observation_buckets"."family" = 'message'
          and "encryption_transition_observation_buckets"."outcome" in ('verified', 'unavailable', 'failed')
          and "encryption_transition_observation_buckets"."reason" in (
            'none', 'client_crypto_unavailable', 'client_custody_unavailable',
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable', 'client_observation_expired',
            'integrity_failure', 'parity_mismatch'
          ))
      ) and (
        "encryption_transition_observation_buckets"."reason" not in (
          'current_read_authority_unavailable',
          'retained_key_material_unavailable', 'signer_evidence_unavailable',
          'live_shadow_lifecycle_unavailable'
        ) or "encryption_transition_observation_buckets"."operation" = 'read'
      ));--> statement-breakpoint
ALTER TABLE "encryption_transition_outcome_totals" ADD CONSTRAINT "encryption_transition_outcome_totals_vocabulary_check" CHECK ("encryption_transition_outcome_totals"."family" in ('message', 'memory', 'artifact', 'record')
        and "encryption_transition_outcome_totals"."operation" in ('create', 'update', 'access_update', 'read', 'read_repair', 'unsupported')
        and (
          ("encryption_transition_outcome_totals"."outcome" in ('verified', 'pending') and "encryption_transition_outcome_totals"."reason" = 'none')
          or ("encryption_transition_outcome_totals"."outcome" = 'reconciling' and "encryption_transition_outcome_totals"."reason" = 'response_lost')
          or ("encryption_transition_outcome_totals"."outcome" = 'unavailable' and "encryption_transition_outcome_totals"."reason" in (
            'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
            'client_crypto_preparation_failed', 'client_custody_unavailable',
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable',
            'namespace_encryption_not_ready', 'stale_authority_product',
            'client_observation_expired'
          ))
          or ("encryption_transition_outcome_totals"."outcome" = 'failed' and "encryption_transition_outcome_totals"."reason" in (
            'parity_mismatch', 'integrity_failure', 'publication_failure'
          ))
        )
        and (
          ("encryption_transition_outcome_totals"."operation" = 'unsupported' and "encryption_transition_outcome_totals"."reason" = 'unsupported_operation')
          or ("encryption_transition_outcome_totals"."operation" <> 'unsupported' and "encryption_transition_outcome_totals"."reason" <> 'unsupported_operation')
        )
        and (
          "encryption_transition_outcome_totals"."operation" <> 'read'
          or ("encryption_transition_outcome_totals"."family" = 'message'
            and "encryption_transition_outcome_totals"."outcome" in ('verified', 'unavailable', 'failed')
            and "encryption_transition_outcome_totals"."reason" in (
              'none', 'client_crypto_unavailable', 'client_custody_unavailable',
              'current_read_authority_unavailable',
              'retained_key_material_unavailable', 'signer_evidence_unavailable',
              'live_shadow_lifecycle_unavailable', 'client_observation_expired',
              'integrity_failure', 'parity_mismatch'
            ))
        )
        and (
          "encryption_transition_outcome_totals"."reason" not in (
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable'
          ) or "encryption_transition_outcome_totals"."operation" = 'read'
        ));--> statement-breakpoint
CREATE POLICY "encryption_transition_history_read_admissions_product_all" ON "encryption_transition_history_read_admissions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M275_HISTORY_READ_OBSERVATIONS
ALTER TABLE "encryption_transition_history_read_admissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "encryption_transition_history_read_admissions"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "encryption_transition_history_read_admissions"
  TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_encryption_transition_history_read_admission"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'history-read admission time must be monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('consumed', 'expired') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal history-read admission is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state = 'planned' THEN
    IF (to_jsonb(NEW) - ARRAY['token_digest', 'updated_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['token_digest', 'updated_at'])
    THEN
      RAISE EXCEPTION 'planned history-read admission may rotate only its token'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state NOT IN ('consumed', 'expired')
    OR (to_jsonb(NEW) - ARRAY[
      'state', 'consumption_kind', 'acknowledgement_digest',
      'ordered_result_set_digest', 'verified_count',
      'client_crypto_unavailable_count',
      'client_custody_unavailable_count',
      'current_read_authority_unavailable_count',
      'retained_key_material_unavailable_count',
      'signer_evidence_unavailable_count',
      'live_shadow_lifecycle_unavailable_count',
      'integrity_failure_count', 'parity_mismatch_count',
      'client_observation_expired_count', 'terminal_at', 'updated_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'state', 'consumption_kind', 'acknowledgement_digest',
      'ordered_result_set_digest', 'verified_count',
      'client_crypto_unavailable_count',
      'client_custody_unavailable_count',
      'current_read_authority_unavailable_count',
      'retained_key_material_unavailable_count',
      'signer_evidence_unavailable_count',
      'live_shadow_lifecycle_unavailable_count',
      'integrity_failure_count', 'parity_mismatch_count',
      'client_observation_expired_count', 'terminal_at', 'updated_at'
    ])
  THEN
    RAISE EXCEPTION 'history-read admission identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_encryption_transition_history_read_admission"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."protect_encryption_transition_history_read_admission"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "encryption_transition_history_read_admissions_monotonic"
BEFORE UPDATE ON "encryption_transition_history_read_admissions"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_encryption_transition_history_read_admission"();
