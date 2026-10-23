ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent" CHECK ((
        ("background_crypto_authorization_requests"."work_kind" like 'stenographer.%' and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
          or "background_crypto_authorization_requests"."work_kind" like 'reflection.%' and "background_crypto_authorization_requests"."processor_kind" = 'reflection')
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ) or (
        "background_crypto_authorization_requests"."work_kind" not like 'stenographer.%'
        and "background_crypto_authorization_requests"."work_kind" not like 'reflection.%'
        and ("background_crypto_authorization_requests"."work_kind" not like 'task.%'
          or "background_crypto_authorization_requests"."format_version" in (1, 2))
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      ) or (
        "background_crypto_authorization_requests"."work_kind" in (
          'task.dispatch',
          'task.execute',
          'task.await_reply_resume',
          'task.approval_resume'
        )
        and "background_crypto_authorization_requests"."purpose" = "background_crypto_authorization_requests"."work_kind"
        and "background_crypto_authorization_requests"."format_version" = 3
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'runtime'
      ));