CREATE TABLE "personal_provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"revision" integer NOT NULL,
	"format_version" integer NOT NULL,
	"key_id" uuid NOT NULL,
	"nonce_base64" text NOT NULL,
	"ciphertext_base64" text NOT NULL,
	"auth_tag_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_provider_credentials_provider_check" CHECK ("personal_provider_credentials"."provider" in ('anthropic', 'openai', 'openrouter', 'google', 'xai', 'fireworks', 'together', 'venice')),
	CONSTRAINT "personal_provider_credentials_revision_check" CHECK ("personal_provider_credentials"."revision" >= 1),
	CONSTRAINT "personal_provider_credentials_format_check" CHECK ("personal_provider_credentials"."format_version" = 1),
	CONSTRAINT "personal_provider_credentials_envelope_nonempty" CHECK (octet_length("personal_provider_credentials"."nonce_base64") > 0 and octet_length("personal_provider_credentials"."ciphertext_base64") > 0 and octet_length("personal_provider_credentials"."auth_tag_base64") > 0)
);
--> statement-breakpoint
ALTER TABLE "personal_provider_credentials" ADD CONSTRAINT "personal_provider_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_personal_provider_credentials_user_provider" ON "personal_provider_credentials" USING btree ("user_id","provider");--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "personal_provider_credentials"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "personal_provider_credentials"
  TO "nautilo";
