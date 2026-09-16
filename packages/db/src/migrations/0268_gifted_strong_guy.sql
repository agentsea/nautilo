ALTER TABLE "memories" DROP CONSTRAINT "memories_embedding_provenance_coherent";--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_embedding_provenance_coherent" CHECK ((
        "memories"."embedding_revision" is null
        and "memories"."embedding_provider" is null
        and "memories"."embedding_model" is null
        and "memories"."embedding_dimensions" is null
        and "memories"."embedding_contract_version" is null
      ) or (
        "memories"."embedding" is not null
        and "memories"."embedding_revision" is not null
        and "memories"."embedding_revision" >= 0
        and "memories"."embedding_revision" <= "memories"."content_revision"
        and "memories"."embedding_provider" in ('openai', 'openrouter', 'venice')
        and octet_length("memories"."embedding_model") between 1 and 256
        and "memories"."embedding_dimensions" = 1536
        and "memories"."embedding_contract_version" = 1
      ));