-- M314_PUBLIC_ROOM_MESSAGE_AUTHORITY
CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
    JOIN "public"."rooms" AS source_room ON source_room.id = NEW.room_id
    JOIN "public"."rooms" AS authority_room
      ON authority_room.id = COALESCE(source_room.parent_room_id, source_room.id)
     AND authority_room.namespace_id = source_room.namespace_id
     AND authority_room.parent_room_id IS NULL
    JOIN "public"."room_members" AS member ON member.room_id = authority_room.id
    JOIN "public"."actors" AS agent_actor
      ON agent_actor.id = member.actor_id
     AND agent_actor.kind = 'agent'
     AND agent_actor.agent_id = NEW.agent_id
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
     AND session_row.agent_id = NEW.agent_id
     AND source_room.archived_at IS NULL
     AND authority_room.archived_at IS NULL
     AND ((source_room.parent_room_id IS NULL
            AND source_room.kind IN ('private', 'group', 'open'))
       OR (source_room.parent_room_id IS NOT NULL
            AND source_room.kind = 'subthread'
            AND authority_room.kind IN ('private', 'group', 'open')))
   FOR SHARE OF session_row, source_room, authority_room, member, agent_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent execution Session/Room/Agent mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.invocation_id IS NOT NULL THEN
    PERFORM 1
      FROM "public"."conversation_shared_agent_shadow_invocations" AS invocation
     WHERE invocation.invocation_id = NEW.invocation_id
       AND invocation.room_id = NEW.room_id
       AND invocation.invoking_human_id = NEW.invoking_human_id
       AND invocation.invoking_device_id = NEW.invoking_device_id
       AND invocation.authorization_device_id = NEW.authorization_device_id
       AND invocation.client_action_session_id = NEW.client_action_session_id
       AND invocation.policy_revision = NEW.policy_revision
       AND invocation.input_count = NEW.input_count
       AND invocation.input_set_digest = NEW.input_set_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shared-Agent execution Runtime invocation mismatch'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
