ALTER TABLE "file_revisions" ADD COLUMN "authored_by" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD CONSTRAINT "file_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD CONSTRAINT "file_revisions_authored_by_check" CHECK ("file_revisions"."authored_by" IN ('agent','user'));