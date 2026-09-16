#!/bin/bash
# M051 (Logto cluster): first-boot Postgres initializer.
#
# Mounts into the Postgres container at
#   /docker-entrypoint-initdb.d/01-nautilo.sh
# and runs exactly once when the `pgdata` volume is fresh. Subsequent
# boots skip it because the volume already has $PGDATA/PG_VERSION set.
#
# Creates two databases on the same cluster:
#   - `nautilo`        owned by the `nautilo` role (existing app)
#   - `logto_nautilo`  owned by the `logto`   role (M051+)
#
# Cross-database access is revoked: each role only sees its own DB. The
# isolation boundary is the database; the cluster is shared (per
# nautilo-deployment-modes-v1.md §5.7 + research/logto-integration-v1.md
# §7.2).
#
# For operators upgrading a pre-M051 Postgres volume (where this script
# never ran), `bun run dev:verify-postgres-databases --fix` is the
# upgrade-path counterpart.
set -e

: "${NAUTILO_POSTGRES_CLUSTER_KIND:?NAUTILO_POSTGRES_CLUSTER_KIND must be app or logto}"
if [[ "$NAUTILO_POSTGRES_CLUSTER_KIND" != "app" && "$NAUTILO_POSTGRES_CLUSTER_KIND" != "logto" ]]; then
  echo "NAUTILO_POSTGRES_CLUSTER_KIND must be app or logto" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE ROLE nautilo LOGIN PASSWORD '${NAUTILO_DB_PASSWORD:?NAUTILO_DB_PASSWORD must be set}';
  -- M116 §2: BYPASSRLS so D168 SECURITY DEFINER helpers (migration 0050) work when migrations run as nautilo. Note: BYPASSRLS still bypasses FORCE RLS — D197 raises the auth-side ceiling separately.
  ALTER ROLE nautilo BYPASSRLS;
  -- The 'logto' role needs CREATEROLE so Logto's cli db seed can
  -- mint its internal application roles (m-admin, etc.). Postgres
  -- CREATEROLE doesn't grant cross-database access; the database
  -- boundary still isolates this role from the 'nautilo' DB. This
  -- matches what self-hosted Logto requires and what upstream's
  -- own docker-compose effectively does (it uses postgres superuser).
  CREATE ROLE logto   LOGIN CREATEROLE PASSWORD '${LOGTO_DB_PASSWORD:?LOGTO_DB_PASSWORD must be set}';

  -- D129 P3 — agent-vs-auth Postgres role split (M1 stopgap for v11 §6
  -- Layer 1). The 'nautilo_agent' role is what the agent runtime uses
  -- at runtime (after the packages/agent/src/* refactor in a follow-on
  -- commit). It cannot SELECT credentials / recovery_codes / sessions
  -- / logto_account_security / channel_identities at the GRANT layer —
  -- Postgres rejects the queries at parse time, before any RLS policy
  -- has a chance to filter. This is structurally stronger than RLS for
  -- the credential surface: RLS gates "which rows can this role see,"
  -- GRANT exclusion gates "can this role reference this table at all."
  --
  -- The 'nautilo' role (full privilege) is retained for auth routes,
  -- migrations, seeds, and integration tests. The split is at the
  -- DB-role layer; the OS process boundary (agent vs auth) is a
  -- separate hardening axis (out of scope here).
  CREATE ROLE nautilo_agent LOGIN PASSWORD '${NAUTILO_AGENT_DB_PASSWORD:?NAUTILO_AGENT_DB_PASSWORD must be set}';

  CREATE DATABASE nautilo        OWNER nautilo;
  CREATE DATABASE logto_nautilo  OWNER logto;

  -- Lock down cross-DB access: explicitly revoke each role from the
  -- OTHER database. PUBLIC keeps the default CONNECT on logto_nautilo
  -- because Logto's cli db seed mints per-tenant roles that need
  -- CONNECT (they inherit it from PUBLIC; without that they fail with
  -- "User does not have CONNECT privilege" — 42501 from postinit.c).
  -- Cross-DB content is still isolated: nautilo and logto are
  -- explicitly revoked from each other's database, and table-level
  -- grants are owned by the database owner regardless of PUBLIC.
  REVOKE ALL ON DATABASE nautilo       FROM PUBLIC, logto, nautilo_agent;
  REVOKE ALL ON DATABASE logto_nautilo FROM nautilo, nautilo_agent;
  GRANT  ALL    ON DATABASE nautilo       TO nautilo;
  GRANT  ALL    ON DATABASE logto_nautilo TO logto;
  GRANT  CONNECT ON DATABASE nautilo      TO nautilo_agent;
EOSQL

if [[ "$NAUTILO_POSTGRES_CLUSTER_KIND" == "app" ]]; then
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-'EOSQL'
  \getenv crypto_password NAUTILO_CRYPTO_DB_PASSWORD
  \if :{?crypto_password}
  \else
  \echo 'NAUTILO_CRYPTO_DB_PASSWORD must be set'
  \quit 3
  \endif
  BEGIN;
  SELECT length($1) > 0 AS crypto_password_present
  \bind :crypto_password
  \gset
  \if :crypto_password_present
  \else
  \echo 'NAUTILO_CRYPTO_DB_PASSWORD must not be empty'
  \quit 3
  \endif
  SELECT set_config('nautilo.crypto_role_password', $1, true)
  \bind :crypto_password
  \g
  DO $do$
  BEGIN
    EXECUTE format(
      'CREATE ROLE nautilo_crypto LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
      current_setting('nautilo.crypto_role_password')
    );
  END
  $do$;
  REVOKE ALL ON DATABASE nautilo FROM nautilo_crypto;
  GRANT CONNECT ON DATABASE nautilo TO nautilo_crypto;
  REVOKE ALL ON DATABASE logto_nautilo FROM nautilo_crypto;
  COMMIT;
EOSQL
fi

# D129 P3 — apply the nautilo_agent schema-level grants + users_public
# view inside the nautilo database. Done in a second psql session
# because we need to connect to the nautilo DB itself (the first
# session is connected to the postgres maintenance DB). Schema does
# not exist yet at this point — the application's migration runner
# creates the tables on first boot. So we set DEFAULT PRIVILEGES so
# that whatever tables 'nautilo' (the owner) creates inherit the
# right grants. We also explicitly GRANT against any tables that
# already exist (idempotent and safe — no tables exist on first boot
# but a re-run after migrations have applied catches them).
#
# For existing pre-D129-P3 deployments where the role + grants need
# to be added against a populated DB, see the operator migration
# helper at bin/nautilo-dev/src/commands/migrate-add-agent-role.ts
# (landed alongside this script — to be written as a follow-on task).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname nautilo <<-EOSQL
  GRANT USAGE ON SCHEMA public TO nautilo_agent;

  -- Default privileges for FUTURE tables created by the nautilo owner.
  -- The application's migrations run as 'nautilo' (the DB owner); any
  -- table it creates inherits the grants below for nautilo_agent EXCEPT
  -- tables we explicitly REVOKE below.
  --
  -- DELETE is included (the D129 issue body spec says only
  -- SELECT/INSERT/UPDATE, but the agent legitimately deletes memory
  -- rows via the manage_memory tool's delete operation and scope
  -- close paths via close_scope; without DELETE those tools break).
  -- D169's substrate map should record this as a spec deviation worth
  -- revisiting if a per-operation breakdown becomes useful (e.g., do
  -- we want the agent to delete artifacts but not memories?).
  ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nautilo_agent;
  ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO nautilo_agent;

  -- Same for tables that ALREADY exist (no-op on first boot; required
  -- when this script is re-applied via the operator migration helper
  -- after the schema is populated).
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
    TO nautilo_agent;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
    TO nautilo_agent;
EOSQL

# D129 P3 — credential/session-table grant REVOKEs.
#
# This block is conditional: it only runs if the tables already exist
# (i.e. the migration runner has populated the schema). On first boot
# the schema is empty and this is a no-op; the migration helper
# (bin/nautilo-dev/src/commands/migrate-add-agent-role.ts) re-runs
# this against existing deployments. The pg_class lookup makes the
# block safe to re-run with no side effects.
#
# Tables excluded from nautilo_agent's reach. Per
# packages/db/audits/sensitive-tables-matrix.md the CREDENTIAL-class
# tables are `credentials` + `recovery_codes`. `logto_account_security`
# holds Logto account lifecycle metadata (no plaintext passwords by
# design but still operator-private). `channel_identities` is the
# (channel, external_id) → user binding that's high-PII even though the
# matrix flags it OPERATOR-INTERNAL.
#
# IMPORTANT: the `sessions` DB table is conversational transcript
# sessions (per GLOSSARY Session entity — a Room's accumulated
# conversation episodes), NOT auth-Session/AuthToken (which lives on
# disk in ~/.nautilo/sessions.json, never in the DB). The agent
# runtime LEGITIMATELY READS `sessions` for memory recall + "list
# recent conversations" surfaces. **Do not add sessions to this
# REVOKE list** — doing so breaks memory recall.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname nautilo <<-'EOSQL'
  DO $$
  DECLARE
    sensitive_tables text[] := ARRAY[
      'credentials',
      'recovery_codes',
      'logto_account_security',
      'channel_identities',
      'crypto_domains',
      'crypto_domain_provider_heads',
      'namespace_crypto_bindings',
      'namespace_crypto_heads',
      'crypto_objects',
      'object_crypto_access_manifests',
      'object_crypto_namespace_envelopes',
      'object_crypto_access_heads',
      'agent_crypto_runtime_states',
      'agent_crypto_runtime_config_objects',
      'agent_crypto_runtime_domain_envelopes',
      'agent_crypto_runtime_challenges',
      'crypto_grants',
      'human_crypto_recovery_archives'
    ];
    tbl text;
  BEGIN
    FOREACH tbl IN ARRAY sensitive_tables LOOP
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = tbl AND n.nspname = 'public' AND c.relkind = 'r'
      ) THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE public.%I FROM nautilo_agent',
          tbl
        );
        RAISE NOTICE 'D129 P3: revoked nautilo_agent grants on %', tbl;
      ELSE
        RAISE NOTICE 'D129 P3: skipping % (table does not exist yet — '
          'first-boot path; the operator migration helper will revisit '
          'after schema population)', tbl;
      END IF;
    END LOOP;
  END $$;

  -- Conditional users_public view (created only if the users table
  -- exists). Exposes ONLY the safe columns the agent role legitimately
  -- needs: identity (id, handle, name) + provenance (server,
  -- created_at, updated_at, server_role). EXCLUDES:
  --   - email             — PII; the agent has no legitimate reason to
  --                          enumerate user emails
  --   - external_id       — Logto sub; pivot point for identity attack
  --
  -- The displayed-name column on users is name (varchar 255),
  -- NOT display_name — verified against packages/db/src/schema/users.ts.
  -- A prior draft of this script said display_name and would have
  -- failed at view-creation time; caught by phase-end self-check.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'users' AND n.nspname = 'public' AND c.relkind = 'r'
    ) THEN
      EXECUTE 'CREATE OR REPLACE VIEW public.users_public AS '
              'SELECT id, handle, name, server, '
              '       created_at, updated_at '
              'FROM public.users';
      EXECUTE 'GRANT SELECT ON public.users_public TO nautilo_agent';
      EXECUTE 'REVOKE ALL ON TABLE public.users FROM nautilo_agent';
      RAISE NOTICE 'D129 P3: created users_public view + grants';
    ELSE
      RAISE NOTICE 'D129 P3: skipping users_public view (users table '
        'does not exist yet — first-boot path; the operator migration '
        'helper will revisit after schema population)';
    END IF;
  END $$;
EOSQL

# M116 §1 — pre-install required extensions cluster-side as superuser so
# migrations don't need superuser. Migration 0002_loose_zzzax.sql runs
# `CREATE EXTENSION IF NOT EXISTS vector;` and becomes a no-op once this
# block ran on first volume boot.
#
# Existing volumes skip this init script; deploy/restore runs
# buildFullLegacyRoleRepairSql() as superuser against app-postgres before
# server migrations to install vector and repair ownership/grants.
#
# Availability-gated via pg_available_extensions: the same canonical script
# is mounted on BOTH the app-DB cluster (image: pgvector/pgvector — vector
# IS available) AND the Logto cluster (image: plain postgres:16 — vector
# is NOT shipped). Plain `CREATE EXTENSION` would error on the Logto image
# and exit the init script non-zero (postgres exits code 3). The DO-block
# below skips silently when vector is unavailable; it's a no-op for the
# Logto cluster (which never needs vector — the `nautilo` DB is created
# there only for byte-identity with the app cluster, see infra/compose
# /nautilo.yml comments) and a real install on the app cluster.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname nautilo <<-'EOSQL'
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
      CREATE EXTENSION IF NOT EXISTS vector;
      RAISE NOTICE 'M116: installed vector extension';
    ELSE
      RAISE NOTICE 'M116: vector extension not available on this image (e.g. plain postgres:16 used by the Logto cluster); skipping';
    END IF;
  END $$;
EOSQL
