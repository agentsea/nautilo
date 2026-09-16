/**
 * D420 live-dev root-cause fix — `resolveAgentDatabaseConnectionString`
 * precedence + derivation tests.
 *
 * The deployed container topology 500/502'd on agent Neon HTTP paths
 * because the agent default connection string built its host:port from
 * `resolveInstance().db.postgresHostPort` (the host publish port, e.g.
 * 7934), while `DB_CONNECTION_STRING` correctly targets
 * `db.localtest.me:5432` (the db-host nginx multiplexer → app-postgres).
 * The fix derives the agent URL from `DB_CONNECTION_STRING` when present,
 * swapping only the role + password and preserving the host port.
 *
 * These tests pin the three precedence tiers and the host-port
 * preservation guarantee so the split cannot recur. They are pure
 * string-resolution tests — no live Postgres is required.
 */

import { describe, expect, it } from "bun:test";
import { resolveAgentDatabaseConnectionString } from "../../src/config/agent-database";

describe("resolveAgentDatabaseConnectionString (D420 live-dev fix)", () => {
  describe("tier 1 — explicit DB_AGENT_CONNECTION_STRING wins", () => {
    it("returns the explicit override unchanged when DB_CONNECTION_STRING is also set", () => {
      const override =
        "postgres://nautilo_agent:explicit-pw@db.localtest.me:5432/nautilo";
      const resolved = resolveAgentDatabaseConnectionString({
        DB_AGENT_CONNECTION_STRING: override,
        DB_CONNECTION_STRING:
          "postgres://nautilo:app-pw@db.localtest.me:5432/nautilo",
        NAUTILO_AGENT_DB_PASSWORD: "derived-pw",
      });
      expect(resolved).toBe(override);
    });

    it("trims whitespace from the explicit override", () => {
      const override =
        "postgres://nautilo_agent:explicit-pw@db.localtest.me:5432/nautilo";
      const resolved = resolveAgentDatabaseConnectionString({
        DB_AGENT_CONNECTION_STRING: `  ${override}  `,
      });
      expect(resolved).toBe(override);
    });
  });

  describe("tier 2 — derived from DB_CONNECTION_STRING when agent override absent", () => {
    it("swaps the role to nautilo_agent and the password to NAUTILO_AGENT_DB_PASSWORD", () => {
      const resolved = resolveAgentDatabaseConnectionString({
        DB_CONNECTION_STRING:
          "postgres://nautilo:app-pw@db.localtest.me:5432/nautilo",
        NAUTILO_AGENT_DB_PASSWORD: "agent-pw",
      });
      const u = new URL(resolved);
      expect(u.username).toBe("nautilo_agent");
      expect(u.password).toBe("agent-pw");
    });

    it("preserves the deployed host port 5432 (the root cause of the D420 split)", () => {
      const resolved = resolveAgentDatabaseConnectionString({
        DB_CONNECTION_STRING:
          "postgres://nautilo:app-pw@db.localtest.me:5432/nautilo",
        NAUTILO_AGENT_DB_PASSWORD: "agent-pw",
      });
      expect(new URL(resolved).port).toBe("5432");
    });

    it("preserves an arbitrary non-default host port verbatim", () => {
      const resolved = resolveAgentDatabaseConnectionString({
        DB_CONNECTION_STRING:
          "postgres://nautilo:app-pw@db.localtest.me:7934/nautilo",
        NAUTILO_AGENT_DB_PASSWORD: "agent-pw",
      });
      expect(new URL(resolved).port).toBe("7934");
    });

    it("preserves host, path, protocol, and query params", () => {
      const resolved = resolveAgentDatabaseConnectionString({
        DB_CONNECTION_STRING:
          "postgresql://nautilo:app-pw@db.localtest.me:5432/nautilo?sslmode=disable&application_name=x",
        NAUTILO_AGENT_DB_PASSWORD: "agent-pw",
      });
      const u = new URL(resolved);
      expect(u.protocol).toBe("postgresql:");
      expect(u.hostname).toBe("db.localtest.me");
      expect(u.pathname).toBe("/nautilo");
      expect(u.searchParams.get("sslmode")).toBe("disable");
      expect(u.searchParams.get("application_name")).toBe("x");
    });

    it("falls back to the default agent password when NAUTILO_AGENT_DB_PASSWORD is unset", () => {
      const resolved = resolveAgentDatabaseConnectionString({
        DB_CONNECTION_STRING:
          "postgres://nautilo:app-pw@db.localtest.me:5432/nautilo",
      });
      expect(new URL(resolved).password).toBe("nautilo_agent");
    });

    it("does not leak the app-role password into the derived agent URL", () => {
      const resolved = resolveAgentDatabaseConnectionString({
        DB_CONNECTION_STRING:
          "postgres://nautilo:secret-app-pw@db.localtest.me:5432/nautilo",
        NAUTILO_AGENT_DB_PASSWORD: "agent-pw",
      });
      expect(resolved).not.toContain("secret-app-pw");
      expect(new URL(resolved).password).toBe("agent-pw");
    });

    it("prefers DB_CONNECTION_STRING over the resolveInstance default even when the app URL uses a host publish port", () => {
      // In the deployed topology DB_CONNECTION_STRING targets 5432 while
      // resolveInstance().db.postgresHostPort would resolve to the host
      // publish port (e.g. 7934). Derivation must pick the app URL's 5432,
      // not the resolved default's publish port.
      const resolved = resolveAgentDatabaseConnectionString({
        DB_CONNECTION_STRING:
          "postgres://nautilo:app-pw@db.localtest.me:5432/nautilo",
        NAUTILO_AGENT_DB_PASSWORD: "agent-pw",
      });
      expect(new URL(resolved).port).toBe("5432");
    });
  });

  describe("tier 3 — constructed default when neither agent nor app string is set", () => {
    it("falls back to the resolveInstance-derived default with the agent password", () => {
      // We cannot assert an exact port without faking the config-guard
      // module, but we CAN assert the constructed-default shape: the
      // nautilo_agent role, the db.localtest.me host, the nautilo path,
      // and the env-supplied password. The host port comes from
      // resolveInstance() and is exercised by the live integration suite.
      const resolved = resolveAgentDatabaseConnectionString({
        NAUTILO_AGENT_DB_PASSWORD: "fallback-pw",
      });
      const u = new URL(resolved);
      expect(u.username).toBe("nautilo_agent");
      expect(u.password).toBe("fallback-pw");
      expect(u.hostname).toBe("db.localtest.me");
      expect(u.pathname).toBe("/nautilo");
    });

    it("uses the default agent password when NAUTILO_AGENT_DB_PASSWORD is unset", () => {
      const resolved = resolveAgentDatabaseConnectionString({});
      expect(new URL(resolved).password).toBe("nautilo_agent");
    });
  });
});
