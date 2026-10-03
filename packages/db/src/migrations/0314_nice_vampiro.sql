CREATE TABLE "server_public_join" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"invite_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_public_join_singleton" CHECK ("server_public_join"."singleton"),
	CONSTRAINT "server_public_join_revision" CHECK ("server_public_join"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "server_public_join" ADD CONSTRAINT "server_public_join_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_public_join" ADD CONSTRAINT "server_public_join_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invites_token" ON "invites" USING btree ("token");--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_token_present" CHECK ("invites"."token" IS NOT NULL OR "invites"."token_hash" IS NOT NULL);