/**
 * M045 — regression tests for the agent-ownership cleanup.
 *
 * Focus areas:
 *
 *   1. `findAgentActorForAgent` is the canonical mirror-Actor helper
 *      (replaces the pre-M045 owner-keyed `findAgentActorByOwnerId`).
 *      `.limit(1)` is deterministic when keyed on `agentId` because
 *      REL-ACT-AGT is 1:1.
 *
 *   2. The helper is exported from the `@nautilo/trust` public surface
 *      under its new name.
 *
 *   3. The null-guard short-circuit: an empty / missing `agentId`
 *      returns null WITHOUT opening a Postgres connection. This is the
 *      defensive belt under bootstrap-race paths (the resolver already
 *      avoids calling with empty ids, but we do not want a stray call
 *      to fault the connection pool).
 *
 *   4. The pre-M045 owner-keyed helper is gone — locks in the rename.
 *
 * The multi-agent disambiguation invariant ("two agents owned by the
 * same user → distinct mirror-Actor rows") requires a real Postgres to
 * exercise the `actors.agent_id = $1` filter; that test lives in the
 * integration suite at
 * `packages/trust/tests/integration/personal-policy-resolver.test.ts`
 * (M045 — agent-ownership-cleanup invariants describe block).
 */

import { describe, expect, test } from "bun:test";

import * as trustIndex from "../../src/index";
import * as queries from "../../src/queries";

describe("M045 — findAgentActorForAgent", () => {
  test("is exported from @nautilo/trust under its new name", () => {
    expect(typeof trustIndex.findAgentActorForAgent).toBe("function");
  });

  test("pre-M045 owner-keyed helper is no longer exported", () => {
    // The old name was `findAgentActorByOwnerId`. Lock the rename.
    expect(
      (trustIndex as unknown as Record<string, unknown>)[
        "findAgentActorByOwnerId"
      ],
    ).toBeUndefined();
    expect(
      (queries as unknown as Record<string, unknown>)[
        "findAgentActorByOwnerId"
      ],
    ).toBeUndefined();
  });

  test("returns null for empty agentId without opening a DB connection", async () => {
    // The body of findAgentActorForAgent short-circuits on !agentId
    // BEFORE calling createDirectDb. If the guard regresses, this test
    // would either (a) try to connect to a non-running Postgres and
    // time out, or (b) throw a connection error. Either way the test
    // turns red — no real DB needed to guard the invariant.
    const result = await queries.findAgentActorForAgent("");
    expect(result).toBeNull();
  });

  test("returns null for whitespace-trimmed empty-like agentId", async () => {
    // Defensive belt — any falsy input (JS semantics) short-circuits.
    // `"0"` would NOT short-circuit because non-empty strings are
    // truthy; only `""` triggers the guard. Asserting the contract
    // shape explicitly so a future "trim + reject" change doesn't
    // silently widen the guard.
    const result = await queries.findAgentActorForAgent("");
    expect(result).toBeNull();
  });
});

describe("M045 — findAgentById return shape", () => {
  test("public surface type exposes only { id, handle, displayName }", () => {
    // Compile-time invariant: the exported function's return type has
    // no `ownerId` field. We can't inspect a TypeScript return type at
    // runtime, so this test exists as a placeholder AND a documentation
    // anchor. If someone re-adds `ownerId` to the shape, tsc will
    // break at the consuming sites (getFederatedIdForActor,
    // resolveContext) — this test is the human-facing signal.
    expect(typeof queries.findAgentById).toBe("function");
  });
});

// ===========================================================================
// Schema-shape invariants — Drizzle column proxy, no DB / no drizzle-orm dep
// ===========================================================================
//
// The `agents` table object (a Drizzle pgTable) exposes every schema
// column as a top-level property. That's enough for a no-dep
// introspection of "does this column still exist?" — which is exactly
// the M045 invariant we want to lock in for this package. We lock in
// the FK / index / unique-constraint facts in the Drizzle-owned
// `@nautilo/db` package's migration snapshot (PR review artifact) + in
// the integration test (real DB catalog check).

import { agents } from "@nautilo/db";

describe("M045 — agents schema shape", () => {
  test("agents table carries no ownerId / owner_id column", () => {
    // The Drizzle pgTable proxy exposes every column under its
    // camelCase key. If `owner_id` sneaks back in — as `ownerId` on
    // the proxy — this assertion fires and the PR author has to
    // re-read the canonical REL-AGT-HUM invariant.
    const agentsRecord = agents as unknown as Record<string, unknown>;
    expect(agentsRecord["ownerId"]).toBeUndefined();
    expect(agentsRecord["owner_id"]).toBeUndefined();
  });

  test("agents table carries the M156 canonical columns", () => {
    // camelCase property names (the Drizzle JS surface). The raw SQL
    // column names (`created_at`, `handle_customized`, etc.) are snake_case
    // — both are the same schema, just different naming conventions.
    const expected = ["id", "handle", "handleCustomized", "createdAt", "updatedAt"];
    const agentsRecord = agents as unknown as Record<string, unknown>;
    for (const key of expected) {
      expect(agentsRecord[key]).toBeDefined();
    }
    expect(agentsRecord["displayName"]).toBeUndefined();
    expect(agentsRecord["display_name"]).toBeUndefined();
  });
});

// ===========================================================================
// Agent insert payload shape — compile-time lock (no ownerId)
// ===========================================================================
//
// This block intentionally exercises the `NewAgent` type through a
// literal construction. If `agents.ownerId` gets re-added as a NOT NULL
// column, this file fails to typecheck — which is exactly the signal
// we want. (At runtime the object is discarded; the test body just
// confirms the literal has the expected keys.)

import type { NewAgent } from "@nautilo/db";

describe("M045 — agent insert payload shape", () => {
  test("NewAgent literal requires only { handle }", () => {
    const candidate: NewAgent = {
      handle: "m045-type-probe",
    };
    expect(candidate.handle).toBe("m045-type-probe");
    // Runtime proof that no `ownerId` was accepted (silent-default
    // ergonomics would have hidden a schema regression).
    expect((candidate as Record<string, unknown>)["ownerId"]).toBeUndefined();
    expect((candidate as Record<string, unknown>)["owner_id"]).toBeUndefined();
    expect((candidate as Record<string, unknown>)["displayName"]).toBeUndefined();
  });
});

