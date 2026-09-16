import type {
  AgentRuntimeSignerPublication,
  HistoricalAgentRuntimeSignerPublicationManagerContext,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  verifyHistoricalAgentRuntimeSignerPublication,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";

export class AgentRuntimeSignerHistoryUnavailableError extends Error {
  readonly code = "agent_runtime_signer_history_unavailable" as const;

  constructor(cause: unknown) {
    super("Agent Runtime signer history is unavailable", { cause });
    this.name = "AgentRuntimeSignerHistoryUnavailableError";
  }
}

export class AgentRuntimeSignerHistoryInvalidError extends Error {
  readonly code = "agent_runtime_signer_history_invalid" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentRuntimeSignerHistoryInvalidError";
  }
}

export interface HistoricalAgentRuntimeSignerManagerAuthority
  extends HistoricalAgentRuntimeSignerPublicationManagerContext {
  readonly managerSigningPublicKey: Uint8Array;
}

export type ResolveHistoricalAgentRuntimeSignerManagerAuthority = (
  context: HistoricalAgentRuntimeSignerPublicationManagerContext,
) =>
  | HistoricalAgentRuntimeSignerManagerAuthority
  | null
  | Promise<HistoricalAgentRuntimeSignerManagerAuthority | null>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactFields(value: unknown, expected: readonly string[]): boolean {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((field) => actual.includes(field));
}

function contextFromPublication(
  publication: AgentRuntimeSignerPublication,
): HistoricalAgentRuntimeSignerPublicationManagerContext {
  return Object.freeze({
    purpose: "verify-historical-agent-runtime-signer-publication" as const,
    formatVersion: publication.formatVersion,
    transitionKind: publication.transitionKind,
    operationId: publication.operationId,
    agentId: publication.agentId,
    authorizationRevision: publication.authorizationRevision,
    runtimeGeneration: publication.runtimeGeneration,
    signerKeyId: publication.signerKeyId,
    signerPublicKey: publication.signerPublicKey.slice(),
    transitionCommitment: publication.transitionCommitment.slice(),
    managerHumanId: publication.managerHumanId,
    managerAuthorizationRevision:
      publication.managerAuthorizationRevision,
    managerDeviceId: publication.managerDeviceId,
    managerSigningPublicKeyHash:
      publication.managerSigningPublicKeyHash.slice(),
  });
}

function authorityMatchesContext(
  authority: HistoricalAgentRuntimeSignerManagerAuthority,
  expected: HistoricalAgentRuntimeSignerPublicationManagerContext,
): boolean {
  return exactFields(authority, [
    "purpose",
    "formatVersion",
    "transitionKind",
    "operationId",
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
    "signerKeyId",
    "signerPublicKey",
    "transitionCommitment",
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
    "managerSigningPublicKeyHash",
    "managerSigningPublicKey",
  ])
    && authority.purpose === expected.purpose
    && authority.formatVersion === expected.formatVersion
    && authority.transitionKind === expected.transitionKind
    && authority.operationId === expected.operationId
    && authority.agentId === expected.agentId
    && authority.authorizationRevision === expected.authorizationRevision
    && authority.runtimeGeneration === expected.runtimeGeneration
    && authority.signerKeyId === expected.signerKeyId
    && authority.signerPublicKey instanceof Uint8Array
    && bytesEqual(authority.signerPublicKey, expected.signerPublicKey)
    && authority.transitionCommitment instanceof Uint8Array
    && bytesEqual(
      authority.transitionCommitment,
      expected.transitionCommitment,
    )
    && authority.managerHumanId === expected.managerHumanId
    && authority.managerAuthorizationRevision
      === expected.managerAuthorizationRevision
    && authority.managerDeviceId === expected.managerDeviceId
    && authority.managerSigningPublicKeyHash instanceof Uint8Array
    && bytesEqual(
      authority.managerSigningPublicKeyHash,
      expected.managerSigningPublicKeyHash,
    )
    && authority.managerSigningPublicKey instanceof Uint8Array;
}

/**
 * Authenticates one stored Agent signer publication against immutable
 * Human-device authority selected by its complete signed historical tuple.
 *
 * The supplied resolver must read retained authenticated history, not infer
 * authority from today's mutable device state.
 */
export async function authenticateHistoricalAgentRuntimeSignerPublication(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly publication: AgentRuntimeSignerPublication;
    readonly resolveHistoricalManagerAuthority:
      ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  }>,
): Promise<AgentRuntimeSignerPublication> {
  let publication: AgentRuntimeSignerPublication;
  try {
    publication = decodeAgentRuntimeSignerPublicationV1(
      encodeAgentRuntimeSignerPublicationV1(input.publication),
    );
  } catch (cause) {
    throw new AgentRuntimeSignerHistoryInvalidError(
      "Agent Runtime signer publication is not canonical",
      cause,
    );
  }
  const requestedContext = contextFromPublication(publication);
  let resolved: HistoricalAgentRuntimeSignerManagerAuthority | null;
  try {
    resolved = await input.resolveHistoricalManagerAuthority(
      requestedContext,
    );
  } catch (cause) {
    if (cause instanceof AgentRuntimeSignerHistoryUnavailableError) {
      throw cause;
    }
    throw new AgentRuntimeSignerHistoryUnavailableError(cause);
  }
  const verificationContext = contextFromPublication(publication);
  if (
    resolved === null
    || !authorityMatchesContext(resolved, verificationContext)
  ) {
    throw new AgentRuntimeSignerHistoryInvalidError(
      "Agent Runtime signer publication has no exact historical manager authority",
    );
  }
  let authentic: boolean;
  try {
    authentic = verifyHistoricalAgentRuntimeSignerPublication({
      crypto: input.crypto,
      publication,
      resolveHistoricalManagerAuthority: (context) =>
        authorityMatchesContext(resolved, context)
          ? resolved.managerSigningPublicKey
          : null,
    });
  } catch (cause) {
    throw new AgentRuntimeSignerHistoryInvalidError(
      "Agent Runtime signer publication verification failed",
      cause,
    );
  }
  if (!authentic) {
    throw new AgentRuntimeSignerHistoryInvalidError(
      "Agent Runtime signer publication signature is invalid",
    );
  }
  return decodeAgentRuntimeSignerPublicationV1(
    encodeAgentRuntimeSignerPublicationV1(publication),
  );
}
