ALTER TABLE "room_journal_crypto_publications" DROP CONSTRAINT "room_journal_crypto_publications_attachment_plan";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_kind";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_purpose";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent";--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "extraction_authorization_wait_lane" text;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "extraction_authorization_waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "compaction_authorization_waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_crypto_publications" ADD CONSTRAINT "room_journal_crypto_publications_attachment_plan" CHECK ("room_journal_crypto_publications"."attachment_plan_version" in (1, 2)
        and octet_length("room_journal_crypto_publications"."attachment_plan_hash") = 32
        and octet_length("room_journal_crypto_publications"."attachment_plan_bytes") between 1
          and 131072);--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_extraction_authorization_wait" CHECK ((
      "room_journal_state"."extraction_authorization_wait_lane" IS NULL AND "room_journal_state"."extraction_authorization_waiting_since" IS NULL
    ) OR (
      "room_journal_state"."extraction_authorization_wait_lane" IS NOT NULL
      AND "room_journal_state"."extraction_authorization_wait_lane" IN ('live', 'historical', 'rebuild')
      AND "room_journal_state"."extraction_authorization_waiting_since" IS NOT NULL
    ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_kind" CHECK ("background_crypto_authorization_requests"."work_kind" in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'stenographer.publication_reconcile',
        'stenographer.output_repair',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_purpose" CHECK ("background_crypto_authorization_requests"."purpose" in (
        'journal.extract',
        'journal.compact',
        'journal.rebuild',
        'journal.reconcile',
        'journal.repair',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent" CHECK ((
        "background_crypto_authorization_requests"."work_kind" in (
          'stenographer.extraction',
          'stenographer.historical'
        ) and "background_crypto_authorization_requests"."purpose" = 'journal.extract'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.compaction'
        and "background_crypto_authorization_requests"."purpose" = 'journal.compact'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.rebuild'
        and "background_crypto_authorization_requests"."purpose" = 'journal.rebuild'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.publication_reconcile'
        and "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."purpose" = 'journal.reconcile'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.output_repair'
        and "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."purpose" = 'journal.repair'
      ) or "background_crypto_authorization_requests"."work_kind" = "background_crypto_authorization_requests"."purpose");