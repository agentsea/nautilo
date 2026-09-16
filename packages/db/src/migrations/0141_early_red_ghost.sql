ALTER TABLE "agent_photo_selection_revisions" DROP CONSTRAINT "agent_photo_selection_revisions_origin_check";--> statement-breakpoint
ALTER TABLE "owned_photo_entries" DROP CONSTRAINT "owned_photo_entries_origin_check";--> statement-breakpoint
ALTER TABLE "owned_photo_entries" DROP CONSTRAINT "owned_photo_entries_maintenance_origin_check";--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ADD CONSTRAINT "agent_photo_selection_revisions_origin_check" CHECK ("agent_photo_selection_revisions"."origin" IN ('workbench', 'mobile', 'desktop_wizard', 'cli_setup', 'manage_avatar', 'bundle_import'));--> statement-breakpoint
ALTER TABLE "owned_photo_entries" ADD CONSTRAINT "owned_photo_entries_origin_check" CHECK ("owned_photo_entries"."origin" IN ('workbench', 'mobile', 'desktop_wizard', 'cli_setup', 'manage_avatar', 'bundle_import', 'legacy_backfill', 'operator_adoption'));--> statement-breakpoint
ALTER TABLE "owned_photo_entries" ADD CONSTRAINT "owned_photo_entries_maintenance_origin_check" CHECK ((
        ("owned_photo_entries"."source" IN ('bundle_import', 'legacy_backfill', 'operator_adoption')
          AND "owned_photo_entries"."origin" = "owned_photo_entries"."source")
        OR ("owned_photo_entries"."source" NOT IN ('bundle_import', 'legacy_backfill', 'operator_adoption')
          AND "owned_photo_entries"."origin" IN ('workbench', 'mobile', 'desktop_wizard', 'cli_setup', 'manage_avatar'))
      ));