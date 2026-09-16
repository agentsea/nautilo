ALTER TABLE "memories" ADD COLUMN "creation_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memories_creation_key" ON "memories" USING btree ("creation_key");