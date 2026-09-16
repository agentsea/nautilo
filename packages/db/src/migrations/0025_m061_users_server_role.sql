ALTER TABLE "users" ADD COLUMN "server_role" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_server_role_check" CHECK ("server_role" IN ('admin', 'user'));
--> statement-breakpoint
UPDATE "users" SET "server_role" = 'admin' WHERE "server" IS NULL;
