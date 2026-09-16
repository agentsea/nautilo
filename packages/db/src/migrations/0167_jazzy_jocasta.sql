CREATE TABLE "invite_redemptions" (
	"invite_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"bound_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "invite_redemptions_invite_id_user_id_pk" PRIMARY KEY("invite_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD CONSTRAINT "invite_redemptions_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD CONSTRAINT "invite_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invite_redemptions_user_id" ON "invite_redemptions" USING btree ("user_id");
--> statement-breakpoint
INSERT INTO "invite_redemptions" ("invite_id", "user_id", "bound_at", "completed_at")
SELECT
	"id",
	"half_redeemed_user_id",
	COALESCE("half_redeemed_at", "created_at"),
	CASE
		WHEN "half_redeemed_at" IS NULL AND "used_count" > 0 THEN "created_at"
		ELSE NULL
	END
FROM "invites"
WHERE "half_redeemed_user_id" IS NOT NULL
ON CONFLICT ("invite_id", "user_id") DO NOTHING;
