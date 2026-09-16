CREATE TABLE "mobile_user_agreement_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agreement_version" varchar(96) NOT NULL,
	"policy_version" varchar(96) NOT NULL,
	"recipient_manifest_version" varchar(96) NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mobile_user_agreement_acceptances" ADD CONSTRAINT "mobile_user_agreement_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mobile_agreement_active_user" ON "mobile_user_agreement_acceptances" USING btree ("user_id") WHERE "mobile_user_agreement_acceptances"."withdrawn_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_mobile_agreement_user_time" ON "mobile_user_agreement_acceptances" USING btree ("user_id","accepted_at");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    REVOKE ALL ON TABLE public.mobile_user_agreement_acceptances FROM nautilo_agent;
  END IF;
END $$;
