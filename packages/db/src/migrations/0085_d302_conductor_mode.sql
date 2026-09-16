ALTER TABLE "rooms" ADD COLUMN "conductor_mode" text DEFAULT 'advanced' NOT NULL;
--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_conductor_mode_check" CHECK ("rooms"."conductor_mode" IN ('advanced', 'standard'));