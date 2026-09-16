-- D229 — DB-backed JSON cache for normalized provider catalog payloads.
-- The table stores Nautilo-normalized cache entries, not raw provider
-- payloads or relational voice rows.

CREATE TABLE IF NOT EXISTS provider_catalog_cache (
  provider text NOT NULL,
  account_fingerprint text NOT NULL,
  schema_version text NOT NULL,
  cache_key text NOT NULL,
  payload jsonb NOT NULL,
  cached_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  stale_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, account_fingerprint, schema_version, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_provider_catalog_cache_expires_at
  ON provider_catalog_cache (expires_at);

CREATE INDEX IF NOT EXISTS idx_provider_catalog_cache_stale_at
  ON provider_catalog_cache (stale_at);
