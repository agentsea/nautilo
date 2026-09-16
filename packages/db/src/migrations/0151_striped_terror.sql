CREATE TABLE "background_crypto_authorization_domain_requirements" (
	"request_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"expected_epoch" bigint NOT NULL,
	"expected_agent_authorization_revision" bigint NOT NULL,
	CONSTRAINT "pk_bg_crypto_auth_domain_req" PRIMARY KEY("request_id","domain_id"),
	CONSTRAINT "uq_bg_crypto_auth_domain_req_ordinal" UNIQUE("request_id","ordinal"),
	CONSTRAINT "bg_crypto_auth_domain_req_request_id_portable" CHECK (octet_length("background_crypto_authorization_domain_requirements"."request_id") between 1
      and 128
      and "background_crypto_authorization_domain_requirements"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "bg_crypto_auth_domain_req_domain_id_portable" CHECK (octet_length("background_crypto_authorization_domain_requirements"."domain_id") between 1
      and 128
      and "background_crypto_authorization_domain_requirements"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "bg_crypto_auth_domain_req_ordinal_range" CHECK ("background_crypto_authorization_domain_requirements"."ordinal" between 0
      and 255),
	CONSTRAINT "bg_crypto_auth_domain_req_epoch_safe" CHECK ("background_crypto_authorization_domain_requirements"."expected_epoch" between 0 and 9007199254740991),
	CONSTRAINT "bg_crypto_auth_domain_req_agent_revision_safe" CHECK ("background_crypto_authorization_domain_requirements"."expected_agent_authorization_revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_domain_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "background_crypto_authorization_namespace_requirements" (
	"request_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"domain_id" text NOT NULL,
	"operation_mask" smallint NOT NULL,
	"expected_access_revision" bigint NOT NULL,
	"expected_policy_revision" bigint NOT NULL,
	CONSTRAINT "pk_bg_crypto_auth_ns_req" PRIMARY KEY("request_id","namespace_id"),
	CONSTRAINT "uq_bg_crypto_auth_ns_req_ordinal" UNIQUE("request_id","ordinal"),
	CONSTRAINT "bg_crypto_auth_ns_req_request_id_portable" CHECK (octet_length("background_crypto_authorization_namespace_requirements"."request_id") between 1
      and 128
      and "background_crypto_authorization_namespace_requirements"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "bg_crypto_auth_ns_req_namespace_id_portable" CHECK (octet_length("background_crypto_authorization_namespace_requirements"."namespace_id") between 1
      and 128
      and "background_crypto_authorization_namespace_requirements"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "bg_crypto_auth_ns_req_ordinal_range" CHECK ("background_crypto_authorization_namespace_requirements"."ordinal" between 0
      and 255),
	CONSTRAINT "bg_crypto_auth_ns_req_domain_id_portable" CHECK (octet_length("background_crypto_authorization_namespace_requirements"."domain_id") between 1
      and 128
      and "background_crypto_authorization_namespace_requirements"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "bg_crypto_auth_ns_req_operation_mask" CHECK ("background_crypto_authorization_namespace_requirements"."operation_mask" between 1 and 3),
	CONSTRAINT "bg_crypto_auth_ns_req_access_revision_safe" CHECK ("background_crypto_authorization_namespace_requirements"."expected_access_revision" between 0 and 9007199254740991),
	CONSTRAINT "bg_crypto_auth_ns_req_policy_revision_safe" CHECK ("background_crypto_authorization_namespace_requirements"."expected_policy_revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_namespace_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_format_version";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_format_version" CHECK ("background_crypto_authorization_requests"."format_version" = 1 or (
        "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      ));--> statement-breakpoint
CREATE POLICY "bg_crypto_auth_domain_req_crypto_sel" ON "background_crypto_authorization_domain_requirements" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "bg_crypto_auth_domain_req_crypto_ins" ON "background_crypto_authorization_domain_requirements" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "bg_crypto_auth_domain_req_crypto_del" ON "background_crypto_authorization_domain_requirements" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "bg_crypto_auth_ns_req_crypto_sel" ON "background_crypto_authorization_namespace_requirements" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "bg_crypto_auth_ns_req_crypto_ins" ON "background_crypto_authorization_namespace_requirements" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "bg_crypto_auth_ns_req_crypto_del" ON "background_crypto_authorization_namespace_requirements" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);
--> statement-breakpoint
-- M244_BACKGROUND_AUTHORITY_SETS
ALTER TABLE "background_crypto_authorization_domain_requirements"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_namespace_requirements"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements"
FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements"
TO "nautilo_crypto";
