import { bytesToHex } from "@noble/hashes/utils.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  agentRuntimeDomainEnvelopeSigningBytes,
  assertAgentRuntimeDomainEnvelope,
  assertAgentRuntimeGeneration,
  decodeAgentRuntimeGeneration,
  encodeAgentRuntimeGeneration,
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../format/agent-runtime-v2.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  type StrictDecoder,
} from "../format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";
import {
  copyOwnedBytesV2,
  opaqueBytes,
  type OpaqueBytes,
} from "../v2-types/opaque.ts";
import {
  openAgentRuntimeFromDomain,
  sealAgentRuntimeToDomain,
} from "./domain-envelope.ts";
import type {
  AgentRuntimeDomainEnvelopeV1,
  AgentRuntimeGenerationV2,
  HistoricalAgentRuntimeCommitterResolverV1,
} from "./types.ts";
import { AGENT_RUNTIME_KEY_BYTES } from "./types.ts";

export const AGENT_RUNTIME_HANDOFF_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-handoff/v1";
const CHALLENGE_KIND = "challenge";
const RESPONSE_KIND = "response";
const SECRET_KIND = "secret";
const AUTHORITY_KIND = "authority-proof";
const FORMAT_VERSION = 1;
const CHALLENGE_NONCE_BYTES = 32;
const HASH_BYTES = 32;

export interface AgentRuntimeHandoffDomainContextV1 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly committerDeviceId: CryptoDeviceId;
}

export interface AgentRuntimeHandoffPlanV1 {
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly source: AgentRuntimeHandoffDomainContextV1;
  readonly target: AgentRuntimeHandoffDomainContextV1;
}

export interface AgentRuntimeHandoffAuthorityContextV1
  extends AgentRuntimeHandoffDomainContextV1 {
  readonly purpose: "agent-runtime-handoff";
  readonly role: "source" | "target";
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly counterpartyDomainId: CryptoDomainId;
  readonly counterpartyDeviceId: CryptoDeviceId;
}

export type CurrentAgentRuntimeHandoffCommitterResolverV1 = (
  context: AgentRuntimeHandoffAuthorityContextV1,
) => Uint8Array | null;

/**
 * Snapshot of device-protected challenge state. The later coordinator must
 * obtain this from trusted local state, never from the opaque relay payload.
 * Preparation remains write-free: its returned CAS intent is what atomically
 * advances `consumed` from false to true when the target envelope is applied.
 */
export interface TrustedAgentRuntimeHandoffChallengeStateV1 {
  readonly challengeHash: Uint8Array;
  readonly consumed: boolean;
}

export interface PreparedAgentRuntimeHandoffChallengeV1 {
  readonly challengeBytes: Uint8Array;
  readonly challengeHash: Uint8Array;
}

export interface PreparedAgentRuntimeHandoffTargetV1 {
  readonly targetEnvelope: AgentRuntimeDomainEnvelopeV1;
  readonly challengeConsumption: {
    readonly challengeHash: Uint8Array;
    readonly expectedConsumed: false;
    readonly intendedConsumed: true;
  };
}

interface RuntimeHandoffChallengeV1 {
  readonly plan: AgentRuntimeHandoffPlanV1;
  readonly nonce: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly targetEphemeralPublicKey: Uint8Array;
  readonly targetSignature: Uint8Array;
}

interface RuntimeHandoffResponseV1 {
  readonly challengeHash: Uint8Array;
  readonly sealedRuntime: Uint8Array;
  readonly sourceSignature: Uint8Array;
}

function assertBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

function validateDomainContext(
  context: AgentRuntimeHandoffDomainContextV1,
): AgentRuntimeHandoffDomainContextV1 {
  if (typeof context !== "object" || context === null) {
    throw new TypeError("Agent Runtime handoff Domain context must be an object");
  }
  assertExactManagerFields("Agent Runtime handoff Domain context", context, [
    "domainId",
    "domainEpoch",
    "agentAuthorizationRevision",
    "committerDeviceId",
  ]);
  return Object.freeze({
    domainId: cryptoDomainId(context.domainId),
    domainEpoch: domainEpoch(context.domainEpoch),
    agentAuthorizationRevision: authorizationRevision(
      context.agentAuthorizationRevision,
    ),
    committerDeviceId: cryptoDeviceId(context.committerDeviceId),
  });
}

function validatePlan(
  plan: AgentRuntimeHandoffPlanV1,
): AgentRuntimeHandoffPlanV1 {
  if (typeof plan !== "object" || plan === null) {
    throw new TypeError("Agent Runtime handoff plan must be an object");
  }
  assertPortableId("Agent Runtime handoff operation id", plan.operationId);
  const checked = Object.freeze({
    operationId: plan.operationId,
    agentId: agentId(plan.agentId),
    runtimeGeneration: agentRuntimeGeneration(plan.runtimeGeneration),
    source: validateDomainContext(plan.source),
    target: validateDomainContext(plan.target),
  });
  if (checked.source.domainId === checked.target.domainId) {
    throw new Error("Agent Runtime handoff requires distinct source and target Domains");
  }
  if (
    checked.source.committerDeviceId === checked.target.committerDeviceId
  ) {
    throw new Error("Agent Runtime handoff requires separate source and target devices");
  }
  return checked;
}

function domainContextBytes(
  context: AgentRuntimeHandoffDomainContextV1,
): Uint8Array {
  return concatV2(
    frameText(context.domainId),
    encodeU64(context.domainEpoch),
    encodeU64(context.agentAuthorizationRevision),
    frameText(context.committerDeviceId),
  );
}

function planBytes(plan: AgentRuntimeHandoffPlanV1): Uint8Array {
  return concatV2(
    frameText(plan.operationId),
    frameText(plan.agentId),
    encodeU64(plan.runtimeGeneration),
    domainContextBytes(plan.source),
    domainContextBytes(plan.target),
  );
}

function readDomainContext(
  reader: StrictDecoder,
): AgentRuntimeHandoffDomainContextV1 {
  return validateDomainContext({
    domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
    domainEpoch: domainEpoch(reader.readU64()),
    agentAuthorizationRevision: authorizationRevision(reader.readU64()),
    committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
  });
}

function readPlan(reader: StrictDecoder): AgentRuntimeHandoffPlanV1 {
  return validatePlan({
    operationId: reader.readText(V2_LIMITS.idBytes),
    agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
    runtimeGeneration: agentRuntimeGeneration(reader.readU64()),
    source: readDomainContext(reader),
    target: readDomainContext(reader),
  });
}

function challengeSigningBytes(
  challenge: Omit<RuntimeHandoffChallengeV1, "targetSignature">,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_HANDOFF_DOMAIN),
    frameText(CHALLENGE_KIND),
    encodeU32(FORMAT_VERSION),
    planBytes(challenge.plan),
    frame(challenge.nonce),
    encodeU64(challenge.createdAt),
    encodeU64(challenge.expiresAt),
    frame(challenge.targetEphemeralPublicKey),
  );
}

function serializeChallenge(challenge: RuntimeHandoffChallengeV1): Uint8Array {
  return concatV2(
    challengeSigningBytes(challenge),
    frame(challenge.targetSignature),
  );
}

