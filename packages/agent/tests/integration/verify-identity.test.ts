import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  credentials,
  eq,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { hashPin, type MemoryAccessEnvelope } from "@nautilo/trust";
import { createVerifyIdentityTool } from "../../src/tools/trust/verify-identity";

function envelope(ownerId: string): MemoryAccessEnvelope {
  const stub = {
    ownerId,
    actorId: "actor",
    agentId: "agent",
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  };
  return stub as unknown as MemoryAccessEnvelope;
}

let db: ReturnType<typeof createDirectDb>;
let ownerId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [user] = await db
    .insert(users)
    .values({ name: "verify-id-test", email: `verify-id-${Date.now()}@test.local` })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");
  ownerId = user.id;

  // M043: credentials FK directly to users.id — no actor row needed
  // for this test.
  const hashed = await hashPin("1234");
  await db.insert(credentials).values({
    userId: ownerId,
    type: "pin",
    value: hashed,
  });
});

afterAll(async () => {
  if (db && ownerId) {
    await db.delete(credentials).where(eq(credentials.userId, ownerId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.end();
  }
});

describe("verify_identity tool (integration)", () => {
  test("returns error when envelope user has no PIN credential", async () => {
    // M125 Phase 1.1: subject comes from envelope.ownerId per invocation.
    const tool = createVerifyIdentityTool({
      memoryAccessEnvelope: envelope("00000000-0000-0000-0000-000000000000"),
    });
    const result = await tool.invoke({});
    expect(result).toContain("No PIN credential");
  });

  test("returns error when no envelope is provided (anonymous turn)", async () => {
    const tool = createVerifyIdentityTool();
    const result = await tool.invoke({});
    expect(result).toContain("verify_identity unavailable");
  });

  // Note: testing the interrupt() flow requires a running LangGraph graph
  // with a checkpointer. That's tested via the full server integration
  // (bun run oss → guest → claim identity → PIN modal → verify-and-resume).
  // The interrupt() call cannot be invoked outside a graph context.
});
