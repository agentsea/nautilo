CREATE TYPE "public"."content_report_reason" AS ENUM('abuse_hate_harassment', 'sexual_exploitative', 'violence_threats', 'spam_scam', 'other');--> statement-breakpoint
CREATE TYPE "public"."content_report_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."content_report_target_type" AS ENUM('message', 'person');--> statement-breakpoint
ALTER TABLE "content_reports" DROP CONSTRAINT "content_reports_target_check";--> statement-breakpoint
ALTER TABLE "content_reports" DROP CONSTRAINT "content_reports_reason_check";--> statement-breakpoint
ALTER TABLE "content_reports" DROP CONSTRAINT "content_reports_status_check";--> statement-breakpoint
ALTER TABLE "content_reports" DROP CONSTRAINT "content_reports_close_state_check";--> statement-breakpoint
ALTER TABLE "content_reports" ALTER COLUMN "target_type" SET DATA TYPE "public"."content_report_target_type" USING "target_type"::"public"."content_report_target_type";--> statement-breakpoint
ALTER TABLE "content_reports" ALTER COLUMN "reason" SET DATA TYPE "public"."content_report_reason" USING "reason"::"public"."content_report_reason";--> statement-breakpoint
ALTER TABLE "content_reports" ALTER COLUMN "status" SET DEFAULT 'open'::"public"."content_report_status";--> statement-breakpoint
ALTER TABLE "content_reports" ALTER COLUMN "status" SET DATA TYPE "public"."content_report_status" USING "status"::"public"."content_report_status";