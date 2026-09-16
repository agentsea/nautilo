ALTER TABLE "media_generations" DROP CONSTRAINT "media_generations_safe_json";--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_safe_json" CHECK (jsonb_typeof("safe_snapshot") = 'object'
  and "safe_snapshot" ?& array['version', 'normalizedSettings', 'inputSummary']
  and "safe_snapshot" - 'version' - 'normalizedSettings' - 'inputSummary' = '{}'::jsonb
  and "safe_snapshot"->>'version' = '1'
  and jsonb_typeof("safe_snapshot"->'normalizedSettings') = 'object'
  and ("safe_snapshot"->'normalizedSettings') - 'durationSeconds' - 'resolution' - 'aspectRatio' - 'audioEnabled' - 'instrumental' = '{}'::jsonb
  and (not ("safe_snapshot"->'normalizedSettings' ? 'durationSeconds') or (jsonb_typeof("safe_snapshot"->'normalizedSettings'->'durationSeconds') = 'number' and ("safe_snapshot"->'normalizedSettings'->>'durationSeconds')::numeric > 0))
  and (not ("safe_snapshot"->'normalizedSettings' ? 'resolution') or (jsonb_typeof("safe_snapshot"->'normalizedSettings'->'resolution') = 'string' and "safe_snapshot"->'normalizedSettings'->>'resolution' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
  and (not ("safe_snapshot"->'normalizedSettings' ? 'aspectRatio') or (jsonb_typeof("safe_snapshot"->'normalizedSettings'->'aspectRatio') = 'string' and "safe_snapshot"->'normalizedSettings'->>'aspectRatio' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
  and (not ("safe_snapshot"->'normalizedSettings' ? 'audioEnabled') or jsonb_typeof("safe_snapshot"->'normalizedSettings'->'audioEnabled') = 'boolean')
  and (not ("safe_snapshot"->'normalizedSettings' ? 'instrumental') or jsonb_typeof("safe_snapshot"->'normalizedSettings'->'instrumental') = 'boolean')
  and jsonb_typeof("safe_snapshot"->'inputSummary') = 'object'
  and "safe_snapshot"->'inputSummary' ? 'promptCharacters'
  and ("safe_snapshot"->'inputSummary') - 'promptCharacters' - 'lyricsCharacters' - 'referenceImageCount' = '{}'::jsonb
  and jsonb_typeof("safe_snapshot"->'inputSummary'->'promptCharacters') = 'number'
  and ("safe_snapshot"->'inputSummary'->>'promptCharacters')::numeric >= 0
  and (not ("safe_snapshot"->'inputSummary' ? 'lyricsCharacters') or (jsonb_typeof("safe_snapshot"->'inputSummary'->'lyricsCharacters') = 'number' and ("safe_snapshot"->'inputSummary'->>'lyricsCharacters')::numeric >= 0))
  and (not ("safe_snapshot"->'inputSummary' ? 'referenceImageCount') or (jsonb_typeof("safe_snapshot"->'inputSummary'->'referenceImageCount') = 'number' and ("safe_snapshot"->'inputSummary'->>'referenceImageCount')::numeric between 1 and 30))
  and ("safe_failure" is null or not ("safe_failure" ?| array['raw', 'body', 'prompt', 'lyrics', 'download_url', 'signed_url', 'api_key', 'authorization'])));--> statement-breakpoint
ALTER TABLE "media_generations" DROP CONSTRAINT "media_generations_request_payload_shape";--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_request_payload_shape" CHECK (jsonb_typeof("request_payload") = 'object'
  and "request_payload" ?& array['version', 'model', 'prompt', 'normalizedSettings']
  and "request_payload" - 'version' - 'model' - 'prompt' - 'lyrics' - 'referenceImages' - 'normalizedSettings' = '{}'::jsonb
  and "request_payload"->>'version' = '1'
  and jsonb_typeof("request_payload"->'model') = 'string'
  and "request_payload"->>'model' = "provider_model"
  and "request_payload"->>'model' ~ '^[A-Za-z0-9._:+-]+$'
  and jsonb_typeof("request_payload"->'prompt') = 'string'
  and (not ("request_payload" ? 'lyrics') or jsonb_typeof("request_payload"->'lyrics') = 'string')
  and (not ("request_payload" ? 'referenceImages') or (jsonb_typeof("request_payload"->'referenceImages') = 'array' and jsonb_array_length("request_payload"->'referenceImages') between 1 and 30))
  and jsonb_typeof("request_payload"->'normalizedSettings') = 'object'
  and ("request_payload"->'normalizedSettings') - 'durationSeconds' - 'resolution' - 'aspectRatio' - 'audioEnabled' - 'instrumental' = '{}'::jsonb
  and (not ("request_payload"->'normalizedSettings' ? 'durationSeconds') or (jsonb_typeof("request_payload"->'normalizedSettings'->'durationSeconds') = 'number' and ("request_payload"->'normalizedSettings'->>'durationSeconds')::numeric > 0))
  and (not ("request_payload"->'normalizedSettings' ? 'resolution') or (jsonb_typeof("request_payload"->'normalizedSettings'->'resolution') = 'string' and "request_payload"->'normalizedSettings'->>'resolution' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
  and (not ("request_payload"->'normalizedSettings' ? 'aspectRatio') or (jsonb_typeof("request_payload"->'normalizedSettings'->'aspectRatio') = 'string' and "request_payload"->'normalizedSettings'->>'aspectRatio' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
  and (not ("request_payload"->'normalizedSettings' ? 'audioEnabled') or jsonb_typeof("request_payload"->'normalizedSettings'->'audioEnabled') = 'boolean')
  and (not ("request_payload"->'normalizedSettings' ? 'instrumental') or jsonb_typeof("request_payload"->'normalizedSettings'->'instrumental') = 'boolean')
  and "request_payload"->'normalizedSettings' = "safe_snapshot"->'normalizedSettings');
