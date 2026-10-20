import { AsyncLocalStorage } from "node:async_hooks";
import {
  ClassifiedDataOperationError,
  type StrictShadowEnforcementPolicy,
} from "@nautilo/lattice-bridge";
import type { CreateTaskDeps, ProtectedTaskCreationPlanV1 } from "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { PostgresJsBridgeExecutor } from "@nautilo/db";
import type { TaskToolRuntime } from "@nautilo/agent";
import type { ProtectedTaskForegroundUpdatePreflight } from "./protected-task-foreground-update-publication";

type Create = CreateTaskDeps<ProtectedTaskCreationPlanV1>;
export type ProtectedTaskForegroundCreationContext = Readonly<{
  admission: Create["admission"];
  publishProtected(input: Parameters<NonNullable<Create["publishProtected"]>>[0] &
    Readonly<{ transaction: CanonicalTranscriptTx; executor: PostgresJsBridgeExecutor; operationId: string }>): ReturnType<NonNullable<Create["publishProtected"]>>;
  assertCurrent(): Promise<void>;
  preflightProtectedTaskUpdate(input: Readonly<{ operationId: string;
    request: Parameters<NonNullable<TaskToolRuntime["updateProtectedTask"]>>[0] }>):
    Promise<ProtectedTaskForegroundUpdatePreflight>;
  updateProtectedTask(input: Readonly<{ operationId: string;
    request: Parameters<NonNullable<TaskToolRuntime["updateProtectedTask"]>>[0];
    preflight: ProtectedTaskForegroundUpdatePreflight }>):
    ReturnType<NonNullable<TaskToolRuntime["updateProtectedTask"]>>;
  readHeldPolicy?(): Promise<StrictShadowEnforcementPolicy | null>;
  withTaskDefinitionAuthorization<Value>(input: Readonly<{
    taskId: string;
    taskExecutorAgentId: string;
    operation: "create" | "update";
    targetContentRevision: number;
    operationId: string;
    workDescriptorDigest: Uint8Array;
    use(): Promise<Value>;
  }>): Promise<Value>;
  withProduct<Value>(input: Readonly<{ taskId: string; transaction: CanonicalTranscriptTx; executor: PostgresJsBridgeExecutor;
    use(): Promise<Value> }>): Promise<Value>;
}>;
const current = new AsyncLocalStorage<Readonly<{ active(): boolean; source: ProtectedTaskForegroundCreationContext }>>();
function unavailable(): never {
  throw new ClassifiedDataOperationError("authority", "Protected Task creation foreground scope closed");
}

/** One real foreground turn lends creation ports; asynchronous escapes lose authority. */
export async function withProtectedTaskForegroundCreationContext<Value>(
  source: ProtectedTaskForegroundCreationContext,
  use: () => Promise<Value>,
): Promise<Value> {
  let active = true;
  const assertCurrent = async () => {
    if (!active) unavailable();
    await source.assertCurrent();
    if (!active) unavailable();
  };
  const scoped: ProtectedTaskForegroundCreationContext = Object.freeze({
    assertCurrent,
    admission: Object.freeze({ admit: async (input: Parameters<Create["admission"]["admit"]>[0]) => {
      await assertCurrent();
      const result = await source.admission.admit(input);
      await assertCurrent();
      return result;
    } }),
    publishProtected: async input => {
      await assertCurrent();
      const result = await source.publishProtected(input);
      await assertCurrent();
      return result;
    },
    preflightProtectedTaskUpdate: async input => {
      await assertCurrent();
      const result = await source.preflightProtectedTaskUpdate(input);
      await assertCurrent();
      return result;
    },
    updateProtectedTask: async input => {
      await assertCurrent();
      const result = await source.updateProtectedTask(input);
      await assertCurrent();
      return result;
    },
    ...(source.readHeldPolicy === undefined ? {} : {
      readHeldPolicy: async () => {
        if (!active) unavailable();
        const result = await source.readHeldPolicy?.();
        if (!active) unavailable();
        return result ?? null;
      },
    }),
    withTaskDefinitionAuthorization: async input => {
      await assertCurrent();
      const result = await source.withTaskDefinitionAuthorization({
        ...input,
        use: async () => {
          if (!active) unavailable();
          const value = await input.use();
          if (!active) unavailable();
          return value;
        },
      });
      await assertCurrent();
      return result;
    },
    withProduct: async input => {
      await assertCurrent();
      const result = await source.withProduct({ ...input, use: async () => {
        if (!active) unavailable();
        const value = await input.use();
        if (!active) unavailable();
        return value;
      } });
      // The source has revalidated on its borrowed transaction before closing
      // that loan. Opening a second product transaction here would recurse on
      // locks still held by the caller's pending outer commit.
      if (!active) unavailable();
      return result;
    },
  });
  try { return await current.run({ active: () => active, source: scoped }, use); }
  finally { active = false; }
}

export function currentProtectedTaskForegroundCreationContext(): ProtectedTaskForegroundCreationContext | null {
  const value = current.getStore();
  return value?.active() === true ? value.source : null;
}

export async function readProtectedTaskForegroundCreationPolicy(
  fallback: () => Promise<StrictShadowEnforcementPolicy>,
): Promise<StrictShadowEnforcementPolicy> {
  const value = current.getStore();
  if (value === undefined) return fallback();
  if (!value.active()) unavailable();
  const held = await value.source.readHeldPolicy?.();
  if (!value.active()) unavailable();
  if (held !== undefined && held !== null) return held;
  const policy = await fallback();
  if (!value.active()) unavailable();
  return policy;
}