function parseChallenge(bytes: Uint8Array): RuntimeHandoffChallengeV1 {
  return decodeExact(bytes, (reader) => {
    if (reader.readText(AGENT_RUNTIME_HANDOFF_DOMAIN.length)
      !== AGENT_RUNTIME_HANDOFF_DOMAIN) {
      throw new Error("invalid Agent Runtime handoff domain");
    }
    if (reader.readText(CHALLENGE_KIND.length) !== CHALLENGE_KIND) {
      throw new Error("invalid Agent Runtime handoff challenge kind");
    }
    reader.readVersion(FORMAT_VERSION);
    const plan = readPlan(reader);
    const nonce = reader.readFrame(CHALLENGE_NONCE_BYTES);
    assertBytes("Agent Runtime handoff challenge nonce", nonce, CHALLENGE_NONCE_BYTES);
    const createdAt = reader.readU64();
    const expiresAt = reader.readU64();
    const targetEphemeralPublicKey = reader.readFrame(
      V2_LIMITS.hpkePublicKeyBytes,
    );
    assertBytes(
      "Target ephemeral public key",
      targetEphemeralPublicKey,
      V2_LIMITS.hpkePublicKeyBytes,
    );
    const targetSignature = reader.readFrame(V2_LIMITS.signatureBytes);
    assertBytes(
      "Target handoff signature",
      targetSignature,
      V2_LIMITS.signatureBytes,
    );
    return {
      plan,
      nonce,
      createdAt,
      expiresAt,
      targetEphemeralPublicKey,
      targetSignature,
    };
  });
}

function responseSigningBytes(
  response: Omit<RuntimeHandoffResponseV1, "sourceSignature">,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_HANDOFF_DOMAIN),
    frameText(RESPONSE_KIND),
    encodeU32(FORMAT_VERSION),
    frame(response.challengeHash),
    frame(response.sealedRuntime),
  );
}

function serializeResponse(response: RuntimeHandoffResponseV1): Uint8Array {
  return concatV2(responseSigningBytes(response), frame(response.sourceSignature));
}

function parseResponse(bytes: Uint8Array): RuntimeHandoffResponseV1 {
  return decodeExact(bytes, (reader) => {
    if (reader.readText(AGENT_RUNTIME_HANDOFF_DOMAIN.length)
      !== AGENT_RUNTIME_HANDOFF_DOMAIN) {
      throw new Error("invalid Agent Runtime handoff domain");
    }
    if (reader.readText(RESPONSE_KIND.length) !== RESPONSE_KIND) {
      throw new Error("invalid Agent Runtime handoff response kind");
    }
    reader.readVersion(FORMAT_VERSION);
    const challengeHash = reader.readFrame(HASH_BYTES);
    assertBytes("Agent Runtime handoff challenge hash", challengeHash, HASH_BYTES);
    const sealedRuntime = reader.readFrame(V2_LIMITS.ciphertextBytes);
    const sourceSignature = reader.readFrame(V2_LIMITS.signatureBytes);
    assertBytes(
      "Source handoff signature",
      sourceSignature,
      V2_LIMITS.signatureBytes,
    );
    return { challengeHash, sealedRuntime, sourceSignature };
  });
}

function secretBytes(
  plan: AgentRuntimeHandoffPlanV1,
  challengeHash: Uint8Array,
  runtime: AgentRuntimeGenerationV2,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_HANDOFF_DOMAIN),
    frameText(SECRET_KIND),
    encodeU32(FORMAT_VERSION),
    planBytes(plan),
    frame(challengeHash),
    frame(encodeAgentRuntimeGeneration(runtime)),
  );
}

function parseSecret(bytes: Uint8Array): {
  readonly plan: AgentRuntimeHandoffPlanV1;
  readonly challengeHash: Uint8Array;
  readonly runtime: AgentRuntimeGenerationV2;
} {
  return decodeExact(bytes, (reader) => {
    if (reader.readText(AGENT_RUNTIME_HANDOFF_DOMAIN.length)
      !== AGENT_RUNTIME_HANDOFF_DOMAIN) {
      throw new Error("invalid Agent Runtime handoff secret domain");
    }
    if (reader.readText(SECRET_KIND.length) !== SECRET_KIND) {
      throw new Error("invalid Agent Runtime handoff secret kind");
    }
    reader.readVersion(FORMAT_VERSION);
    const plan = readPlan(reader);
    const challengeHash = reader.readFrame(HASH_BYTES);
    assertBytes("Agent Runtime handoff challenge hash", challengeHash, HASH_BYTES);
    const encodedRuntime = reader.readFrame(V2_LIMITS.plaintextBytes);
    return {
      plan,
      challengeHash,
      runtime: decodeAgentRuntimeGeneration(encodedRuntime),
    };
  });
}

function plansEqual(
  left: AgentRuntimeHandoffPlanV1,
  right: AgentRuntimeHandoffPlanV1,
): boolean {
  return equalBytes(planBytes(left), planBytes(right));
}

function authorityContext(
  plan: AgentRuntimeHandoffPlanV1,
  role: "source" | "target",
): AgentRuntimeHandoffAuthorityContextV1 {
  const own = plan[role];
  const other = role === "source" ? plan.target : plan.source;
  return Object.freeze({
    purpose: "agent-runtime-handoff",
    role,
    operationId: plan.operationId,
    agentId: plan.agentId,
    runtimeGeneration: plan.runtimeGeneration,
    ...own,
    counterpartyDomainId: other.domainId,
    counterpartyDeviceId: other.committerDeviceId,
  });
}

function authorityProofBytes(
  plan: AgentRuntimeHandoffPlanV1,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_HANDOFF_DOMAIN),
    frameText(AUTHORITY_KIND),
    frameText("committer"),
    planBytes(plan),
  );
}

