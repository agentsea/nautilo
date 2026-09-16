import { randomUUID } from "node:crypto";
import { registerAllTools, setupCheckpointSaver, ToolCatalog, initToolCatalog } from "@nautilo/agent";
import {
  createDirectDb,
  eq,
  actors,
  agents,
  groups,
  groupMembers,
  sessions,
  sessionMessages,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import { initPolicyResolver } from "@nautilo/trust";
import { setupTestDb, createTestUser } from "./helpers";
import { createIntegrationStubPolicyResolver } from "./integration-stub-policy";

let toolCatalogBootstrapped = false;
let integrationToolCatalog: ToolCatalog | null = null;

/**
 * Mirrors server boot (`bin/nautilo-server`): `langgraphExecutor` →
 * `agentNode` calls `getToolCatalog()`, which is null until
 * `registerAllTools` + `initToolCatalog` run.
 */
function ensureToolCatalogForIntegration(): void {
  if (toolCatalogBootstrapped) return;
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  integrationToolCatalog = catalog;
  toolCatalogBootstrapped = true;
}

/** Register a suite-local dynamic tool in the same catalog used by the agent. */
export function registerIntegrationTestTool(
  registration: Parameters<ToolCatalog["register"]>[0],
): void {
  ensureToolCatalogForIntegration();
  if (!integrationToolCatalog) {
    throw new Error("integration ToolCatalog was not initialized");
  }
  integrationToolCatalog.register(registration);
}

type TestDb = DirectDatabase & { end: () => Promise<void> };

let _agentDb: TestDb | null = null;

function getAgentDb(): TestDb {
  if (!_agentDb) {
    _agentDb = createDirectDb(5);
  }
  return _agentDb;
}

export async function closeAgentDb(): Promise<void> {
  if (_agentDb) {
    await _agentDb.end();
    _agentDb = null;
  }
}

/**
 * Full agent test setup: DB + checkpoint saver + test user.
 * Also ensures NAUTILO_MODEL is set to a model whose API key is available,
 * since the default (anthropic:claude-sonnet-4-6) may not match the keys
 * present in the environment.
 */
export async function setupAgentTestEnv(
  userName?: string,
): Promise<{ userId: string; agentId: string }> {
  await setupTestDb();
  ensureToolCatalogForIntegration();
  const { userId } = await createTestUser(userName ?? "agent-test");

  // M125 Phase 2.6: every turn requires an agentId (input.agentId or
  // memoryAccessEnvelope.agentId) — the executor fails closed otherwise.
  // Create a real agent (+ agent-actor mirror) owned by the test user so
  // jobs can stamp input.agentId with an id that satisfies
  // sessions.agent_id's FK.
  const db = getAgentDb();
  const handle = `genie_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const [agent] = await db
    .insert(agents)
    .values({ handle })
    .returning({ id: agents.id });
  if (!agent) throw new Error("setupAgentTestEnv: agent insert failed");
  const [agentActor] = await db
    .insert(actors)
    .values({
      ownerId: userId,
      displayName: "Genie",
      trustState: "verified",
      kind: "agent",
      agentId: agent.id,
    })
    .returning({ id: actors.id });
  if (!agentActor) throw new Error("setupAgentTestEnv: agent actor insert failed");

  // Task and Job dispatch now re-check current invoke_agents capability.
  // Give the shared full-agent fixture the least-privileged canonical role
  // that carries that capability.
  const [contributorsGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "contributors"))
    .limit(1);
  if (!contributorsGroup) {
    throw new Error("setupAgentTestEnv: canonical contributors group missing");
  }
  await db.insert(groupMembers).values({
    groupId: contributorsGroup.id,
    userId,
    grantedBy: agentActor.id,
  });

  initPolicyResolver(createIntegrationStubPolicyResolver(userId));

  // Stack 198 — least-privilege checkpoint provisioning: setup() runs over
  // the short-lived canonical privileged direct pool, then the long-lived
  // saver is built on the nautilo_agent runtime role. Mirrors server boot in
  // bin/nautilo-server/src/index.ts.
  await setupCheckpointSaver();

  if (!process.env["NAUTILO_MODEL"]) {
    if (process.env["ANTHROPIC_API_KEY"]) {
      process.env["NAUTILO_MODEL"] = "anthropic:claude-sonnet-4-6";
    } else if (process.env["OPENAI_API_KEY"]) {
      process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
    }
  }

  return { userId, agentId: agent.id };
}

/**
 * Query session_messages for a thread's transcript.
 * Joins through sessions to find the session by threadId.
 */
export async function getTranscriptMessages(threadId: string) {
  const db = getAgentDb();

  const session = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.threadId, threadId))
    .limit(1);

  if (!session[0]) return [];

  const messages = await db
    .select({
      id: sessionMessages.id,
      role: sessionMessages.role,
      content: sessionMessages.content,
      toolCalls: sessionMessages.toolCalls,
      toolName: sessionMessages.toolName,
      createdAt: sessionMessages.createdAt,
    })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, session[0].id))
    // Bulk inserts in one batch can share created_at to ms granularity; id breaks the tie.
    .orderBy(sessionMessages.createdAt, sessionMessages.id);

  return messages;
}

/**
 * Query the sessions table for a specific thread.
 */
export async function getSessionByThread(threadId: string) {
  const db = getAgentDb();
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.threadId, threadId))
    .limit(1);
  return row ?? null;
}

/**
 * Full-text search on session_messages.
 */
export async function searchSessionMessagesFTS(query: string) {
  const db = getAgentDb();
  const results = await db
    .select({
      id: sessionMessages.id,
      content: sessionMessages.content,
      role: sessionMessages.role,
    })
    .from(sessionMessages)
    .where(sql`${sessionMessages.contentSearch} @@ plainto_tsquery('english', ${query})`);
  return results;
}

/**
 * Extract tool names from tool_calls JSON stored in session messages.
 * AI messages with tool calls store them as JSON in the toolCalls column.
 */
export function extractToolCalls(
  messages: Array<{ role: string; toolCalls: string | null }>,
): string[] {
  const names: string[] = [];
  for (const msg of messages) {
    if (msg.toolCalls) {
      try {
        const calls = JSON.parse(msg.toolCalls) as Array<{ name?: string }>;
        for (const call of calls) {
          if (call.name) names.push(call.name);
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return names;
}
