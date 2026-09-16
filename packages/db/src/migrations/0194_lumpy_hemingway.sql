ALTER TABLE "rooms" ADD COLUMN "namespace_access_revision" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- M290_ROOM_NAMESPACE_ACCESS_REVISION
CREATE OR REPLACE FUNCTION "public"."advance_room_namespace_access_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE id = OLD.room_id;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE id = NEW.room_id;
  ELSIF NEW.room_id IS DISTINCT FROM OLD.room_id THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE id IN (OLD.room_id, NEW.room_id);
  ELSIF NEW.actor_id IS DISTINCT FROM OLD.actor_id THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE id = NEW.room_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION "public"."advance_room_namespace_access_revision"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."advance_room_namespace_access_revision"()
  TO "nautilo";
CREATE TRIGGER "room_members_namespace_access_revision"
AFTER INSERT OR DELETE OR UPDATE OF room_id, actor_id ON "room_members"
FOR EACH ROW EXECUTE FUNCTION "public"."advance_room_namespace_access_revision"();
