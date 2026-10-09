ALTER TABLE "conversion_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "conversion_operations_product_all" ON "conversion_operations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Drizzle models policies but does not emit FORCE RLS or role privileges.
ALTER TABLE "conversion_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversion_operations" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conversion_operations" TO "nautilo";
