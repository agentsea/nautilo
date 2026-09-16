ALTER TABLE "memories" ADD CONSTRAINT "memories_protected_mapping_clears_confidential_columns" CHECK ((
        "memories"."crypto_object_id" is null
      ) or (
        "memories"."content" = ''
        and "memories"."type" = '__nautilo_encrypted_memory_v1__'
      ));