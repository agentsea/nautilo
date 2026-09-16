DROP INDEX "idx_rooms_normalized_label_live";--> statement-breakpoint
DROP INDEX "idx_rooms_normalized_label_trgm_live";--> statement-breakpoint
ALTER TABLE "rooms" drop column "normalized_label";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "normalized_label" text GENERATED ALWAYS AS (btrim(regexp_replace(replace(replace(lower(normalize(label, NFKC)), chr(775), ''), 'ς', 'σ'), '[[:space:][:punct:]]+', ' ', 'g'))) STORED;--> statement-breakpoint
CREATE INDEX "idx_rooms_normalized_label_live" ON "rooms" USING btree ("normalized_label" text_pattern_ops,"id") WHERE "rooms"."archived_at" IS NULL AND "rooms"."kind" NOT IN ('task', 'access', 'subthread');--> statement-breakpoint
CREATE INDEX "idx_rooms_normalized_label_trgm_live" ON "rooms" USING gist ("normalized_label" gist_trgm_ops) WHERE "rooms"."archived_at" IS NULL AND "rooms"."kind" NOT IN ('task', 'access', 'subthread');