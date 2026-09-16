CREATE TABLE "encryption_transition_boundary_health" (
	"policy_revision" integer NOT NULL,
	"boundary_id" text NOT NULL,
	"family" text NOT NULL,
	"operation" text NOT NULL,
	"actor_class" text NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"retryable" boolean NOT NULL,
	"occurrence_count" bigint DEFAULT 1 NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_transition_boundary_health_pk" PRIMARY KEY("policy_revision","boundary_id"),
	CONSTRAINT "encryption_transition_boundary_health_shape" CHECK ("encryption_transition_boundary_health"."policy_revision" > 0
        and length("encryption_transition_boundary_health"."boundary_id") between 1 and 256
        and length("encryption_transition_boundary_health"."family") between 1 and 64
        and length("encryption_transition_boundary_health"."operation") between 1 and 64
        and "encryption_transition_boundary_health"."actor_class" in ('human', 'agent', 'conductor', 'tool', 'background')
        and "encryption_transition_boundary_health"."state" in ('verified', 'waiting_for_authority', 'repairing', 'unsupported', 'failed')
        and "encryption_transition_boundary_health"."reason" in (
          'none', 'device_membership_converging',
          'domain_authority_converging', 'namespace_authority_converging',
          'missing_protected_sibling', 'unsupported_operation',
          'device_not_enrolled', 'device_stale', 'device_removed',
          'recovery_required', 'authority_unrecoverable',
          'integrity_failure', 'parity_mismatch', 'publication_failure',
          'stale_authority', 'unknown_boundary', 'unknown_result'
        )
        and "encryption_transition_boundary_health"."occurrence_count" > 0
        and "encryption_transition_boundary_health"."last_observed_at" >= "encryption_transition_boundary_health"."first_observed_at"
        and (("encryption_transition_boundary_health"."state" = 'verified') = ("encryption_transition_boundary_health"."reason" = 'none'))
        and ("encryption_transition_boundary_health"."state" not in ('waiting_for_authority', 'repairing') or "encryption_transition_boundary_health"."retryable"))
);
--> statement-breakpoint
ALTER TABLE "encryption_transition_boundary_health" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_encryption_transition_boundary_health_latest" ON "encryption_transition_boundary_health" USING btree ("policy_revision","last_observed_at");--> statement-breakpoint
CREATE POLICY "encryption_transition_boundary_health_product_all" ON "encryption_transition_boundary_health" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);