function resolveCurrentCommitter(
  plan: AgentRuntimeHandoffPlanV1,
  role: "source" | "target",
  resolver: CurrentAgentRuntimeHandoffCommitterResolverV1,
): Uint8Array {
  const publicKey = resolver(authorityContext(plan, role));
  if (publicKey === null) {
    throw new Error(`Agent Runtime handoff ${role} committer is not currently authorized`);
  }
  assertBytes(
    `Agent Runtime handoff ${role} committer public key`,
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  return publicKey;
}

function assertPrivateKeyMatches(
  crypto: LatticeCrypto,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  proof: Uint8Array,
  role: "source" | "target",
): void {
  assertBytes(
    `Agent Runtime handoff ${role} signing private key`,
    privateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const signature = crypto.sign(privateKey, proof);
  if (!crypto.verify(publicKey, proof, signature)) {
    throw new Error(`Agent Runtime handoff ${role} signing key does not match the current committer`);
  }
}

function assertFresh(
  challenge: {
    readonly createdAt: number;
    readonly expiresAt: number;
  },
  now: number,
): void {
  if (
    challenge.expiresAt <= challenge.createdAt
    || challenge.expiresAt - challenge.createdAt > V2_LIMITS.grantTtlMs
  ) {
    throw new Error("Agent Runtime handoff challenge lifetime is invalid");
  }
  if (now < challenge.createdAt || now >= challenge.expiresAt) {
    throw new Error("Agent Runtime handoff challenge is stale");
  }
}

function verifyChallenge(
  crypto: LatticeCrypto,
  challengeBytes: Uint8Array,
  expectedPlan: AgentRuntimeHandoffPlanV1,
  resolver: CurrentAgentRuntimeHandoffCommitterResolverV1,
): {
  readonly challenge: RuntimeHandoffChallengeV1;
  readonly challengeHash: Uint8Array;
} {
  if (
    !(challengeBytes instanceof Uint8Array)
    || challengeBytes.length > V2_LIMITS.ciphertextBytes
  ) {
    throw new RangeError("Agent Runtime handoff challenge exceeds its byte limit");
  }
  const challenge = parseChallenge(challengeBytes);
  const checkedPlan = validatePlan(expectedPlan);
  if (!plansEqual(challenge.plan, checkedPlan)) {
    throw new Error("Agent Runtime handoff challenge does not match the expected operation context");
  }
  assertFresh(challenge, crypto.clock.now());
  const targetPublicKey = resolveCurrentCommitter(
    checkedPlan,
    "target",
    resolver,
  );
  if (
    !crypto.verify(
      targetPublicKey,
      challengeSigningBytes(challenge),
      challenge.targetSignature,
    )
  ) {
    throw new Error("Agent Runtime handoff challenge signature is invalid");
  }
  return {
    challenge,
    challengeHash: copyOwnedBytesV2(crypto.hash(challengeBytes)),
  };
}

export function prepareAgentRuntimeHandoffChallenge(input: {
  readonly crypto: LatticeCrypto;
  readonly plan: AgentRuntimeHandoffPlanV1;
  readonly targetEphemeralPublicKey: Uint8Array;
  readonly targetCommitterSigningPrivateKey: Uint8Array;
  readonly resolveCurrentCommitter:
    CurrentAgentRuntimeHandoffCommitterResolverV1;
  readonly ttlMs: number;
}): PreparedAgentRuntimeHandoffChallengeV1 {
  const plan = validatePlan(input.plan);
  assertBytes(
    "Target ephemeral public key",
    input.targetEphemeralPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  assertV2Range("Agent Runtime handoff TTL", input.ttlMs, 1, V2_LIMITS.grantTtlMs);
  const now = input.crypto.clock.now();
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + input.ttlMs)) {
    throw new RangeError("Agent Runtime handoff clock is outside the safe timestamp range");
  }
  const targetPublicKey = resolveCurrentCommitter(
    plan,
    "target",
    input.resolveCurrentCommitter,
  );
  assertPrivateKeyMatches(
    input.crypto,
    input.targetCommitterSigningPrivateKey,
    targetPublicKey,
    authorityProofBytes(plan),
    "target",
  );
  const nonce = input.crypto.randomBytes(CHALLENGE_NONCE_BYTES);
  assertBytes("Agent Runtime handoff random challenge", nonce, CHALLENGE_NONCE_BYTES);
  const unsigned = {
    plan,
    nonce,
    createdAt: now,
    expiresAt: now + input.ttlMs,
    targetEphemeralPublicKey: input.targetEphemeralPublicKey,
  };
  const targetSignature = input.crypto.sign(
    input.targetCommitterSigningPrivateKey,
    challengeSigningBytes(unsigned),
  );
  const challengeBytes = serializeChallenge({
    ...unsigned,
    targetSignature,
  });
  return Object.freeze({
    challengeBytes,
    challengeHash: copyOwnedBytesV2(input.crypto.hash(challengeBytes)),
  });
}

export async function prepareAgentRuntimeHandoffResponse(input: {
  readonly crypto: LatticeCrypto;
  readonly challengeBytes: Uint8Array;
  readonly expectedPlan: AgentRuntimeHandoffPlanV1;
  readonly sourceDomainRoot: Uint8Array;
  readonly sourceEnvelope: AgentRuntimeDomainEnvelopeV1;
  readonly resolveHistoricalSourceCommitter:
    HistoricalAgentRuntimeCommitterResolverV1;
  readonly sourceCommitterSigningPrivateKey: Uint8Array;
  readonly resolveCurrentCommitter:
    CurrentAgentRuntimeHandoffCommitterResolverV1;
}): Promise<Uint8Array> {
  const verified = verifyChallenge(
    input.crypto,
    input.challengeBytes,
    input.expectedPlan,
    input.resolveCurrentCommitter,
  );
  assertBytes("Source AI Domain root", input.sourceDomainRoot, 32);
  assertAgentRuntimeDomainEnvelope(input.sourceEnvelope);
  const sourcePublicKey = resolveCurrentCommitter(
    verified.challenge.plan,
    "source",
    input.resolveCurrentCommitter,
  );
  assertPrivateKeyMatches(
    input.crypto,
    input.sourceCommitterSigningPrivateKey,
    sourcePublicKey,
    authorityProofBytes(verified.challenge.plan),
    "source",
  );
  const sourceCommitterSigningPrivateKey = copyOwnedBytesV2(
    input.sourceCommitterSigningPrivateKey,
  );
  try {
    const runtime = openAgentRuntimeFromDomain({
      crypto: input.crypto,
      domainRoot: input.sourceDomainRoot,
      envelope: input.sourceEnvelope,
      expected: {
        agentId: verified.challenge.plan.agentId,
        domainId: verified.challenge.plan.source.domainId,
        domainEpoch: verified.challenge.plan.source.domainEpoch,
        agentAuthorizationRevision:
          verified.challenge.plan.source.agentAuthorizationRevision,
        runtimeGeneration: verified.challenge.plan.runtimeGeneration,
        committerDeviceId:
          verified.challenge.plan.source.committerDeviceId,
      },
      resolveHistoricalCommitter: input.resolveHistoricalSourceCommitter,
    });
    let sealedRuntime: Uint8Array;
    try {
      const plaintext = secretBytes(
        verified.challenge.plan,
        verified.challengeHash,
        runtime,
      );
      try {
        sealedRuntime = await input.crypto.sealTo(
          verified.challenge.targetEphemeralPublicKey,
          plaintext,
        );
      } finally {
        plaintext.fill(0);
      }
    } finally
    // locally decoded Runtime key cannot be externally observed.
    {
      runtime.key.fill(0);
    }
    const unsigned = {
      challengeHash: verified.challengeHash,
      sealedRuntime,
    };
    const sourceSignature = input.crypto.sign(
      sourceCommitterSigningPrivateKey,
      responseSigningBytes(unsigned),
    );
    const responseBytes = serializeResponse({
      ...unsigned,
      sourceSignature,
    });
    if (responseBytes.length > V2_LIMITS.ciphertextBytes) {
      throw new RangeError(
        "Agent Runtime handoff response exceeds its byte limit",
      );
    }
    return responseBytes;
  } finally {
    sourceCommitterSigningPrivateKey.fill(0);
  }
}

export async function prepareAgentRuntimeHandoffTarget(input: {
  readonly crypto: LatticeCrypto;
  readonly challengeBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly expectedPlan: AgentRuntimeHandoffPlanV1;
  readonly trustedChallengeState: TrustedAgentRuntimeHandoffChallengeStateV1;
  readonly targetEphemeralPrivateKey: Uint8Array;
  readonly targetDomainRoot: Uint8Array;
  readonly targetCommitterSigningPrivateKey: Uint8Array;
  readonly resolveCurrentCommitter:
    CurrentAgentRuntimeHandoffCommitterResolverV1;
}): Promise<PreparedAgentRuntimeHandoffTargetV1> {
  const verified = verifyChallenge(
    input.crypto,
    input.challengeBytes,
    input.expectedPlan,
    input.resolveCurrentCommitter,
  );
  if (
    typeof input.trustedChallengeState !== "object"
    || input.trustedChallengeState === null
  ) {
    throw new TypeError("trusted Agent Runtime handoff challenge state is required");
  }
  if (typeof input.trustedChallengeState.consumed !== "boolean") {
    throw new TypeError(
      "trusted Agent Runtime handoff challenge consumed state must be boolean",
    );
  }
  assertBytes(
    "Trusted Agent Runtime handoff challenge hash",
    input.trustedChallengeState.challengeHash,
    HASH_BYTES,
  );
  if (
    !equalBytes(
      input.trustedChallengeState.challengeHash,
      verified.challengeHash,
    )
  ) {
    throw new Error("trusted Agent Runtime handoff challenge state does not match the challenge");
  }
  if (input.trustedChallengeState.consumed) {
    throw new Error("Agent Runtime handoff challenge was already consumed");
  }
  assertBytes(
    "Target ephemeral private key",
    input.targetEphemeralPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  assertBytes("Target AI Domain root", input.targetDomainRoot, 32);
  if (
    !(input.responseBytes instanceof Uint8Array)
    || input.responseBytes.length > V2_LIMITS.ciphertextBytes
  ) {
    throw new RangeError("Agent Runtime handoff response exceeds its byte limit");
  }
  const response = parseResponse(input.responseBytes);
  if (!equalBytes(response.challengeHash, verified.challengeHash)) {
    throw new Error("Agent Runtime handoff response belongs to another challenge");
  }
  const sourcePublicKey = resolveCurrentCommitter(
    verified.challenge.plan,
    "source",
    input.resolveCurrentCommitter,
  );
  if (
    !input.crypto.verify(
      sourcePublicKey,
      responseSigningBytes(response),
      response.sourceSignature,
    )
  ) {
    throw new Error("Agent Runtime handoff response signature is invalid");
  }
  const targetPublicKey = resolveCurrentCommitter(
    verified.challenge.plan,
    "target",
    input.resolveCurrentCommitter,
  );
  assertPrivateKeyMatches(
    input.crypto,
    input.targetCommitterSigningPrivateKey,
    targetPublicKey,
    authorityProofBytes(verified.challenge.plan),
    "target",
  );
  // All three inputs were synchronously shape-validated above. From this
  // point on, only these exact owned copies cross the HPKE await.
  const targetEphemeralPrivateKey = copyOwnedBytesV2(
    input.targetEphemeralPrivateKey,
  );
  const targetDomainRoot = copyOwnedBytesV2(input.targetDomainRoot);
  const targetCommitterSigningPrivateKey = copyOwnedBytesV2(
    input.targetCommitterSigningPrivateKey,
  );
  try {
    const plaintext = await input.crypto.openSealed(
      targetEphemeralPrivateKey,
      response.sealedRuntime,
    );
    if (plaintext === null) {
      throw new Error("Agent Runtime handoff response failed to decrypt");
    }
    let secret: ReturnType<typeof parseSecret> | null = null;
    try {
      secret = parseSecret(plaintext);
      if (
        !plansEqual(secret.plan, verified.challenge.plan)
        || !equalBytes(secret.challengeHash, verified.challengeHash)
        || secret.runtime.agentId !== verified.challenge.plan.agentId
        || secret.runtime.generation !== verified.challenge.plan.runtimeGeneration
      ) {
        throw new Error("Agent Runtime handoff secret does not match the challenge");
      }
      const targetEnvelope = sealAgentRuntimeToDomain({
        crypto: input.crypto,
        domainRoot: targetDomainRoot,
        runtime: secret.runtime,
        context: verified.challenge.plan.target,
        committerSigningPrivateKey: targetCommitterSigningPrivateKey,
        // Current target authority and its private key were verified above.
        // These exact coordinates are supplied directly from that checked plan.
        currentCommitterAuthorized: () => true,
      });
      return Object.freeze({
        targetEnvelope,
        challengeConsumption: Object.freeze({
          challengeHash: verified.challengeHash,
          expectedConsumed: false,
          intendedConsumed: true,
        }),
      });
    } finally {
      plaintext.fill(0);
      secret?.runtime.key.fill(0);
    }
  } finally {
    targetEphemeralPrivateKey.fill(0);
    targetDomainRoot.fill(0);
    targetCommitterSigningPrivateKey.fill(0);
  }
}

export const AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-manager-handoff/v1";

export interface AgentRuntimeManagerHandoffSourceV1 {
  readonly managerHumanId: HumanId;
  readonly managerAuthorizationRevision: AuthorizationRevision;
  readonly managerDeviceId: CryptoDeviceId;
}

export interface AgentRuntimeManagerHandoffPlanV1 {
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly rotationManifestHash: Uint8Array;
  readonly runtimeCommitment: Uint8Array;
  readonly source: AgentRuntimeManagerHandoffSourceV1;
  readonly target: AgentRuntimeHandoffDomainContextV1;
}

export interface AgentRuntimeManagerHandoffAuthorityContextV1 {
  readonly purpose: "agent-runtime-manager-handoff";
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly source: AgentRuntimeManagerHandoffSourceV1;
  readonly target: AgentRuntimeHandoffDomainContextV1;
}

export type ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1 = (
  context: AgentRuntimeManagerHandoffAuthorityContextV1,
) => Uint8Array | null;

export type ResolveCurrentAgentRuntimeManagerHandoffTargetV1 = (
  context: AgentRuntimeManagerHandoffAuthorityContextV1,
) => Uint8Array | null;

export interface PreparedAgentRuntimeManagerHandoffTargetV1 {
  readonly plan: AgentRuntimeManagerHandoffPlanV1;
  readonly envelopeBytes:
    OpaqueBytes<"agent-runtime-domain-envelope">;
  readonly challengeConsumption: Readonly<{
    readonly challengeHash: Uint8Array;
    readonly expectedConsumed: false;
    readonly intendedConsumed: true;
  }>;
  readonly targetReceiptSignature: Uint8Array;
}

interface ManagerHandoffChallengeV1 {
  readonly plan: AgentRuntimeManagerHandoffPlanV1;
  readonly nonce: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly targetEphemeralPublicKey: Uint8Array;
  readonly targetSignature: Uint8Array;
}

interface ManagerHandoffResponseV1 {
  readonly challengeHash: Uint8Array;
  readonly sealedRuntime: Uint8Array;
  readonly managerSignature: Uint8Array;
}

const MANAGER_CHALLENGE_KIND = "manager-challenge";
const MANAGER_RESPONSE_KIND = "manager-response";
const MANAGER_SECRET_KIND = "manager-secret";
const MANAGER_AUTHORITY_KIND = "manager-authority";
const MANAGER_RUNTIME_COMMITMENT_KIND = "manager-runtime-commitment";
const MANAGER_TARGET_RECEIPT_KIND = "manager-target-receipt";

function assertExactManagerFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const fields = Object.keys(value);
  if (
    fields.length !== expected.length
    || fields.some((field) => !expected.includes(field))
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function validateManagerHandoffSource(
  source: AgentRuntimeManagerHandoffSourceV1,
): AgentRuntimeManagerHandoffSourceV1 {
  if (typeof source !== "object" || source === null) {
    throw new TypeError("Agent Runtime manager handoff source is required");
  }
  assertExactManagerFields("Agent Runtime manager handoff source", source, [
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
  ]);
  return Object.freeze({
    managerHumanId: humanId(source.managerHumanId),
    managerAuthorizationRevision: authorizationRevision(
      source.managerAuthorizationRevision,
    ),
    managerDeviceId: cryptoDeviceId(source.managerDeviceId),
  });
}

function validateManagerHandoffPlan(
  plan: AgentRuntimeManagerHandoffPlanV1,
): AgentRuntimeManagerHandoffPlanV1 {
  if (typeof plan !== "object" || plan === null) {
    throw new TypeError("Agent Runtime manager handoff plan is required");
  }
  assertExactManagerFields("Agent Runtime manager handoff plan", plan, [
    "operationId",
    "agentId",
    "runtimeGeneration",
    "rotationManifestHash",
    "runtimeCommitment",
    "source",
    "target",
  ]);
  assertPortableId(
    "Agent Runtime manager handoff operation id",
    plan.operationId,
  );
  const checked = Object.freeze({
    operationId: plan.operationId,
    agentId: agentId(plan.agentId),
    runtimeGeneration: agentRuntimeGeneration(plan.runtimeGeneration),
    rotationManifestHash: exactManagerBytes(
      "Agent Runtime rotation manifest hash",
      plan.rotationManifestHash,
      HASH_BYTES,
    ),
    runtimeCommitment: exactManagerBytes(
      "Agent Runtime key commitment",
      plan.runtimeCommitment,
      HASH_BYTES,
    ),
    source: validateManagerHandoffSource(plan.source),
    target: validateDomainContext(plan.target),
  });
  if (checked.source.managerDeviceId === checked.target.committerDeviceId) {
    throw new Error(
      "Agent Runtime manager handoff requires separate source and target devices",
    );
  }
  return checked;
}

function managerSourceBytes(
  source: AgentRuntimeManagerHandoffSourceV1,
): Uint8Array {
  return concatV2(
    frameText(source.managerHumanId),
    encodeU64(source.managerAuthorizationRevision),
    frameText(source.managerDeviceId),
  );
}

function managerPlanBytes(
  plan: AgentRuntimeManagerHandoffPlanV1,
): Uint8Array {
  return concatV2(
    frameText(plan.operationId),
    frameText(plan.agentId),
    encodeU64(plan.runtimeGeneration),
    frame(plan.rotationManifestHash),
    frame(plan.runtimeCommitment),
    managerSourceBytes(plan.source),
    domainContextBytes(plan.target),
  );
}

function readManagerPlan(
  reader: StrictDecoder,
): AgentRuntimeManagerHandoffPlanV1 {
  return validateManagerHandoffPlan({
    operationId: reader.readText(V2_LIMITS.idBytes),
    agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
    runtimeGeneration: agentRuntimeGeneration(reader.readU64()),
    rotationManifestHash: reader.readFrame(HASH_BYTES),
    runtimeCommitment: reader.readFrame(HASH_BYTES),
    source: {
      managerHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      managerAuthorizationRevision: authorizationRevision(reader.readU64()),
      managerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    },
    target: readDomainContext(reader),
  });
}

function exactManagerBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): Uint8Array {
  assertBytes(label, value, expectedLength);
  return copyOwnedBytesV2(value);
}

export function agentRuntimeManagerHandoffRuntimeCommitmentV1(input: {
  readonly crypto: LatticeCrypto;
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly runtimeKey: Uint8Array;
}): Uint8Array {
  assertPortableId(
    "Agent Runtime manager handoff operation id",
    input.operationId,
  );
  const key = exactManagerBytes(
    "Agent Runtime key commitment input",
    input.runtimeKey,
    AGENT_RUNTIME_KEY_BYTES,
  );
  try {
    const framedKey = frame(key);
    try {
      const commitmentInput = concatV2(
        frameText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
        frameText(MANAGER_RUNTIME_COMMITMENT_KIND),
        frameText(input.operationId),
        frameText(agentId(input.agentId)),
        encodeU64(agentRuntimeGeneration(input.runtimeGeneration)),
        framedKey,
      );
      try {
        return copyOwnedBytesV2(input.crypto.hash(commitmentInput));
      } finally {
        commitmentInput.fill(0);
      }
    } finally
    // function-local secret frame cannot be externally observed.
    {
      framedKey.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

function managerAuthorityContext(
  plan: AgentRuntimeManagerHandoffPlanV1,
): AgentRuntimeManagerHandoffAuthorityContextV1 {
  return Object.freeze({
    purpose: "agent-runtime-manager-handoff",
    operationId: plan.operationId,
    agentId: plan.agentId,
    runtimeGeneration: plan.runtimeGeneration,
    source: plan.source,
    target: plan.target,
  });
}

function managerAuthorityProof(
  plan: AgentRuntimeManagerHandoffPlanV1,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
    frameText(MANAGER_AUTHORITY_KIND),
    managerPlanBytes(plan),
  );
}

function resolveManagerHandoffAuthority(
  plan: AgentRuntimeManagerHandoffPlanV1,
  resolver: ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1,
  role: "manager" | "target",
): Uint8Array {
  const publicKey = resolver(managerAuthorityContext(plan));
  if (publicKey === null) {
    throw new Error(
      `Agent Runtime manager handoff ${role} is not currently authorized`,
    );
  }
  assertBytes(
    `Agent Runtime manager handoff ${role} public key`,
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  return publicKey;
}

function managerChallengeSigningBytes(
  challenge: Omit<ManagerHandoffChallengeV1, "targetSignature">,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
    frameText(MANAGER_CHALLENGE_KIND),
    encodeU32(FORMAT_VERSION),
    managerPlanBytes(challenge.plan),
    frame(challenge.nonce),
    encodeU64(challenge.createdAt),
    encodeU64(challenge.expiresAt),
    frame(challenge.targetEphemeralPublicKey),
  );
}

function serializeManagerChallenge(
  challenge: ManagerHandoffChallengeV1,
): Uint8Array {
  return concatV2(
    managerChallengeSigningBytes(challenge),
    frame(challenge.targetSignature),
  );
}

function parseManagerChallenge(
  bytes: Uint8Array,
): ManagerHandoffChallengeV1 {
  return decodeExact(bytes, (reader) => {
    if (
      reader.readText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN.length)
        !== AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN
    ) {
      throw new Error("invalid Agent Runtime manager handoff domain");
    }
    if (
      reader.readText(MANAGER_CHALLENGE_KIND.length)
        !== MANAGER_CHALLENGE_KIND
    ) {
      throw new Error("invalid Agent Runtime manager challenge kind");
    }
    reader.readVersion(FORMAT_VERSION);
    const plan = readManagerPlan(reader);
    const nonce = reader.readFrame(CHALLENGE_NONCE_BYTES);
    assertBytes("Manager handoff challenge nonce", nonce, CHALLENGE_NONCE_BYTES);
    const createdAt = reader.readU64();
    const expiresAt = reader.readU64();
    const targetEphemeralPublicKey = reader.readFrame(
      V2_LIMITS.hpkePublicKeyBytes,
    );
    assertBytes(
      "Manager handoff target ephemeral public key",
      targetEphemeralPublicKey,
      V2_LIMITS.hpkePublicKeyBytes,
    );
    const targetSignature = reader.readFrame(V2_LIMITS.signatureBytes);
    assertBytes(
      "Manager handoff target signature",
      targetSignature,
      V2_LIMITS.signatureBytes,
    );
    return {
      plan,
      nonce,
      createdAt,
      expiresAt,
      targetEphemeralPublicKey,
      targetSignature,
    };
  });
}

function managerResponseSigningBytes(
  response: Omit<ManagerHandoffResponseV1, "managerSignature">,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
    frameText(MANAGER_RESPONSE_KIND),
    encodeU32(FORMAT_VERSION),
    frame(response.challengeHash),
    frame(response.sealedRuntime),
  );
}

function serializeManagerResponse(
  response: ManagerHandoffResponseV1,
): Uint8Array {
  return concatV2(
    managerResponseSigningBytes(response),
    frame(response.managerSignature),
  );
}

function parseManagerResponse(bytes: Uint8Array): ManagerHandoffResponseV1 {
  return decodeExact(bytes, (reader) => {
    if (
      reader.readText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN.length)
        !== AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN
    ) {
      throw new Error("invalid Agent Runtime manager handoff domain");
    }
    if (
      reader.readText(MANAGER_RESPONSE_KIND.length)
        !== MANAGER_RESPONSE_KIND
    ) {
      throw new Error("invalid Agent Runtime manager response kind");
    }
    reader.readVersion(FORMAT_VERSION);
    const challengeHash = reader.readFrame(HASH_BYTES);
    assertBytes("Manager handoff challenge hash", challengeHash, HASH_BYTES);
    const sealedRuntime = reader.readFrame(V2_LIMITS.ciphertextBytes);
    const managerSignature = reader.readFrame(V2_LIMITS.signatureBytes);
    assertBytes(
      "Manager handoff response signature",
      managerSignature,
      V2_LIMITS.signatureBytes,
    );
    return { challengeHash, sealedRuntime, managerSignature };
  });
}

function managerSecretBytes(
  plan: AgentRuntimeManagerHandoffPlanV1,
  challengeHash: Uint8Array,
  runtime: AgentRuntimeGenerationV2,
): Uint8Array {
  const encodedRuntime = encodeAgentRuntimeGeneration(runtime);
  try {
    const framedRuntime = frame(encodedRuntime);
    try {
      return concatV2(
        frameText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
        frameText(MANAGER_SECRET_KIND),
        encodeU32(FORMAT_VERSION),
        managerPlanBytes(plan),
        frame(challengeHash),
        framedRuntime,
      );
    } finally
    // function-local secret frame cannot be externally observed.
    {
      framedRuntime.fill(0);
    }
  } finally
  // function-local secret encoding cannot be externally observed.
  {
    encodedRuntime.fill(0);
  }
}

function parseManagerSecret(bytes: Uint8Array): Readonly<{
  readonly plan: AgentRuntimeManagerHandoffPlanV1;
  readonly challengeHash: Uint8Array;
  readonly runtime: AgentRuntimeGenerationV2;
}> {
  return decodeExact(bytes, (reader) => {
    if (
      reader.readText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN.length)
        !== AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN
    ) {
      throw new Error("invalid Agent Runtime manager secret domain");
    }
    if (
      reader.readText(MANAGER_SECRET_KIND.length)
        !== MANAGER_SECRET_KIND
    ) {
      throw new Error("invalid Agent Runtime manager secret kind");
    }
    reader.readVersion(FORMAT_VERSION);
    const plan = readManagerPlan(reader);
    const challengeHash = reader.readFrame(HASH_BYTES);
    assertBytes("Manager handoff challenge hash", challengeHash, HASH_BYTES);
    const runtimeBytes = reader.readFrame(V2_LIMITS.plaintextBytes);
    try {
      return {
        plan,
        challengeHash,
        runtime: decodeAgentRuntimeGeneration(runtimeBytes),
      };
    } finally
    // owned decoder frame cannot be externally observed.
    {
      runtimeBytes.fill(0);
    }
  });
}

