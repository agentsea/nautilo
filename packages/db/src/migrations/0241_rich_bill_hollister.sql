CREATE POLICY "encryption_transition_policy_agent_select" ON "encryption_transition_policy" AS PERMISSIVE FOR SELECT TO "nautilo_agent" USING (true);--> statement-breakpoint
GRANT SELECT ON TABLE "encryption_transition_policy" TO "nautilo_agent";
