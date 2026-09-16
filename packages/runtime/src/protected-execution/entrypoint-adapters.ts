import {
  type ProtectedExecutionBinding,
  type ProtectedExecutionDurableCoordinates,
  type ProtectedExecutionDurableSnapshot,
  type ProtectedExecutionEntrypointId,
  type ProtectedExecutionHandle,
  type ProtectedExecutionOperation,
  PROTECTED_EXECUTION_PATH_FAMILIES,
  type ProtectedExecutionPathFamily,
  type ProtectedExecutionRunResult,
  ProtectedExecutionBroker,
} from "./broker";
import type { ProtectedInvocationCapability } from "./lease-registry";

export {
  PROTECTED_EXECUTION_PATH_FAMILIES,
  type ProtectedExecutionPathFamily,
};

export type ProtectedExecutionAdapterDefinition = Readonly<{
  readonly entrypointId: ProtectedExecutionEntrypointId;
  readonly family: ProtectedExecutionPathFamily;
}>;

export const PROTECTED_EXECUTION_ADAPTERS = Object.freeze([
  { entrypointId: "foreground.conductor", family: "foreground" },
  { entrypointId: "foreground.main", family: "foreground" },
  { entrypointId: "foreground.fork", family: "fork" },
  { entrypointId: "resume.approval", family: "approval_resume" },
  { entrypointId: "resume.approval_ask", family: "approval_resume" },
  { entrypointId: "resume.identity", family: "identity_resume" },
  { entrypointId: "resume.await_reply", family: "await_reply_resume" },
  { entrypointId: "task.dispatch", family: "task" },
  { entrypointId: "task.execute", family: "task" },
  { entrypointId: "task.approval_resume", family: "task" },
  { entrypointId: "subagent.scope", family: "subagent" },
  { entrypointId: "compaction.model", family: "compaction" },
  { entrypointId: "stenographer.extraction", family: "stenographer" },
  { entrypointId: "stenographer.compaction", family: "stenographer" },
  { entrypointId: "memory.review", family: "memory" },
  { entrypointId: "memory.exit_flush", family: "memory" },
  { entrypointId: "artifact.read", family: "artifact" },
  { entrypointId: "artifact.write", family: "artifact" },
] as const satisfies readonly ProtectedExecutionAdapterDefinition[]);

const definitions = new Map(
  PROTECTED_EXECUTION_ADAPTERS.map((definition) => [
    definition.entrypointId,
    definition,
  ]),
);

export interface ProtectedExecutionAdapter {
  readonly entrypointId: ProtectedExecutionEntrypointId;
  readonly family: ProtectedExecutionPathFamily;
  readonly bind: (input: Readonly<{
    readonly coordinates: ProtectedExecutionDurableCoordinates;
    readonly capability: ProtectedInvocationCapability;
    readonly executionDeadline?: number;
    readonly parent?: ProtectedExecutionHandle;
  }>) => ProtectedExecutionBinding;
  readonly execute: <Value>(
    handle: ProtectedExecutionHandle,
    operation: ProtectedExecutionOperation,
    execute: (plaintext: Uint8Array) => Value | PromiseLike<Value>,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ) => Promise<ProtectedExecutionRunResult<Value>>;
  readonly snapshot: (
    handle: ProtectedExecutionHandle,
  ) => ProtectedExecutionDurableSnapshot | null;
  readonly release: (handle: ProtectedExecutionHandle) => boolean;
}

/**
 * The path adapter deliberately contains no custody or crypto logic. It only
 * fixes the audited entrypoint/family identity and delegates to one broker.
 */
export function createProtectedExecutionAdapter(
  broker: ProtectedExecutionBroker,
  entrypointId: ProtectedExecutionEntrypointId,
): ProtectedExecutionAdapter {
  const definition = definitions.get(entrypointId);
  if (definition === undefined) {
    throw new TypeError("Protected execution entrypoint is not registered");
  }
  const adapter: ProtectedExecutionAdapter = {
    entrypointId,
    family: definition.family,
    bind: (input: Parameters<ProtectedExecutionAdapter["bind"]>[0]) =>
      broker.bind({
        ...input,
        entrypointId,
        family: definition.family,
      }),
    execute: <Value>(
      handle: ProtectedExecutionHandle,
      operation: ProtectedExecutionOperation,
      execute: (plaintext: Uint8Array) => Value | PromiseLike<Value>,
      options: Readonly<{ readonly signal?: AbortSignal }> = {},
    ) => broker.execute(handle, operation, execute, options),
    snapshot: (handle: ProtectedExecutionHandle) => broker.snapshot(handle),
    release: (handle: ProtectedExecutionHandle) => broker.release(handle),
  };
  return Object.freeze(adapter);
}

export type SyntheticProtectedTaskAuthorizationState =
  | "awaiting_device_grant"
  | "grant_ready"
  | "running"
  | "grant_expired"
  | "blocked_key_unavailable"
  | "terminal";

/**
 * Synthetic-only Wave 8 state machine. It intentionally does not reuse or
 * alter the product Task/Task-run status vocabulary.
 */
export class SyntheticProtectedTaskAuthorization {
  readonly #runId: string;
  #state: SyntheticProtectedTaskAuthorizationState =
    "awaiting_device_grant";

  constructor(runId: string) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new TypeError("Synthetic protected Task run id is required");
    }
    this.#runId = runId;
  }

  grantReady(): SyntheticProtectedTaskAuthorizationState {
    if (this.#state !== "awaiting_device_grant") return this.#state;
    return this.#set("grant_ready");
  }

  start(): SyntheticProtectedTaskAuthorizationState {
    if (this.#state !== "grant_ready") return this.#state;
    return this.#set("running");
  }

  complete(): SyntheticProtectedTaskAuthorizationState {
    if (this.#state !== "running") return this.#state;
    return this.#set("terminal");
  }

  recur(): SyntheticProtectedTaskAuthorizationState {
    if (this.#state !== "terminal") return this.#state;
    return this.#set("awaiting_device_grant");
  }

  expire(): SyntheticProtectedTaskAuthorizationState {
    if (this.#state !== "grant_ready") return this.#state;
    return this.#set("grant_expired");
  }

  restart(): SyntheticProtectedTaskAuthorizationState {
    if (this.#state !== "grant_ready" && this.#state !== "running") {
      return this.#state;
    }
    return this.#set("blocked_key_unavailable");
  }

  requestFreshGrant(): SyntheticProtectedTaskAuthorizationState {
    if (
      this.#state !== "grant_expired"
      && this.#state !== "blocked_key_unavailable"
    ) {
      return this.#state;
    }
    return this.#set("awaiting_device_grant");
  }

  snapshot(): Readonly<{
    readonly formatVersion: 1;
    readonly runId: string;
    readonly state: SyntheticProtectedTaskAuthorizationState;
  }> {
    return Object.freeze({
      formatVersion: 1,
      runId: this.#runId,
      state: this.#state,
    });
  }

  #set(
    state: SyntheticProtectedTaskAuthorizationState,
  ): SyntheticProtectedTaskAuthorizationState {
    this.#state = state;
    return state;
  }
}