function managerTargetReceiptSigningBytes(input: {
  readonly plan: AgentRuntimeManagerHandoffPlanV1;
  readonly challengeHash: Uint8Array;
  readonly envelopeHash: Uint8Array;
}): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
    frameText(MANAGER_TARGET_RECEIPT_KIND),
    encodeU32(FORMAT_VERSION),
    managerPlanBytes(input.plan),
    frame(input.challengeHash),
    frame(input.envelopeHash),
  );
}

export function agentRuntimeManagerHandoffPlansEqualV1(
  left: AgentRuntimeManagerHandoffPlanV1,
  right: AgentRuntimeManagerHandoffPlanV1,
): boolean {
  return equalBytes(managerPlanBytes(left), managerPlanBytes(right));
}

function verifyManagerChallenge(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
  expectedPlan: AgentRuntimeManagerHandoffPlanV1,
  resolveTarget: ResolveCurrentAgentRuntimeManagerHandoffTargetV1,
): Readonly<{
  readonly challenge: ManagerHandoffChallengeV1;
  readonly challengeHash: Uint8Array;
}> {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > V2_LIMITS.ciphertextBytes
  ) {
    throw new RangeError("Agent Runtime manager challenge exceeds byte limit");
  }
  const challenge = parseManagerChallenge(bytes);
  const plan = validateManagerHandoffPlan(expectedPlan);
  if (!agentRuntimeManagerHandoffPlansEqualV1(challenge.plan, plan)) {
    throw new Error(
      "Agent Runtime manager challenge does not match expected context",
    );
  }
  assertFresh(challenge, crypto.clock.now());
  const targetPublicKey = resolveManagerHandoffAuthority(
    plan,
    resolveTarget,
    "target",
  );
  if (
    !crypto.verify(
      targetPublicKey,
      managerChallengeSigningBytes(challenge),
      challenge.targetSignature,
    )
  ) {
    throw new Error("Agent Runtime manager challenge signature is invalid");
  }
  return Object.freeze({
    challenge,
    challengeHash: copyOwnedBytesV2(crypto.hash(bytes)),
  });
}

