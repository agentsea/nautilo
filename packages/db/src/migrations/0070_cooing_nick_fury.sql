CREATE TABLE "message_reactions" (
	"message_id" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_actor_id_emoji_pk" PRIMARY KEY("message_id","actor_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_reactions_message" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_message_reactions_actor" ON "message_reactions" USING btree ("actor_id");--> statement-breakpoint
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE message_reactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_agent_in_room(target_room_id uuid, target_agent_id uuid)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT target_agent_id IS NOT NULL
    AND target_room_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM room_members rm
      JOIN actors a ON a.id = rm.actor_id AND a.kind = 'agent'
      WHERE rm.room_id = target_room_id
        AND a.agent_id = target_agent_id
    )
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_agent_in_room(uuid, uuid) TO PUBLIC;
--> statement-breakpoint
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
--> statement-breakpoint
CREATE POLICY message_reactions_select ON message_reactions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      WHERE sm.id = message_reactions.message_id
        AND s.room_id IS NOT NULL
        AND (
          app_caller_in_room(s.room_id)
          OR app_agent_in_room(s.room_id, app_current_agent_id())
        )
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS message_reactions_insert ON message_reactions;
--> statement-breakpoint
CREATE POLICY message_reactions_insert ON message_reactions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM actors a
      WHERE a.id = message_reactions.actor_id
        AND (
          (a.kind = 'user'  AND a.owner_id = app_current_user_id())
          OR (a.kind = 'agent' AND a.agent_id = app_current_agent_id())
        )
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS message_reactions_delete ON message_reactions;
--> statement-breakpoint
CREATE POLICY message_reactions_delete ON message_reactions
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM actors a
      WHERE a.id = message_reactions.actor_id
        AND (
          (a.kind = 'user'  AND a.owner_id = app_current_user_id())
          OR (a.kind = 'agent' AND a.agent_id = app_current_agent_id())
        )
    )
  );
--> statement-breakpoint
