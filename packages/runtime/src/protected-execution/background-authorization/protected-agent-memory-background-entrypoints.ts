import type {
  BackgroundAuthorizationRecord,
  BackgroundAuthorizationRepository,
} from "./repository";
import type {
  ProtectedAgentMemoryBackgroundCoordinator,
} from "./protected-agent-memory-background";

const ENTRYPOINT_IDS = Object.freeze([
  "memory.review.main",
  "memory.review.fork",
  "memory.exit_flush",
] as const);

export type ProtectedAgentMemoryBackgroundEntrypointId =
  (typeof ENTRYPOINT_IDS)[number];

export type ProtectedAgentMemoryBackgroundEntrypointInput = Readonly<{
  entrypointId: ProtectedAgentMemoryBackgroundEntrypointId;
  transcriptThreadId: string;
  roomId: string;
  agentId: string;
}>;

export type ProtectedAgentMemoryBackgroundEnqueueResult =
  | Readonly<{
      status: "authorization_required";
      requestId: string;
      descriptorBytes: Uint8Array;
      descriptorHash: Uint8Array;
    }>
  | Readonly<{ status: "pending" | "missing" | "stale" | "skipped" }>;

export interface ProtectedAgentMemoryBackgroundRequestPlanner {
  /**
   * Resolve current product coordinates and build one content-free v2 request.
   * The input deliberately has no messages, prompt, plaintext, or vectors.
   */
  plan(
    input: ProtectedAgentMemoryBackgroundEntrypointInput,
  ): Promise<BackgroundAuthorizationRecord | null>;
}

const testAuthorityBrand: unique symbol = Symbol(
  "protected-agent-memory-background-entrypoint-test-authority",
);
export type ProtectedAgentMemoryBackgroundEntrypointTestAuthority = Readonly<{
  [testAuthorityBrand]: true;
}>;

const compositionBrand: unique symbol = Symbol(
  "protected-agent-memory-background-entrypoint-composition",
);
export type ProtectedAgentMemoryBackgroundEntrypointComposition = Readonly<{
  enqueue(
    input: ProtectedAgentMemoryBackgroundEntrypointInput,
  ): Promise<ProtectedAgentMemoryBackgroundEnqueueResult>;
  [compositionBrand]: true;
}>;

const recognizedAuthorities = new WeakSet<object>();
const recognizedCompositions = new WeakSet<object>();
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function normalizeInput(
  input: ProtectedAgentMemoryBackgroundEntrypointInput,
): ProtectedAgentMemoryBackgroundEntrypointInput {
  if (!ENTRYPOINT_IDS.includes(input.entrypointId)) {
    throw new TypeError("Unsupported protected Memory background entrypoint");
  }
  for (const [field, value] of Object.entries({
    transcriptThreadId: input.transcriptThreadId,
    roomId: input.roomId,
    agentId: input.agentId,
  })) {
    if (!PORTABLE_ID.test(value)) {
      throw new TypeError(`Invalid protected Memory background ${field}`);
    }
  }
  return Object.freeze({
    entrypointId: input.entrypointId,
    transcriptThreadId: input.transcriptThreadId,
    roomId: input.roomId,
    agentId: input.agentId,
  });
}

function expectedWorkKind(
  entrypointId: ProtectedAgentMemoryBackgroundEntrypointId,
): "memory.review" | "memory.exit_flush" {
  return entrypointId === "memory.exit_flush"
    ? "memory.exit_flush"
    : "memory.review";
}

function assertPlannedRecord(
  record: BackgroundAuthorizationRecord,
  input: ProtectedAgentMemoryBackgroundEntrypointInput,
): void {
  const expected = expectedWorkKind(input.entrypointId);
  if (
    record.snapshot.formatVersion !== 2
    || record.snapshot.credentialSubject.kind !== "agent"
    || record.snapshot.credentialSubject.agentId !== input.agentId
    || record.workKind !== expected
    || record.purpose !== expected
    || record.descriptorBytes !== null
    || record.acceptedMaterial !== null
    || record.finishedAt !== null
    || record.snapshot.state !== "awaiting_recipient"
  ) {
    throw new TypeError(
      "Protected Memory background plan does not match its exact entrypoint",
    );
  }
}

/**
 * Build one explicit nonproduction entrypoint composition. It is unavailable
 * to environment/config/serialized input and does not register a scheduler.
 */
export function createProtectedAgentMemoryBackgroundEntrypointTestComposition(
  input: Readonly<{
    authority: ProtectedAgentMemoryBackgroundEntrypointTestAuthority;
    repository: BackgroundAuthorizationRepository;
    planner: ProtectedAgentMemoryBackgroundRequestPlanner;
    coordinator: ProtectedAgentMemoryBackgroundCoordinator;
  }>,
): ProtectedAgentMemoryBackgroundEntrypointComposition {
  if (!recognizedAuthorities.has(input.authority)) {
    throw new TypeError(
      "Protected Memory background entrypoints require recognized test authority",
    );
  }
  const composition = Object.freeze({
    async enqueue(
      raw: ProtectedAgentMemoryBackgroundEntrypointInput,
    ): Promise<ProtectedAgentMemoryBackgroundEnqueueResult> {
      const request = normalizeInput(raw);
      const planned = await input.planner.plan(request);
      if (planned === null) return Object.freeze({ status: "skipped" as const });
      assertPlannedRecord(planned, request);
      await input.repository.create(planned);
      const prepared = await input.coordinator.prepare(
        planned.snapshot.requestId,
      );
      return prepared.status === "authorization_required"
        ? Object.freeze({
            status: prepared.status,
            requestId: planned.snapshot.requestId,
            descriptorBytes: prepared.descriptorBytes.slice(),
            descriptorHash: prepared.descriptorHash.slice(),
          })
        : Object.freeze({ status: prepared.status });
    },
    [compositionBrand]: true as const,
  });
  recognizedCompositions.add(composition);
  return composition;
}

export function enqueueProtectedAgentMemoryBackgroundEntrypoint(
  composition: ProtectedAgentMemoryBackgroundEntrypointComposition,
  input: ProtectedAgentMemoryBackgroundEntrypointInput,
): Promise<ProtectedAgentMemoryBackgroundEnqueueResult> {
  if (!recognizedCompositions.has(composition)) {
    throw new TypeError(
      "Expected a recognized protected Memory background composition",
    );
  }
  return composition.enqueue(input);
}

/** Explicit protected exit-flush entrypoint for nonproduction composition. */
export function enqueueProtectedAgentMemoryExitFlush(
  composition: ProtectedAgentMemoryBackgroundEntrypointComposition,
  input: Readonly<{
    transcriptThreadId: string;
    roomId: string;
    agentId: string;
  }>,
): Promise<ProtectedAgentMemoryBackgroundEnqueueResult> {
  return enqueueProtectedAgentMemoryBackgroundEntrypoint(composition, {
    entrypointId: "memory.exit_flush",
    ...input,
  });
}

/** Deep-module test mint; intentionally omitted from the package root. */
export function __mintProtectedAgentMemoryBackgroundEntrypointTestAuthority():
  ProtectedAgentMemoryBackgroundEntrypointTestAuthority {
  const authority = Object.freeze({ [testAuthorityBrand]: true as const });
  recognizedAuthorities.add(authority);
  return authority;
}
