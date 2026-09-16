ALTER TABLE "profiles" ALTER COLUMN "name" SET DEFAULT 'Nautilo';--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "onboarding_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "welcome_message_sent" boolean DEFAULT false NOT NULL;