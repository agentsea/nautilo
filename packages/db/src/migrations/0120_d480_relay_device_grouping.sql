-- D480 — physical-device grouping is non-authoritative and deliberately
-- nullable for pre-contract/legacy pairings. The management digest is stored
-- alongside its group so grouped lifecycle operations can use a caller-owned
-- indexed opaque target without returning the raw UUID.
ALTER TABLE "relay_tokens" ADD COLUMN "device_group_id" uuid;--> statement-breakpoint
ALTER TABLE "relay_tokens" ADD COLUMN "device_management_id" text;--> statement-breakpoint
ALTER TABLE "relay_tokens" ADD CONSTRAINT "relay_tokens_device_group_management_pair_check" CHECK (("device_group_id" IS NULL AND "device_management_id" IS NULL) OR ("device_group_id" IS NOT NULL AND "device_management_id" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "idx_relay_tokens_user_device_group_active" ON "relay_tokens" USING btree ("user_id","device_group_id") WHERE "relay_tokens"."device_group_id" IS NOT NULL AND "relay_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_relay_tokens_user_device_management_active" ON "relay_tokens" USING btree ("user_id","device_management_id") WHERE "relay_tokens"."device_management_id" IS NOT NULL AND "relay_tokens"."revoked_at" IS NULL;
