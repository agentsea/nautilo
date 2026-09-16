ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_kind";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_purpose";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_kind" CHECK ("background_crypto_authorization_requests"."work_kind" in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'stenographer.publication_reconcile',
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
      ) or "background_crypto_authorization_requests"."work_kind" = "background_crypto_authorization_requests"."purpose");