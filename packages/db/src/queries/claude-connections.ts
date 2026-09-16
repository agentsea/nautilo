import { and, eq } from "drizzle-orm";
import { getSharedDirectAgentDb } from "../config/agent-database";
import { withTrustContext } from "../connection/with-trust-context";
import {
  claudeConnections,
  type ClaudeConnectionAccount,
  type ClaudeConnectionCatalog,
  type ClaudeConnectionRuntime,
} from "../schema/claude-connections";

export type ClaudeConnectionOwnerContext = { readonly userId: string };
type ClaudeDb = ReturnType<typeof getSharedDirectAgentDb>;
type ClaudeTx = Parameters<Parameters<ClaudeDb["transaction"]>[0]>[0];

function scoped<T>(db: ClaudeDb, ctx: ClaudeConnectionOwnerContext, fn: (tx: ClaudeTx) => Promise<T>): Promise<T> {
  return withTrustContext(ctx, fn, db);
}

export async function getOrCreateClaudeConnectionWith(db: ClaudeDb, ctx: ClaudeConnectionOwnerContext) {
  return scoped(db, ctx, async (tx) => {
    await tx.insert(claudeConnections).values({ userId: ctx.userId }).onConflictDoNothing();
    const [row] = await tx.select().from(claudeConnections).where(eq(claudeConnections.userId, ctx.userId)).limit(1);
    if (!row) throw new Error("Claude connection persistence returned no row");
    return row;
  });
}
export const getOrCreateClaudeConnection = (ctx: ClaudeConnectionOwnerContext) => getOrCreateClaudeConnectionWith(getSharedDirectAgentDb(), ctx);

export async function setClaudeConnectionEnabledWith(
  db: ClaudeDb,
  ctx: ClaudeConnectionOwnerContext,
  enabled: boolean,
) {
  await getOrCreateClaudeConnectionWith(db, ctx);
  return scoped(db, ctx, async (tx) => {
    const [row] = await tx.update(claudeConnections).set({ enabled, updatedAt: new Date() })
      .where(eq(claudeConnections.userId, ctx.userId)).returning();
    return row;
  });
}

/** A controller-owned observation; no caller-provided identity/session data crosses this persistence boundary. */
export async function saveClaudeConnectionObservationWith(
  db: ClaudeDb,
  ctx: ClaudeConnectionOwnerContext,
  input: { readonly runtime: ClaudeConnectionRuntime; readonly account: ClaudeConnectionAccount; readonly catalog: ClaudeConnectionCatalog; readonly now?: Date },
) {
  await getOrCreateClaudeConnectionWith(db, ctx);
  return scoped(db, ctx, async (tx) => {
    const [current] = await tx.select().from(claudeConnections).where(eq(claudeConnections.userId, ctx.userId)).limit(1).for("update");
    if (!current) return undefined;
    const [row] = await tx.update(claudeConnections).set({
      runtime: input.runtime,
      account: input.account,
      catalog: input.catalog,
      observationRevision: current.observationRevision + 1,
      selectedModel: input.catalog.state === "complete" && !input.catalog.models.some((model) => (model.resolvedModel ?? model.id) === current.selectedModel) ? null : current.selectedModel,
      observedAt: input.now ?? new Date(),
      updatedAt: input.now ?? new Date(),
    }).where(and(eq(claudeConnections.userId, ctx.userId), eq(claudeConnections.observationRevision, current.observationRevision))).returning();
    return row;
  });
}

/** Select only a canonical resolved-model/id from the exact current complete catalog revision. */
export async function selectClaudeConnectionModelWith(
  db: ClaudeDb,
  ctx: ClaudeConnectionOwnerContext,
  input: { readonly model: string | null; readonly expectedObservationRevision: number },
) {
  return scoped(db, ctx, async (tx) => {
    const [current] = await tx.select().from(claudeConnections).where(eq(claudeConnections.userId, ctx.userId)).limit(1).for("update");
    if (!current || current.observationRevision !== input.expectedObservationRevision) return undefined;
    if (input.model !== null && (current.catalog?.state !== "complete" || !current.catalog.models.some((model) => (model.resolvedModel ?? model.id) === input.model))) return undefined;
    const [row] = await tx.update(claudeConnections).set({ selectedModel: input.model, updatedAt: new Date() })
      .where(and(eq(claudeConnections.userId, ctx.userId), eq(claudeConnections.observationRevision, input.expectedObservationRevision))).returning();
    return row;
  });
}
