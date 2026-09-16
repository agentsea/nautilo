-- M320 foreground Agent publication records the exact semantic effect on the
-- content-free operation receipt. Keep the Agent role on column-level UPDATE:
-- it must not gain authority over immutable operation identity or Human-only
-- outcome fields.
GRANT UPDATE ("semantic_change_kind")
  ON TABLE "memory_crypto_operations"
  TO "nautilo_agent";
