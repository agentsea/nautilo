ALTER TABLE "conversation_shared_agent_shadow_operations" DROP CONSTRAINT "conversation_shared_agent_shadow_operations_coordinates";--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_operations" ADD COLUMN "participant_human_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_operations" ADD COLUMN "protected_participant_human_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_operations" ADD COLUMN "plaintext_participant_human_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_operations" ADD COLUMN "protected_recipient_device_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_operations" ADD CONSTRAINT "conversation_shared_agent_shadow_operations_coordinates" CHECK ("conversation_shared_agent_shadow_operations"."policy_revision" > 0
        and "conversation_shared_agent_shadow_operations"."human_message_id" > 0
        and "conversation_shared_agent_shadow_operations"."transcript_ordinal" > 0
        and "conversation_shared_agent_shadow_operations"."committer_device_signing_key_generation" >= 0
        and "conversation_shared_agent_shadow_operations"."host_authorization_revision" >= 0
        and "conversation_shared_agent_shadow_operations"."namespace_access_revision" >= 0
        and "conversation_shared_agent_shadow_operations"."namespace_key_generation" >= 0
        and "conversation_shared_agent_shadow_operations"."participant_human_count" >= 2
        and "conversation_shared_agent_shadow_operations"."protected_participant_human_count" >= 1
        and "conversation_shared_agent_shadow_operations"."protected_participant_human_count"
          <= "conversation_shared_agent_shadow_operations"."participant_human_count"
        and "conversation_shared_agent_shadow_operations"."plaintext_participant_human_count"
          = "conversation_shared_agent_shadow_operations"."participant_human_count"
            - "conversation_shared_agent_shadow_operations"."protected_participant_human_count"
        and "conversation_shared_agent_shadow_operations"."protected_recipient_device_count"
          >= "conversation_shared_agent_shadow_operations"."protected_participant_human_count"
        and "conversation_shared_agent_shadow_operations"."reconciliation_attempt_count" between 0 and 8);