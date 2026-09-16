DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    GRANT SELECT ON TABLE
      "workspace_document_mutations",
      "workspace_document_mutation_entries",
      "workspace_document_mutation_entry_identities"
    TO "nautilo_agent";
    GRANT UPDATE ("pinned", "accessed_at")
    ON TABLE "workspace_document_mutations"
    TO "nautilo_agent";
  END IF;
END $$;
