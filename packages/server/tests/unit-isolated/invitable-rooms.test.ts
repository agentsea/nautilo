/**
 * Hermetic regression coverage for the two invitable-Room listing routes.
 *
 * Isolated runner: `mock.module` replacements are process-global. The query
 * fixture compiles and evaluates the genuine Drizzle `where` expression so an
 * implementation that merely relies on pre-filtered mock rows cannot pass.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as realDb from "@nautilo/db";
import * as realTrust from "@nautilo/trust";

const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const routes = [
  "/api/invitable-rooms",
  "/api/invites/invitable-rooms/ignored-agent-id",
] as const;

type RoomFixture = {
  roomId: string;
  label: string;
  type: string;
  kind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
  externalContext: boolean;
  ownerId: string;
};

const roomFixtures: readonly RoomFixture[] = [
  { roomId: "open-own", label: "Own public Room", type: "shared", kind: "open", externalContext: false, ownerId: CALLER_ID },
  { roomId: "open-other", label: "Other public Room", type: "shared", kind: "open", externalContext: false, ownerId: OTHER_ID },
  { roomId: "external-open", label: "External public Room", type: "shared", kind: "open", externalContext: true, ownerId: CALLER_ID },
  { roomId: "private", label: "Private Room", type: "private", kind: "private", externalContext: false, ownerId: CALLER_ID },
  { roomId: "group", label: "Group Room", type: "shared", kind: "group", externalContext: false, ownerId: CALLER_ID },
  { roomId: "multi-agent", label: "Multi-agent Room", type: "shared", kind: "multi_agent", externalContext: false, ownerId: CALLER_ID },
  { roomId: "subthread", label: "Subthread", type: "shared", kind: "subthread", externalContext: false, ownerId: CALLER_ID },
  { roomId: "task", label: "Task Room", type: "private", kind: "task", externalContext: false, ownerId: CALLER_ID },
  { roomId: "access", label: "Access Room", type: "private", kind: "access", externalContext: false, ownerId: CALLER_ID },
];

let capabilities: string[] = [];
const compiledPredicates: Array<{ sql: string; params: unknown[] }> = [];
const getUserCapabilities = mock(async (_userId: string) => capabilities);
const dialect = new PgDialect();

function selectedRows(condition?: SQL): Array<{ roomId: string; label: string; type: string }> {
  let rows = [...roomFixtures];
  if (condition !== undefined) {
    const query = dialect.sqlToQuery(condition.getSQL());
    compiledPredicates.push({ sql: query.sql, params: query.params });
    expect(query.sql).not.toContain(" or ");

    for (const match of query.sql.matchAll(/"rooms"\."(kind|external_context|owner_id)" = \$(\d+)/g)) {
      const column = match[1];
      const parameterIndex = Number(match[2]) - 1;
      const value = query.params[parameterIndex];
      if (column === "kind") rows = rows.filter((row) => row.kind === value);
      if (column === "external_context") rows = rows.filter((row) => row.externalContext === value);
      if (column === "owner_id") rows = rows.filter((row) => row.ownerId === value);
    }
  }
  return rows.map(({ roomId, label, type }) => ({ roomId, label, type }));
}

function roomSelectBuilder() {
  const execute = (condition?: SQL) => Promise.resolve(selectedRows(condition));
  return {
    where: (condition: SQL) => execute(condition),
    // Preserve Drizzle's awaitable builder behavior so a missing `.where(...)`
    // executes as an unfiltered query and makes the regression fail visibly.
    then: <TResult1 = Array<{ roomId: string; label: string; type: string }>, TResult2 = never>(
      onfulfilled?: ((value: Array<{ roomId: string; label: string; type: string }>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => execute().then(onfulfilled, onrejected),
  };
}

const db = {
  select: mock((_selection?: unknown) => ({
    from: mock((table: unknown) => {
      if (table !== realDb.rooms) throw new Error("unexpected table in invitable-Room test");
      return roomSelectBuilder();
    }),
  })),
};

mock.module("@nautilo/db", () => ({ ...realDb, db }));
mock.module("@nautilo/trust", () => ({ ...realTrust, getUserCapabilities }));

const apps: FastifyInstance[] = [];

async function makeApp(sessionUserId: string | null): Promise<FastifyInstance> {
  const href = new URL("../../src/routes/invites.ts", import.meta.url).href;
  const { invitesRoutes } = await import(`${href}?t=${Date.now()}-${Math.random()}`) as typeof import("../../src/routes/invites");
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = sessionUserId;
  });
  invitesRoutes(app, {
    ownerId: "bootstrap-owner",
    securityAuditLogPath: "/unused/invitable-rooms-audit.jsonl",
    publicInviteBaseUrl: "https://example.test",
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  capabilities = [];
  compiledPredicates.length = 0;
  getUserCapabilities.mockClear();
  db.select.mockClear();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe.each([...routes])("GET %s", (url: (typeof routes)[number]) => {
  test("lists only the caller's internal public Rooms for self-service", async () => {
    capabilities = ["create_invites"];
    const response = await (await makeApp(CALLER_ID)).inject({ method: "GET", url });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ rooms: Array<{ roomId: string; label: string; type: string }> }>()).toEqual({
      rooms: [{ roomId: "open-own", label: "Own public Room", type: "shared" }],
    });
    expect(compiledPredicates).toHaveLength(1);
    expect(compiledPredicates[0]?.params).toEqual(["open", false, CALLER_ID]);
  });

  test("lets Room managers list internal public Rooms across owners", async () => {
    capabilities = ["manage_members", "manage_rooms"];
    const response = await (await makeApp(CALLER_ID)).inject({ method: "GET", url });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ rooms: Array<{ roomId: string; label: string; type: string }> }>()).toEqual({
      rooms: [
        { roomId: "open-own", label: "Own public Room", type: "shared" },
        { roomId: "open-other", label: "Other public Room", type: "shared" },
      ],
    });
    expect(compiledPredicates).toHaveLength(1);
    expect(compiledPredicates[0]?.params).toEqual(["open", false]);
  });

  test("preserves unauthenticated and unauthorized responses without querying Rooms", async () => {
    const unauthenticated = await (await makeApp(null)).inject({ method: "GET", url });
    const forbidden = await (await makeApp(CALLER_ID)).inject({ method: "GET", url });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json<{ error: string }>()).toEqual({ error: "Unauthorized" });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<{ error: string }>()).toEqual({ error: "forbidden" });
    expect(db.select).not.toHaveBeenCalled();
  });
});
