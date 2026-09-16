-- D319 / M156 backfill — repair non-customized Agent handles after
-- pre-M156 profile renames.
--
-- M156 made `profiles.name` the canonical Agent name and
-- `agents.handle_customized=false` means the handle auto-derives from that
-- name on rename. The M156 rename helper now updates:
--   profiles.name -> actors.display_name -> agents.handle
-- transactionally, unless the user manually customized the handle.
--
-- But agents renamed BEFORE M156 could be left with a stale derived handle,
-- e.g. profile name "Nova" with handle "@genie_owner". This idempotent
-- data migration repairs only non-customized handles.
--
-- Candidate order mirrors `buildHandleCandidates` as far as a deterministic
-- data migration safely can:
--   1. base slug from profiles.name (e.g. "Alepo" -> "alepo")
--   2. base + "_" + owner handle when the base slug is unavailable
--
-- Random-digit fallbacks are intentionally omitted in a migration: if both
-- deterministic candidates are unavailable, the row is left unchanged so a
-- human can decide the right handle. Collision checks cover existing Agent
-- handles, local Human handles, and duplicate candidate rows in this same
-- migration batch.

WITH candidate_rows AS (
  SELECT
    ag.id AS agent_id,
    ag.handle AS current_handle,
    -- M156 slugifyToHandleBase(name): trim, lowercase, replace non-charset
    -- runs with "_", trim "_", strip non-letter prefix, truncate to 30.
    CASE
      WHEN length(base_slug) < 3 THEN 'genie'
      ELSE base_slug
    END AS base_candidate,
    COALESCE(NULLIF(u.handle, ''), 'owner') AS owner_handle
  FROM agents ag
  JOIN profiles p ON p.agent_id = ag.id
  JOIN actors a ON a.agent_id = ag.id AND a.kind = 'agent'
  LEFT JOIN users u ON u.id = a.owner_id AND u.server IS NULL
  CROSS JOIN LATERAL (
    SELECT left(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '_', 'g'),
          '^_+|_+$',
          '',
          'g'
        ),
        '^[^a-z]+',
        '',
        'g'
      ),
      30
    ) AS base_slug
  ) slug
  WHERE ag.handle_customized = false
),
candidates AS (
  SELECT
    agent_id,
    current_handle,
    base_candidate,
    regexp_replace(
      left(
        concat(
          left(base_candidate, greatest(1, 30 - length(owner_handle) - 1)),
          '_',
          owner_handle
        ),
        30
      ),
      '_+$',
      '',
      'g'
    ) AS owner_candidate
  FROM candidate_rows
),
candidate_counts AS (
  SELECT
    c.*,
    count(*) OVER (PARTITION BY base_candidate) AS base_batch_count,
    count(*) OVER (PARTITION BY owner_candidate) AS owner_batch_count
  FROM candidates c
),
chosen AS (
  SELECT
    c.agent_id,
    CASE
      WHEN c.base_candidate ~ '^[a-z][a-z0-9_]{2,29}$'
        AND c.base_batch_count = 1
        AND NOT EXISTS (
          SELECT 1 FROM agents other
          WHERE other.handle = c.base_candidate AND other.id <> c.agent_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM users human
          WHERE human.handle = c.base_candidate AND human.server IS NULL
        )
        THEN c.base_candidate
      WHEN c.owner_candidate ~ '^[a-z][a-z0-9_]{2,29}$'
        AND c.owner_batch_count = 1
        AND NOT EXISTS (
          SELECT 1 FROM agents other
          WHERE other.handle = c.owner_candidate AND other.id <> c.agent_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM users human
          WHERE human.handle = c.owner_candidate AND human.server IS NULL
        )
        THEN c.owner_candidate
      ELSE NULL
    END AS new_handle
  FROM candidate_counts c
)
UPDATE agents ag
SET handle = chosen.new_handle,
    updated_at = now()
FROM chosen
WHERE ag.id = chosen.agent_id
  AND chosen.new_handle IS NOT NULL
  AND ag.handle <> chosen.new_handle;