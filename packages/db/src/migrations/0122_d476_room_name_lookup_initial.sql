CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "normalized_label" text GENERATED ALWAYS AS (btrim(regexp_replace(lower(normalize(label, NFKC)), '[[:space:][:punct:]]+', ' ', 'g'))) STORED;--> statement-breakpoint
CREATE INDEX "idx_rooms_normalized_label_live" ON "rooms" USING btree ("normalized_label") WHERE "rooms"."archived_at" IS NULL AND "rooms"."kind" NOT IN ('task', 'access', 'subthread');--> statement-breakpoint
CREATE INDEX "idx_rooms_normalized_label_trgm_live" ON "rooms" USING gin ("normalized_label" gin_trgm_ops) WHERE "rooms"."archived_at" IS NULL AND "rooms"."kind" NOT IN ('task', 'access', 'subthread');
