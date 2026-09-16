CREATE TABLE "ordinary_request_admissions" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"controller_installation_id" uuid NOT NULL,
	"installation_generation" integer NOT NULL,
	"body_sha256" varchar(64) NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ordinary_request_admissions_generation_positive" CHECK ("ordinary_request_admissions"."installation_generation" > 0),
	CONSTRAINT "ordinary_request_admissions_body_digest_canonical" CHECK ("ordinary_request_admissions"."body_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ordinary_request_admissions" ADD CONSTRAINT "ordinary_request_admissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordinary_request_admissions" ADD CONSTRAINT "ordinary_request_admissions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordinary_request_admissions" ADD CONSTRAINT "ordinary_request_admissions_controller_installation_id_remote_controller_installations_id_fk" FOREIGN KEY ("controller_installation_id") REFERENCES "public"."remote_controller_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ordinary_request_admissions_expiry" ON "ordinary_request_admissions" USING btree ("expires_at");