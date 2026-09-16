import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  AgentRuntimeSignerPublicationV1,
  AgentRuntimeSignerPublicationTransitionKindV1,
} from "../agent-runtime/signer-publication-v1.ts";
import type {
  AgentRuntimeRotationStateV2,
} from "../agent-runtime/runtime-rotation-v2.ts";
import {
  cryptoDeviceId,
  humanId,
} from "../v2-types/ids.ts";

/** Structurally canonical public evidence for storage-adapter contract tests. */
export function agentRuntimeSignerPublicationForTesting(input: Readonly<{
  readonly state: AgentRuntimeRotationStateV2;
  readonly transitionKind: AgentRuntimeSignerPublicationTransitionKindV1;
  readonly operationId?: string;
}>): AgentRuntimeSignerPublicationV1 {
  const coordinate = new TextEncoder().encode(
    `${input.state.agentId}\0${String(input.state.runtimeGeneration)}`,
  );
  const digest = sha256(coordinate);
  return Object.freeze({
    formatVersion: 1,
    transitionKind: input.transitionKind,
    operationId: input.operationId
      ?? `operation-test-signer-${String(input.state.runtimeGeneration)}`,
    agentId: input.state.agentId,
    authorizationRevision: input.state.authorizationRevision,
    runtimeGeneration: input.state.runtimeGeneration,
    signerKeyId: `agent_runtime_signer_${bytesToHex(digest)}`,
    signerPublicKey: digest.slice(),
    transitionCommitment: sha256(
      new Uint8Array([...coordinate, 0x01]),
    ),
    managerHumanId: humanId(
      "00000000-0000-4000-8000-00000000000a",
    ),
    managerAuthorizationRevision: input.state.authorizationRevision,
    managerDeviceId: cryptoDeviceId("device-test-runtime-manager"),
    managerSigningPublicKeyHash: sha256(
      new Uint8Array([...coordinate, 0x02]),
    ),
    signature: new Uint8Array(64).fill(0x73),
  });
}
