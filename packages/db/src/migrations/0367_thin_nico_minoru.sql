ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_terminal_reason";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_terminal_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_terminal_reason" CHECK ("background_crypto_authorization_requests"."terminal_reason" is null or "background_crypto_authorization_requests"."terminal_reason" in (
        'malformed_request',
        'integrity_failure',
        'provider_outcome_unknown',
        'policy_rejected',
        'unsupported_subject',
        'retry_limit_exhausted',
        'recipient_generation_exhausted',
        'cancelled',
        'superseded'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_terminal_coherent" CHECK ((
        "background_crypto_authorization_requests"."state" = 'cancelled'
        and "background_crypto_authorization_requests"."terminal_reason" in ('cancelled', 'superseded')
        and "background_crypto_authorization_requests"."finished_at" is not null
      ) or (
        "background_crypto_authorization_requests"."state" = 'terminal_failure'
        and "background_crypto_authorization_requests"."terminal_reason" in (
          'malformed_request',
          'integrity_failure',
        'provider_outcome_unknown',
          'policy_rejected',
          'unsupported_subject',
          'retry_limit_exhausted',
          'recipient_generation_exhausted'
        )
        and "background_crypto_authorization_requests"."finished_at" is not null
      ) or (
        "background_crypto_authorization_requests"."state" = 'completed'
        and "background_crypto_authorization_requests"."terminal_reason" is null
        and "background_crypto_authorization_requests"."finished_at" is not null
      ) or (
        "background_crypto_authorization_requests"."state" not in (
          'completed',
          'cancelled',
          'terminal_failure'
        )
        and "background_crypto_authorization_requests"."terminal_reason" is null
        and "background_crypto_authorization_requests"."finished_at" is null
      ));