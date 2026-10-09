ALTER TABLE "protected_task_continuation_receipts" DROP CONSTRAINT "protected_task_continuation_receipts_shape_coherent";--> statement-breakpoint
ALTER TABLE "protected_task_continuation_receipts" ADD CONSTRAINT "protected_task_continuation_receipts_shape_coherent" CHECK ((
        "protected_task_continuation_receipts"."kind" = 'checkpoint_safe_v1'
        and "protected_task_continuation_receipts"."reason" in ('manual_pause', 'time_limit', 'grant_refresh')
        and "protected_task_continuation_receipts"."effect_disposition" = 'none_v1'
        and "protected_task_continuation_receipts"."interrupt_id" is null
        and "protected_task_continuation_receipts"."operation_id" is null
        and "protected_task_continuation_receipts"."request_digest" is null
        and "protected_task_continuation_receipts"."required_authority_digest" is null
        and "protected_task_continuation_receipts"."semantic_authority_requirements" is null
      ) or (
        "protected_task_continuation_receipts"."kind" = 'pre_effect_interrupt_v1'
        and "protected_task_continuation_receipts"."reason" in ('grant_refresh', 'additional_authority')
        and "protected_task_continuation_receipts"."effect_disposition" = 'not_started_v1'
        and "protected_task_continuation_receipts"."interrupt_id" is not null
        and "protected_task_continuation_receipts"."interrupt_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "protected_task_continuation_receipts"."operation_id" is not null
        and "protected_task_continuation_receipts"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and "protected_task_continuation_receipts"."request_digest" is not null
        and octet_length("protected_task_continuation_receipts"."request_digest") = 32
        and "protected_task_continuation_receipts"."required_authority_digest" is not null
        and octet_length("protected_task_continuation_receipts"."required_authority_digest") = 32
        and (
          "protected_task_continuation_receipts"."reason" = 'grant_refresh'
          and "protected_task_continuation_receipts"."semantic_authority_requirements" is null
          or "protected_task_continuation_receipts"."reason" = 'additional_authority'
          and (
            "protected_task_continuation_receipts"."semantic_authority_requirements" is null
            or jsonb_typeof("protected_task_continuation_receipts"."semantic_authority_requirements") = 'array'
          )
        )
      ));