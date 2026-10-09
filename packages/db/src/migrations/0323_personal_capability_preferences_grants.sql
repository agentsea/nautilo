REVOKE ALL PRIVILEGES ON TABLE "personal_capability_preferences"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "personal_capability_preferences"
  TO "nautilo";
