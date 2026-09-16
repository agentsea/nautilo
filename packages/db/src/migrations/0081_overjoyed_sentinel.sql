ALTER TABLE "agents" ADD COLUMN "handle_customized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "display_name";