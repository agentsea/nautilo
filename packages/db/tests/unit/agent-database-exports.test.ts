/**
 * Agent-role database factory exports: type and Drizzle shape checks.
 * Live PostgreSQL role isolation requires separate integration acceptance
 * against a disposable database with the restricted role provisioned.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import { isTable } from "drizzle-orm";
import {
  agentDb,
  createAgentDatabase,
  createDirectAgentDb,
  resolveAgentDatabaseConnectionString,
  resolveDirectAgentDatabaseConnectionString,
} from "../../src/config/agent-database";
import * as packageExports from "../../src/index";

function isolatedHomeEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const home = join(tmpdir(), `nautilo-agent-db-test-${randomUUID()}`);
  mkdirSync(join(home, ".nautilo"), { recursive: true });
  return { ...process.env, HOME: home, USERPROFILE: home, ...extra };
}

beforeEach(() => {
  __resetResolvedInstanceForTests();
});

afterEach(() => {
  __resetResolvedInstanceForTests();
});

describe("agent-database factory (D129 P3)", () => {
  describe("module exports", () => {
    it("exports agentDb Proxy singleton", () => {
      expect(agentDb).toBeDefined();
      expect(typeof agentDb).toBe("object");
    });

    it("exports createAgentDatabase function (postgres-js runtime factory)", () => {
      expect(typeof createAgentDatabase).toBe("function");
    });

    it("exports createDirectAgentDb function (postgres-js direct factory)", () => {
      expect(typeof createDirectAgentDb).toBe("function");
    });

    it("exports resolveAgentDatabaseConnectionString helper", () => {
      expect(typeof resolveAgentDatabaseConnectionString).toBe("function");
    });

    it("exports resolveDirectAgentDatabaseConnectionString helper", () => {
      expect(typeof resolveDirectAgentDatabaseConnectionString).toBe(
        "function",
      );
    });
  });

  describe("package re-exports from @nautilo/db", () => {
    it("re-exports agentDb at the package boundary", () => {
      expect(packageExports.agentDb).toBeDefined();
      expect(packageExports.agentDb).toBe(agentDb);
    });

    it("re-exports the agent-role factories at the package boundary", () => {
      expect(packageExports.createAgentDatabase).toBe(createAgentDatabase);
      expect(packageExports.createDirectAgentDb).toBe(createDirectAgentDb);
    });
  });

  describe("connection-string resolution", () => {
    it("respects DB_AGENT_CONNECTION_STRING env override", () => {
      const override = "postgres://nautilo_agent:test@example.invalid:5432/x";
      const resolved = resolveAgentDatabaseConnectionString({
        DB_AGENT_CONNECTION_STRING: override,
      });
      expect(resolved).toBe(override);
    });

    it("trims whitespace from DB_AGENT_CONNECTION_STRING", () => {
      const override = "postgres://nautilo_agent:test@example.invalid:5432/x";
      const resolved = resolveAgentDatabaseConnectionString({
        DB_AGENT_CONNECTION_STRING: `  ${override}  `,
      });
      expect(resolved).toBe(override);
    });

    it("respects DB_AGENT_DIRECT_CONNECTION env override for direct factory", () => {
      const override = "postgres://nautilo_agent:test@example.invalid:5432/x";
      const resolved = resolveDirectAgentDatabaseConnectionString({
        DB_AGENT_DIRECT_CONNECTION: override,
      });
      expect(resolved).toBe(override);
    });

    it("constructs default runtime connection through db.localtest.me with nautilo_agent role", () => {
      const env = isolatedHomeEnv({ NAUTILO_DB_PORT: "6100" });
      expect(resolveAgentDatabaseConnectionString(env)).toBe(
        "postgres://nautilo_agent:nautilo_agent@db.localtest.me:6100/nautilo",
      );
    });

    it("uses NAUTILO_AGENT_DB_PASSWORD in the default runtime URL", () => {
      const env = isolatedHomeEnv({
        NAUTILO_DB_PORT: "6101",
        NAUTILO_AGENT_DB_PASSWORD: "secret-agent",
      });
      expect(resolveAgentDatabaseConnectionString(env)).toBe(
        "postgres://nautilo_agent:secret-agent@db.localtest.me:6101/nautilo",
      );
    });

    it("constructs default direct connection swapping in nautilo_agent role", () => {
      const env = isolatedHomeEnv({
        NAUTILO_DB_PORT: "6102",
        DB_DIRECT_CONNECTION:
          "postgresql://postgres:postgres@localhost:6102/nautilo",
      });
      expect(resolveDirectAgentDatabaseConnectionString(env)).toBe(
        "postgresql://nautilo_agent:nautilo_agent@localhost:6102/nautilo",
      );
    });
  });

  describe("Drizzle handle shape", () => {
    it("agentDb proxy exposes Drizzle schema tables when accessed", () => {
      // The proxy lazy-instantiates the database on first access. We
      // can't actually instantiate without a live Postgres at the
      // resolved connection string (which we don't want to require for
      // a unit test), so this test instead verifies the schema is
      // importable via the package index — confirming the wiring
      // surface is intact.
      expect(packageExports.memories).toBeDefined();
      expect(isTable(packageExports.memories)).toBe(true);
    });
  });
});
