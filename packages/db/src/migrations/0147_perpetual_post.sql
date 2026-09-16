ALTER TABLE "mcp_servers" ADD COLUMN "last_check_status" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_check_failure_code" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_check_missing_environment" text[];--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_connected_at" timestamp with time zone;