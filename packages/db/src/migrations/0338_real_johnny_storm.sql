ALTER TABLE "media_generations" DROP CONSTRAINT "media_generations_provider_fixed";--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "funding_binding" jsonb;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "actual_usd_micros" bigint;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_provider_shape" CHECK (
      "media_generations"."provider" in ('venice', 'surplus')
      and octet_length("media_generations"."provider_model") between 1 and 256
      and octet_length("media_generations"."provider_account_fingerprint") between 16 and 128
      and (("media_generations"."funding_binding" is null and "media_generations"."provider" = 'venice') or coalesce((
        jsonb_typeof("media_generations"."funding_binding") = 'object'
        and "media_generations"."funding_binding" ?& array['humanUserId', 'provider', 'binding', 'credentialFingerprint']
        and "media_generations"."funding_binding" - 'humanUserId' - 'provider' - 'binding' - 'credentialFingerprint' = '{}'::jsonb
        and ("media_generations"."owner_id" is null or "media_generations"."funding_binding"->>'humanUserId' = "media_generations"."owner_id"::text)
        and "media_generations"."funding_binding"->>'provider' = "media_generations"."provider"
        and "media_generations"."funding_binding"->>'credentialFingerprint' = "media_generations"."provider_account_fingerprint"
        and jsonb_typeof("media_generations"."funding_binding"->'binding') = 'object'
        and "media_generations"."funding_binding"->'binding'->>'providerRoute' = "media_generations"."provider"
        and (
          ("media_generations"."funding_binding"->'binding'->>'kind' = 'server'
            and ("media_generations"."funding_binding"->'binding') - 'kind' - 'providerRoute' = '{}'::jsonb)
          or
          ("media_generations"."funding_binding"->'binding'->>'kind' = 'personal'
            and ("media_generations"."funding_binding"->'binding') ?& array['credentialId', 'credentialRevision']
            and ("media_generations"."funding_binding"->'binding') - 'kind' - 'providerRoute' - 'credentialId' - 'credentialRevision' = '{}'::jsonb
            and jsonb_typeof("media_generations"."funding_binding"->'binding'->'credentialRevision') = 'number'
            and ("media_generations"."funding_binding"->'binding'->>'credentialRevision')::numeric >= 1)
        )
      ), false))
    );--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_actual_cost_nonnegative" CHECK ("media_generations"."actual_usd_micros" is null or "media_generations"."actual_usd_micros" >= 0);