export function prepareAgentRuntimeManagerHandoffChallenge(input: {
  readonly crypto: LatticeCrypto;
  readonly plan: AgentRuntimeManagerHandoffPlanV1;
  readonly targetEphemeralPublicKey: Uint8Array;
  readonly targetCommitterSigningPrivateKey: Uint8Array;
  readonly resolveCurrentTargetCommitter:
    ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
  readonly ttlMs: number;
}): PreparedAgentRuntimeHandoffChallengeV1 {
  const plan = validateManagerHandoffPlan(input.plan);
  assertBytes(
    "Manager handoff target ephemeral public key",
    input.targetEphemeralPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  assertBytes(
    "Manager handoff target signing private key",
    input.targetCommitterSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  if (typeof input.resolveCurrentTargetCommitter !== "function") {
    throw new TypeError(
      "Current manager handoff target resolver is required",
    );
  }
  assertV2Range(
    "Agent Runtime manager handoff TTL",
    input.ttlMs,
    1,
    V2_LIMITS.grantTtlMs,
  );
  const signingPrivateKey = copyOwnedBytesV2(
    input.targetCommitterSigningPrivateKey,
  );
  try {
    const targetPublicKey = resolveManagerHandoffAuthority(
      plan,
      input.resolveCurrentTargetCommitter,
      "target",
    );
    assertPrivateKeyMatches(
      input.crypto,
      signingPrivateKey,
      targetPublicKey,
      managerAuthorityProof(plan),
      "target",
    );
    const now = input.crypto.clock.now();
    if (
      !Number.isSafeInteger(now)
      || now < 0
      || !Number.isSafeInteger(now + input.ttlMs)
    ) {
      throw new RangeError("Manager handoff clock is outside safe range");
    }
    const nonce = input.crypto.randomBytes(CHALLENGE_NONCE_BYTES);
    assertBytes("Manager handoff challenge nonce", nonce, CHALLENGE_NONCE_BYTES);
    const unsigned = {
      plan,
      nonce,
      createdAt: now,
      expiresAt: now + input.ttlMs,
      targetEphemeralPublicKey: input.targetEphemeralPublicKey,
    };
    const targetSignature = input.crypto.sign(
      signingPrivateKey,
      managerChallengeSigningBytes(unsigned),
    );
    const challengeBytes = serializeManagerChallenge({
      ...unsigned,
      targetSignature,
    });
    return Object.freeze({
      challengeBytes,
      challengeHash: copyOwnedBytesV2(input.crypto.hash(challengeBytes)),
    });
  } finally {
    signingPrivateKey.fill(0);
  }
}

export async function prepareAgentRuntimeManagerHandoffResponse(input: {
  readonly crypto: LatticeCrypto;
  readonly challengeBytes: Uint8Array;
  readonly expectedPlan: AgentRuntimeManagerHandoffPlanV1;
  readonly freshRuntime: AgentRuntimeGenerationV2;
  readonly managerSigningPrivateKey: Uint8Array;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1;
  readonly resolveCurrentTargetCommitter:
    ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
}): Promise<Uint8Array> {
  assertAgentRuntimeGeneration(input.freshRuntime);
  assertBytes(
    "Manager handoff manager signing private key",
    input.managerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  if (typeof input.resolveCurrentManagerAuthority !== "function") {
    throw new TypeError(
      "Current manager handoff manager resolver is required",
    );
  }
  if (typeof input.resolveCurrentTargetCommitter !== "function") {
    throw new TypeError(
      "Current manager handoff target resolver is required",
    );
  }
  const expectedPlan = validateManagerHandoffPlan(input.expectedPlan);
  if (
    input.freshRuntime.agentId !== expectedPlan.agentId
    || input.freshRuntime.generation
      !== expectedPlan.runtimeGeneration
  ) {
    throw new Error("Fresh Runtime does not match manager handoff plan");
  }
  const verified = verifyManagerChallenge(
    input.crypto,
    input.challengeBytes,
    expectedPlan,
    input.resolveCurrentTargetCommitter,
  );
  let runtimeKey: Uint8Array | null = null;
  let managerPrivate: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    runtimeKey = copyOwnedBytesV2(input.freshRuntime.key);
    managerPrivate = copyOwnedBytesV2(input.managerSigningPrivateKey);
    const managerPublicKey = resolveManagerHandoffAuthority(
      verified.challenge.plan,
      input.resolveCurrentManagerAuthority,
      "manager",
    );
    assertPrivateKeyMatches(
      input.crypto,
      managerPrivate,
      managerPublicKey,
      managerAuthorityProof(verified.challenge.plan),
      "source",
    );
    plaintext = managerSecretBytes(
      verified.challenge.plan,
      verified.challengeHash,
      {
        ...input.freshRuntime,
        key: runtimeKey,
      },
    );
    const sealedRuntime = await input.crypto.sealTo(
      verified.challenge.targetEphemeralPublicKey,
      plaintext,
    );
    const unsigned = {
      challengeHash: verified.challengeHash,
      sealedRuntime,
    };
    const managerSignature = input.crypto.sign(
      managerPrivate,
      managerResponseSigningBytes(unsigned),
    );
    const responseBytes = serializeManagerResponse({
      ...unsigned,
      managerSignature,
    });
    if (responseBytes.length > V2_LIMITS.ciphertextBytes) {
      throw new RangeError("Manager handoff response exceeds byte limit");
    }
    return responseBytes;
  } finally {
    plaintext?.fill(0);
    runtimeKey?.fill(0);
    managerPrivate?.fill(0);
  }
}

export async function prepareAgentRuntimeManagerHandoffTarget(input: {
  readonly crypto: LatticeCrypto;
  readonly challengeBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly expectedPlan: AgentRuntimeManagerHandoffPlanV1;
  readonly trustedChallengeState: TrustedAgentRuntimeHandoffChallengeStateV1;
  readonly targetEphemeralPrivateKey: Uint8Array;
  readonly targetDomainRoot: Uint8Array;
  readonly targetCommitterSigningPrivateKey: Uint8Array;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1;
  readonly resolveCurrentTargetCommitter:
    ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
}): Promise<PreparedAgentRuntimeManagerHandoffTargetV1> {
  if (
    typeof input.trustedChallengeState !== "object"
    || input.trustedChallengeState === null
  ) {
    throw new TypeError(
      "Trusted manager handoff challenge state is required",
    );
  }
  assertExactManagerFields(
    "Trusted manager handoff challenge state",
    input.trustedChallengeState,
    ["challengeHash", "consumed"],
  );
  assertBytes(
    "Trusted manager handoff challenge hash",
    input.trustedChallengeState.challengeHash,
    HASH_BYTES,
  );
  if (typeof input.trustedChallengeState.consumed !== "boolean") {
    throw new TypeError(
      "Trusted manager handoff challenge consumed state must be boolean",
    );
  }
  assertBytes(
    "Manager handoff target ephemeral private key",
    input.targetEphemeralPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  assertBytes("Manager handoff target Domain root", input.targetDomainRoot, 32);
  assertBytes(
    "Manager handoff target signing private key",
    input.targetCommitterSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  if (typeof input.resolveCurrentManagerAuthority !== "function") {
    throw new TypeError(
      "Current manager handoff manager resolver is required",
    );
  }
  if (typeof input.resolveCurrentTargetCommitter !== "function") {
    throw new TypeError(
      "Current manager handoff target resolver is required",
    );
  }
  if (
    !(input.responseBytes instanceof Uint8Array)
    || input.responseBytes.length > V2_LIMITS.ciphertextBytes
  ) {
    throw new RangeError("Manager handoff response exceeds byte limit");
  }
  const verified = verifyManagerChallenge(
    input.crypto,
    input.challengeBytes,
    input.expectedPlan,
    input.resolveCurrentTargetCommitter,
  );
  if (
    input.trustedChallengeState.consumed
    || !equalBytes(
      input.trustedChallengeState.challengeHash,
      verified.challengeHash,
    )
  ) {
    throw new Error("Manager handoff challenge state is stale or consumed");
  }
  const response = parseManagerResponse(input.responseBytes);
  if (!equalBytes(response.challengeHash, verified.challengeHash)) {
    throw new Error("Manager handoff response belongs to another challenge");
  }
  let ephemeralPrivate: Uint8Array | null = null;
  let domainRoot: Uint8Array | null = null;
  let targetPrivate: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  let secret: ReturnType<typeof parseManagerSecret> | null = null;
  try {
    ephemeralPrivate = copyOwnedBytesV2(
      input.targetEphemeralPrivateKey,
    );
    domainRoot = copyOwnedBytesV2(input.targetDomainRoot);
    targetPrivate = copyOwnedBytesV2(
      input.targetCommitterSigningPrivateKey,
    );
    const managerPublicKey = resolveManagerHandoffAuthority(
      verified.challenge.plan,
      input.resolveCurrentManagerAuthority,
      "manager",
    );
    if (
      !input.crypto.verify(
        managerPublicKey,
        managerResponseSigningBytes(response),
        response.managerSignature,
      )
    ) {
      throw new Error("Manager handoff response signature is invalid");
    }
    const targetPublicKey = resolveManagerHandoffAuthority(
      verified.challenge.plan,
      input.resolveCurrentTargetCommitter,
      "target",
    );
    assertPrivateKeyMatches(
      input.crypto,
      targetPrivate,
      targetPublicKey,
      managerAuthorityProof(verified.challenge.plan),
      "target",
    );
    plaintext = await input.crypto.openSealed(
      ephemeralPrivate,
      response.sealedRuntime,
    );
    if (plaintext === null) {
      throw new Error("Manager handoff response failed to decrypt");
    }
    secret = parseManagerSecret(plaintext);
    if (
      !agentRuntimeManagerHandoffPlansEqualV1(
        secret.plan,
        verified.challenge.plan,
      )
      || !equalBytes(secret.challengeHash, verified.challengeHash)
      || secret.runtime.agentId !== verified.challenge.plan.agentId
      || secret.runtime.generation
        !== verified.challenge.plan.runtimeGeneration
    ) {
      throw new Error("Manager handoff secret does not match challenge");
    }
    const runtimeCommitment =
      agentRuntimeManagerHandoffRuntimeCommitmentV1({
        crypto: input.crypto,
        operationId: verified.challenge.plan.operationId,
        agentId: secret.runtime.agentId,
        runtimeGeneration: secret.runtime.generation,
        runtimeKey: secret.runtime.key,
      });
    if (
      !equalBytes(
        runtimeCommitment,
        verified.challenge.plan.runtimeCommitment,
      )
    ) {
      throw new Error(
        "Manager handoff Runtime does not match the rotation commitment",
      );
    }
    const envelope = sealAgentRuntimeToDomain({
      crypto: input.crypto,
      domainRoot,
      runtime: secret.runtime,
      context: verified.challenge.plan.target,
      committerSigningPrivateKey: targetPrivate,
      currentCommitterAuthorized: () => true,
    });
    const serializedEnvelope = serializeAgentRuntimeDomainEnvelope(envelope);
    const envelopeHash = input.crypto.hash(serializedEnvelope);
    const targetReceiptSignature = input.crypto.sign(
      targetPrivate,
      managerTargetReceiptSigningBytes({
        plan: verified.challenge.plan,
        challengeHash: verified.challengeHash,
        envelopeHash,
      }),
    );
    const completion = Object.freeze({
      plan: verified.challenge.plan,
      envelopeBytes: opaqueBytes(
        "agent-runtime-domain-envelope",
        serializedEnvelope,
      ),
      challengeConsumption: Object.freeze({
        challengeHash: verified.challengeHash,
        expectedConsumed: false as const,
        intendedConsumed: true as const,
      }),
      targetReceiptSignature: copyOwnedBytesV2(
        targetReceiptSignature,
      ),
    });
    return completion;
  } finally {
    plaintext?.fill(0);
    secret?.runtime.key.fill(0);
    ephemeralPrivate?.fill(0);
    domainRoot?.fill(0);
    targetPrivate?.fill(0);
  }
}

export function assertPreparedAgentRuntimeManagerHandoffTarget(
  value: PreparedAgentRuntimeManagerHandoffTargetV1,
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      "Agent Runtime manager handoff target completion is malformed",
    );
  }
  assertExactManagerFields(
    "Agent Runtime manager handoff target completion",
    value,
    [
      "plan",
      "envelopeBytes",
      "challengeConsumption",
      "targetReceiptSignature",
    ],
  );
  const plan = validateManagerHandoffPlan(value.plan);
  if (
    typeof value.envelopeBytes !== "object"
    || value.envelopeBytes === null
  ) {
    throw new Error(
      "Agent Runtime manager handoff target envelope is malformed",
    );
  }
  assertExactManagerFields(
    "Agent Runtime manager handoff target envelope",
    value.envelopeBytes,
    ["classification", "kind", "ciphertext"],
  );
  if (
    value.envelopeBytes.classification !== "opaque-ciphertext"
    || value.envelopeBytes.kind !== "agent-runtime-domain-envelope"
    || !(value.envelopeBytes.ciphertext instanceof Uint8Array)
    || value.envelopeBytes.ciphertext.length > V2_LIMITS.wrappedDekBytes
  ) {
    throw new Error(
      "Agent Runtime manager handoff target envelope is malformed",
    );
  }
  const envelope = parseAgentRuntimeDomainEnvelope(
    value.envelopeBytes.ciphertext,
  );
  if (
    envelope.agentId !== plan.agentId
    || envelope.runtimeGeneration !== plan.runtimeGeneration
    || envelope.domainId !== plan.target.domainId
    || envelope.domainEpoch !== plan.target.domainEpoch
    || envelope.agentAuthorizationRevision
      !== plan.target.agentAuthorizationRevision
    || envelope.committerDeviceId !== plan.target.committerDeviceId
  ) {
    throw new Error(
      "Agent Runtime manager handoff target envelope coordinates are invalid",
    );
  }
  if (
    typeof value.challengeConsumption !== "object"
    || value.challengeConsumption === null
  ) {
    throw new Error(
      "Agent Runtime manager handoff challenge consumption intent is malformed",
    );
  }
  assertExactManagerFields(
    "Agent Runtime manager handoff challenge consumption intent",
    value.challengeConsumption,
    ["challengeHash", "expectedConsumed", "intendedConsumed"],
  );
  assertBytes(
    "Agent Runtime manager handoff challenge consumption hash",
    value.challengeConsumption.challengeHash,
    HASH_BYTES,
  );
  if (
    value.challengeConsumption.expectedConsumed !== false
    || value.challengeConsumption.intendedConsumed !== true
  ) {
    throw new Error(
      "Agent Runtime manager handoff challenge consumption intent is invalid",
    );
  }
  assertBytes(
    "Agent Runtime manager handoff target receipt signature",
    value.targetReceiptSignature,
    V2_LIMITS.signatureBytes,
  );
}

export function verifyPreparedAgentRuntimeManagerHandoffTarget(input: {
  readonly crypto: LatticeCrypto;
  readonly value: PreparedAgentRuntimeManagerHandoffTargetV1;
  readonly resolveCurrentTargetCommitter:
    ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
}): PreparedAgentRuntimeManagerHandoffTargetV1 {
  assertPreparedAgentRuntimeManagerHandoffTarget(input.value);
  const plan = validateManagerHandoffPlan(input.value.plan);
  const targetPublicKey = resolveManagerHandoffAuthority(
    plan,
    input.resolveCurrentTargetCommitter,
    "target",
  );
  const envelopeBytes = input.value.envelopeBytes.ciphertext;
  const challengeHash =
    copyOwnedBytesV2(input.value.challengeConsumption.challengeHash);
  const envelopeHash = input.crypto.hash(envelopeBytes);
  const envelope = parseAgentRuntimeDomainEnvelope(envelopeBytes);
  if (
    !input.crypto.verify(
      targetPublicKey,
      agentRuntimeDomainEnvelopeSigningBytes(envelope),
      envelope.signature,
    )
  ) {
    throw new Error(
      "Agent Runtime manager handoff target envelope signature is invalid",
    );
  }
  if (
    !input.crypto.verify(
      targetPublicKey,
      managerTargetReceiptSigningBytes({
        plan,
        challengeHash,
        envelopeHash,
      }),
      input.value.targetReceiptSignature,
    )
  ) {
    throw new Error(
      "Agent Runtime manager handoff target receipt signature is invalid",
    );
  }
  return Object.freeze({
    plan,
    envelopeBytes: opaqueBytes(
      "agent-runtime-domain-envelope",
      envelopeBytes,
    ),
    challengeConsumption: Object.freeze({
      challengeHash,
      expectedConsumed: false as const,
      intendedConsumed: true as const,
    }),
    targetReceiptSignature: copyOwnedBytesV2(
      input.value.targetReceiptSignature,
    ),
  });
}
