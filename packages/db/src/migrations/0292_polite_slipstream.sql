ALTER TABLE "media_generations" DROP CONSTRAINT "media_generations_request_payload_shape";--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_request_payload_shape" CHECK (
      jsonb_typeof("media_generations"."request_payload") = 'object'
      and "media_generations"."request_payload" ?& array['version', 'model', 'prompt', 'normalizedSettings']
      and "media_generations"."request_payload" - 'version' - 'model' - 'prompt' - 'lyrics' - 'referenceImages' - 'referenceVideos' - 'referenceAudios' - 'normalizedSettings' = '{}'::jsonb
      and "media_generations"."request_payload"->>'version' = '1'
      and jsonb_typeof("media_generations"."request_payload"->'model') = 'string'
      and "media_generations"."request_payload"->>'model' = "media_generations"."provider_model"
      and "media_generations"."request_payload"->>'model' ~ '^[A-Za-z0-9._:+-]+$'
      and jsonb_typeof("media_generations"."request_payload"->'prompt') = 'string'
      and (not ("media_generations"."request_payload" ? 'lyrics') or jsonb_typeof("media_generations"."request_payload"->'lyrics') = 'string')
      and (not ("media_generations"."request_payload" ? 'referenceImages') or (
        jsonb_typeof("media_generations"."request_payload"->'referenceImages') = 'array'
        and jsonb_array_length("media_generations"."request_payload"->'referenceImages') between 0 and 30
      ))
      and (not ("media_generations"."request_payload" ? 'referenceVideos') or (
        jsonb_typeof("media_generations"."request_payload"->'referenceVideos') = 'array'
        and jsonb_array_length("media_generations"."request_payload"->'referenceVideos') between 0 and 10
      ))
      and (not ("media_generations"."request_payload" ? 'referenceAudios') or (
        jsonb_typeof("media_generations"."request_payload"->'referenceAudios') = 'array'
        and jsonb_array_length("media_generations"."request_payload"->'referenceAudios') between 0 and 10
      ))
      and jsonb_typeof("media_generations"."request_payload"->'normalizedSettings') = 'object'
      and ("media_generations"."request_payload"->'normalizedSettings') - 'durationSeconds' - 'resolution' - 'aspectRatio' - 'audioEnabled' - 'instrumental' = '{}'::jsonb
      and (not ("media_generations"."request_payload"->'normalizedSettings' ? 'durationSeconds') or (jsonb_typeof("media_generations"."request_payload"->'normalizedSettings'->'durationSeconds') = 'number' and ("media_generations"."request_payload"->'normalizedSettings'->>'durationSeconds')::numeric > 0))
      and (not ("media_generations"."request_payload"->'normalizedSettings' ? 'resolution') or (jsonb_typeof("media_generations"."request_payload"->'normalizedSettings'->'resolution') = 'string' and "media_generations"."request_payload"->'normalizedSettings'->>'resolution' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
      and (not ("media_generations"."request_payload"->'normalizedSettings' ? 'aspectRatio') or (jsonb_typeof("media_generations"."request_payload"->'normalizedSettings'->'aspectRatio') = 'string' and "media_generations"."request_payload"->'normalizedSettings'->>'aspectRatio' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
      and (not ("media_generations"."request_payload"->'normalizedSettings' ? 'audioEnabled') or jsonb_typeof("media_generations"."request_payload"->'normalizedSettings'->'audioEnabled') = 'boolean')
      and (not ("media_generations"."request_payload"->'normalizedSettings' ? 'instrumental') or jsonb_typeof("media_generations"."request_payload"->'normalizedSettings'->'instrumental') = 'boolean')
      and "media_generations"."request_payload"->'normalizedSettings' = "media_generations"."safe_snapshot"->'normalizedSettings'
    );