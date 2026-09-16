import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import { assertAgentRuntimeGeneration } from "../format/agent-runtime-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frameText,
} from "../format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  type AgentId,
  type AgentRuntimeGeneration,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import type { AgentRuntimeGenerationV2 } from "./types.ts";

export const AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_DOMAIN_V1 =
  "nautilo/lattice-crypto/agent-runtime-object-signer-seed/v1";
export const AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_VERSION_V1 = 1 as const;
export const AGENT_RUNTIME_OBJECT_SIGNER_KEY_ID_PREFIX_V1 =
  "agent_runtime_signer_";

const SIGNER_KEY_ID_PATTERN =
  /^agent_runtime_signer_[0-9a-f]{64}$/;

export interface AgentRuntimeObjectSignerPrincipalV1 {
  readonly kind: "agent_runtime";
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly signerKeyId: string;
}

export interface AgentRuntimeObjectSignerPublicV1 {
  readonly principal: AgentRuntimeObjectSignerPrincipalV1;
  readonly publicKey: Uint8Array;
}

function assertExactFields(
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

function assertFixedBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new TypeError(
      `${label} must be exactly ${expectedLength} bytes`,
    );
  }
  return copyOwnedBytesV2(value);
}

export function normalizeAgentRuntimeObjectSignerPrincipalV1(
  value: AgentRuntimeObjectSignerPrincipalV1,
): AgentRuntimeObjectSignerPrincipalV1 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Agent Runtime signer principal must be an object");
  }
  assertExactFields("Agent Runtime signer principal", value, [
    "kind",
    "agentId",
    "runtimeGeneration",
    "signerKeyId",
  ]);
  if (value.kind !== "agent_runtime") {
    throw new TypeError("Agent Runtime signer principal kind is invalid");
  }
  const normalizedAgentId = agentId(value.agentId);
  const normalizedGeneration = agentRuntimeGeneration(
    value.runtimeGeneration,
  );
  assertPortableId("Agent Runtime signer key id", value.signerKeyId);
  if (!SIGNER_KEY_ID_PATTERN.test(value.signerKeyId)) {
    throw new TypeError("Agent Runtime signer key id is invalid");
  }
  return Object.freeze({
    kind: "agent_runtime",
    agentId: normalizedAgentId,
    runtimeGeneration: normalizedGeneration,
    signerKeyId: value.signerKeyId,
  });
}

function derivationContext(
  runtime: AgentRuntimeGenerationV2,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_DOMAIN_V1),
    encodeU32(AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_VERSION_V1),
    frameText(runtime.agentId),
    encodeU64(runtime.generation),
  );
}

function withDerivedSignerSeed<Value>(
  runtime: AgentRuntimeGenerationV2,
  execute: (seed: Uint8Array) => Value,
): Value {
  assertAgentRuntimeGeneration(runtime);
  const ownedRuntimeKey = copyOwnedBytesV2(runtime.key);
  let context: Uint8Array | undefined;
  let salt: Uint8Array | undefined;
  let seed: Uint8Array | undefined;
  try {
    context = derivationContext(runtime);
    salt = new Uint8Array(0);
    seed = hkdf(
      sha256,
      ownedRuntimeKey,
      salt,
      context,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    return execute(seed);
  } finally {
    seed?.fill(0);
    ownedRuntimeKey.fill(0);
    context?.fill(0);
    salt?.fill(0);
  }
}

export function agentRuntimeObjectSignerKeyIdV1(
  crypto: LatticeCrypto,
  publicKey: Uint8Array,
): string {
  const ownedPublicKey = assertFixedBytes(
    "Agent Runtime object signer public key",
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let digest: Uint8Array | undefined;
  try {
    digest = assertFixedBytes(
      "Agent Runtime object signer public key digest",
      crypto.hash(ownedPublicKey),
      32,
    );
    const keyId = `${AGENT_RUNTIME_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${
      bytesToHex(digest)
    }`;
    assertPortableId("Agent Runtime signer key id", keyId);
    return keyId;
  } finally {
    digest?.fill(0);
    ownedPublicKey.fill(0);
  }
}

export function deriveAgentRuntimeObjectSignerPublicV1(
  crypto: LatticeCrypto,
  runtime: AgentRuntimeGenerationV2,
): AgentRuntimeObjectSignerPublicV1 {
  return withDerivedSignerSeed(runtime, (seed) => {
    const publicKey = assertFixedBytes(
      "Agent Runtime object signer public key",
      ed25519.getPublicKey(seed),
      V2_LIMITS.signingPublicKeyBytes,
    );
    const principal = Object.freeze({
      kind: "agent_runtime" as const,
      agentId: agentId(runtime.agentId),
      runtimeGeneration: agentRuntimeGeneration(runtime.generation),
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, publicKey),
    });
    return Object.freeze({
      principal,
      publicKey,
    });
  });
}

export function signAgentRuntimeObjectBytesV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly runtime: AgentRuntimeGenerationV2;
    readonly signer: AgentRuntimeObjectSignerPrincipalV1;
    readonly message: Uint8Array;
  }>,
): Uint8Array {
  const signer = normalizeAgentRuntimeObjectSignerPrincipalV1(input.signer);
  assertAgentRuntimeGeneration(input.runtime);
  if (signer.agentId !== input.runtime.agentId) {
    throw new TypeError(
      "Agent Runtime object signer Agent does not match the Runtime",
    );
  }
  if (signer.runtimeGeneration !== input.runtime.generation) {
    throw new TypeError(
      "Agent Runtime object signer Runtime generation does not match",
    );
  }
  const message = copyOwnedBytesV2(input.message);
  try {
    return withDerivedSignerSeed(input.runtime, (seed) => {
      const publicKey = assertFixedBytes(
        "Agent Runtime object signer public key",
        ed25519.getPublicKey(seed),
        V2_LIMITS.signingPublicKeyBytes,
      );
      try {
        const derivedKeyId = agentRuntimeObjectSignerKeyIdV1(
          crypto,
          publicKey,
        );
        if (signer.signerKeyId !== derivedKeyId) {
          throw new TypeError(
            "Agent Runtime object signer key id does not match the Runtime key",
          );
        }
        return assertFixedBytes(
          "Agent Runtime object signature",
          crypto.sign(seed, message),
          V2_LIMITS.signatureBytes,
        );
      } finally {
        publicKey.fill(0);
      }
    });
  } finally {
    message.fill(0);
  }
}
