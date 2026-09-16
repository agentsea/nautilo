ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_retry_bounds";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_retry_bounds" CHECK ("background_crypto_authorization_requests"."retry_count" between 0 and "background_crypto_authorization_requests"."maximum_attempts"
        and "background_crypto_authorization_requests"."maximum_attempts" = 8
        and (
          "background_crypto_authorization_requests"."retry_count" = 0
          or ("background_crypto_authorization_requests"."retry_count" > 0 and "background_crypto_authorization_requests"."last_retry_reason" is not null)
        ));