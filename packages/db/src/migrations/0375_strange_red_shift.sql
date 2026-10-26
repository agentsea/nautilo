CREATE TABLE "foreground_memory_crypto_publication_receipts" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"crypto_object_id" text NOT NULL,
	"memory_id" uuid NOT NULL,
	"content_revision" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"reservation_digest" "bytea" NOT NULL,
	"required_namespace_fingerprint" "bytea" NOT NULL,
	"genesis_manifest_hash" "bytea" NOT NULL,
	"staged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_foreground_memory_publication_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "foreground_memory_publication_operation_portable" CHECK ("foreground_memory_crypto_publication_receipts"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "foreground_memory_publication_object_shape" CHECK ("foreground_memory_crypto_publication_receipts"."crypto_object_id" ~ '^memory:v1:[0-9a-f]{64}$'),
	CONSTRAINT "foreground_memory_publication_revision_positive" CHECK ("foreground_memory_crypto_publication_receipts"."content_revision" > 0),
	CONSTRAINT "foreground_memory_publication_digest_sizes" CHECK (octet_length("foreground_memory_crypto_publication_receipts"."reservation_digest") = 32
        and octet_length("foreground_memory_crypto_publication_receipts"."required_namespace_fingerprint") = 32
        and octet_length("foreground_memory_crypto_publication_receipts"."genesis_manifest_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "foreground_memory_crypto_publication_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "foreground_memory_crypto_publication_receipts" ADD CONSTRAINT "foreground_memory_publication_object_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "foreground_memory_publication_crypto_select" ON "foreground_memory_crypto_publication_receipts" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "foreground_memory_publication_crypto_insert" ON "foreground_memory_crypto_publication_receipts" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);
--> statement-breakpoint
-- FOREGROUND_MEMORY_CRYPTO_PUBLICATION_AUTHORITY
ALTER TABLE "foreground_memory_crypto_publication_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "foreground_memory_crypto_publication_receipts" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "foreground_memory_crypto_publication_receipts" TO "nautilo_crypto";
--> statement-breakpoint
CREATE FUNCTION "public"."reject_foreground_memory_publication_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Foreground Memory publication receipt is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_foreground_memory_publication_update"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "foreground_memory_publication_immutable" BEFORE UPDATE ON "foreground_memory_crypto_publication_receipts" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_foreground_memory_publication_update"();
