ALTER TABLE "protected_task_run_output_bindings" DROP CONSTRAINT "protected_task_run_output_bindings_result_identity_shape";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_kind";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_purpose";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent";--> statement-breakpoint
ALTER TABLE "protected_task_run_output_bindings" ADD COLUMN "result_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_task_run_output_bindings" ADD CONSTRAINT "protected_task_run_output_bindings_result_identity_shape" CHECK ("protected_task_run_output_bindings"."binding_id" = 'task-run-output:' || "protected_task_run_output_bindings"."task_run_id"::text
        and (
          ("protected_task_run_output_bindings"."result_revision" = 1
            and "protected_task_run_output_bindings"."result_operation_id" = 'task-run-result:' || "protected_task_run_output_bindings"."task_run_id"::text)
          or ("protected_task_run_output_bindings"."result_revision" = 2
            and "protected_task_run_output_bindings"."result_operation_id" = 'task-run-cancelled-result:' || "protected_task_run_output_bindings"."task_run_id"::text)
        )
        and "protected_task_run_output_bindings"."result_object_id" ~ '^task-run-result:v1:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_kind" CHECK ("background_crypto_authorization_requests"."work_kind" in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'stenographer.publication_reconcile',
        'stenographer.output_repair',
        'reflection.authority_reproject',
        'reflection.publication_reconcile',
        'reflection.search_projection',
        'reflection.organization',
        'reflection.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.await_reply_resume',
        'task.approval_resume',
        'task.cancel_result'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_purpose" CHECK ("background_crypto_authorization_requests"."purpose" in (
        'journal.extract',
        'journal.compact',
        'journal.rebuild',
        'journal.reconcile',
        'journal.repair',
        'record.reproject',
        'record.reconcile',
        'record.search_projection',
        'record.organize',
        'record.dependency_rewrite',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.await_reply_resume',
        'task.approval_resume',
        'task.cancel_result'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent" CHECK ((
        ("background_crypto_authorization_requests"."work_kind" like 'stenographer.%' and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
          or "background_crypto_authorization_requests"."work_kind" like 'reflection.%' and "background_crypto_authorization_requests"."processor_kind" = 'reflection')
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ) or (
        "background_crypto_authorization_requests"."work_kind" not like 'stenographer.%'
        and "background_crypto_authorization_requests"."work_kind" not like 'reflection.%'
        and "background_crypto_authorization_requests"."work_kind" <> 'task.cancel_result'
        and ("background_crypto_authorization_requests"."work_kind" not like 'task.%'
          or "background_crypto_authorization_requests"."format_version" in (1, 2))
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      ) or (
        "background_crypto_authorization_requests"."work_kind" in (
          'task.dispatch',
          'task.execute',
          'task.await_reply_resume',
          'task.approval_resume',
        'task.cancel_result'
        )
        and "background_crypto_authorization_requests"."purpose" = "background_crypto_authorization_requests"."work_kind"
        and "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime'
      ));