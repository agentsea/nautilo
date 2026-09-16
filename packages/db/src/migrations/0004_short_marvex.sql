ALTER TABLE "group_members" DROP CONSTRAINT "group_members_granted_by_actors_id_fk";
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_granted_by_actors_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;