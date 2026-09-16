ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_unique" ON "users" ("external_id") WHERE "external_id" IS NOT NULL;