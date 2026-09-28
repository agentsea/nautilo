import { humanCryptoDevices, inArray } from "@nautilo/db";
import {
  agentRuntimeGeneration,
  verifyHistoricalAgentRuntimeSignerPublication,
  type LatticeCrypto,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
} from "@nautilo/lattice-crypto";
import {
  agentRuntimeDomainEnvelopeSigningBytesV1,
  encodeAgentRuntimeSignerPublicationV1,
  parseAgentRuntimeDomainEnvelopeV1,
  type HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresLatticeStorage,
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";

export type ProtectedTaskResultSignerHistory = Readonly<{
  resolveHistoricalRuntimeCommitter: HistoricalAgentRuntimeCommitterResolverV1;
  resolveHistoricalSignerPublicationManager: ResolveHistoricalAgentRuntimeSignerPublicationManager;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}
function exactContext(actual: object, expected: object): boolean {
  const entries = Object.entries(expected);
  if (Object.keys(actual).length !== entries.length) return false;
  return entries.every(([key, value]) => {
    const other: unknown = (actual as Record<string, unknown>)[key];
    return value instanceof Uint8Array
      ? other instanceof Uint8Array && sameBytes(value, other)
      : other === value;
  });
}
function collectBytes(value: unknown, owned: Uint8Array[]): void {
  if (value instanceof Uint8Array) owned.push(value);
  else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) collectBytes(nested, owned);
  }
}

/** Bounded historical public-key borrowing for one exact current Runtime signer. */
export async function withProtectedTaskResultSignerHistory<Value>(
  input: Readonly<{
    handle: CryptoPostgresHandle;
    crypto: LatticeCrypto;
    agentId: string;
    domainId: string;
    domainEpoch: number;
    expectedAgentAuthorizationRevision: number;
    expectedRuntimeGeneration: number;
    use(history: ProtectedTaskResultSignerHistory): Value | Promise<Value>;
  }>,
): Promise<Value> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const expected = Object.freeze({
    agentId: input.agentId,
    domainId: input.domainId,
    domainEpoch: input.domainEpoch,
    agentAuthorizationRevision: input.expectedAgentAuthorizationRevision,
    runtimeGeneration: agentRuntimeGeneration(input.expectedRuntimeGeneration),
  });
  if (
    expected.agentId.length === 0 ||
    expected.domainId.length === 0 ||
    !Number.isSafeInteger(expected.domainEpoch) ||
    expected.domainEpoch < 1 ||
    !Number.isSafeInteger(expected.agentAuthorizationRevision) ||
    expected.agentAuthorizationRevision < 0
  ) {
    throw new TypeError("Task result signer history coordinates are invalid");
  }
  const storage = new PostgresLatticeStorage(input.handle);
  const owned: Uint8Array[] = [];
  let active = false;
  const load = async () => {
    const state = await storage.getAgentRuntimeAtomicState(expected.agentId);
    // The concrete Postgres codec returns detached byte arrays, never cached state.
    collectBytes(state, owned);
    if (
      state === null ||
      state.runtime.agentId !== expected.agentId ||
      state.runtime.runtimeGeneration !== expected.runtimeGeneration ||
      state.runtime.authorizationRevision !==
        expected.agentAuthorizationRevision
    ) {
      throw new TypeError("Task result Runtime signer generation is stale");
    }
    const matches = state.domainEnvelopes.filter(
      (entry) =>
        entry.agentId === expected.agentId &&
        entry.domainId === expected.domainId &&
        entry.domainEpoch === expected.domainEpoch &&
        entry.agentAuthorizationRevision ===
          expected.agentAuthorizationRevision &&
        entry.runtimeGeneration === expected.runtimeGeneration,
    );
    const envelope = matches[0];
    if (matches.length !== 1 || envelope === undefined)
      throw new TypeError("Task result Runtime envelope is unavailable");
    const hash = input.crypto.hash(envelope.envelopeBytes);
    owned.push(hash);
    if (!sameBytes(hash, envelope.envelopeHash))
      throw new TypeError("Task result Runtime envelope hash disagrees");
    const publication = await storage.getAgentRuntimeSignerPublication(
      expected.agentId,
      expected.runtimeGeneration,
    );
    collectBytes(publication, owned);
    if (
      publication === null ||
      publication.agentId !== expected.agentId ||
      publication.runtimeGeneration !== expected.runtimeGeneration ||
      publication.authorizationRevision !== expected.agentAuthorizationRevision
    ) {
      throw new TypeError(
        "Task result Runtime signer publication is unavailable",
      );
    }
    const publicationBytes = encodeAgentRuntimeSignerPublicationV1(publication);
    owned.push(publicationBytes);
    return { envelope, publication, publicationBytes };
  };
  try {
    const initial = await load();
    const envelope = parseAgentRuntimeDomainEnvelopeV1(
      initial.envelope.envelopeBytes,
    );
    collectBytes(envelope, owned);
    const committerContext = Object.freeze({
      purpose: "agent-runtime-domain-envelope" as const,
      ...expected,
      committerDeviceId: initial.envelope.committerDeviceId,
    });
    if (
      envelope.agentId !== expected.agentId ||
      envelope.domainId !== expected.domainId ||
      envelope.domainEpoch !== expected.domainEpoch ||
      envelope.agentAuthorizationRevision !==
        expected.agentAuthorizationRevision ||
      envelope.runtimeGeneration !== expected.runtimeGeneration ||
      envelope.committerDeviceId !== initial.envelope.committerDeviceId
    ) {
      throw new TypeError("Task result Runtime envelope context disagrees");
    }
    const { signature: _signature, ...unsignedPublication } =
      initial.publication;
    const managerContext = Object.freeze({
      purpose: "verify-historical-agent-runtime-signer-publication" as const,
      ...unsignedPublication,
    });
    const deviceIds: string[] = [
      ...new Set([
        envelope.committerDeviceId,
        initial.publication.managerDeviceId,
      ]),
    ].sort();
    const rows = await executeTypedCryptoQuery(
      input.handle,
      cryptoTypedDb
        .select({
          device_id: humanCryptoDevices.deviceId,
          human_id: humanCryptoDevices.humanId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          state: humanCryptoDevices.state,
          revision: humanCryptoDevices.revision,
        })
        .from(humanCryptoDevices)
        .where(inArray(humanCryptoDevices.deviceId, deviceIds))
        .limit(3),
    );
    if (rows.length !== deviceIds.length)
      throw new TypeError("Task result signer device history is unavailable");
    const keys = new Map<string, Uint8Array>();
    for (const row of rows) {
      if (
        !deviceIds.includes(row.device_id) ||
        keys.has(row.device_id) ||
        (row.state !== "active" && row.state !== "revoked") ||
        row.human_id.length === 0 ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        !(row.signing_public_key instanceof Uint8Array) ||
        row.signing_public_key.length !== 32 ||
        (row.device_id === initial.publication.managerDeviceId &&
          (row.human_id !== initial.publication.managerHumanId ||
            row.revision < initial.publication.managerAuthorizationRevision))
      ) {
        throw new TypeError("Task result signer device history is invalid");
      }
      const key = row.signing_public_key.slice();
      owned.push(key);
      keys.set(row.device_id, key);
    }
    const committerKey = keys.get(envelope.committerDeviceId);
    const managerKey = keys.get(initial.publication.managerDeviceId);
    if (committerKey === undefined || managerKey === undefined)
      throw new TypeError("Task result signer history is incomplete");
    const signingBytes = agentRuntimeDomainEnvelopeSigningBytesV1(envelope);
    owned.push(signingBytes);
    const managerHash = input.crypto.hash(managerKey);
    owned.push(managerHash);
    if (
      !input.crypto.verify(committerKey, signingBytes, envelope.signature) ||
      !sameBytes(
        managerHash,
        initial.publication.managerSigningPublicKeyHash,
      ) ||
      !verifyHistoricalAgentRuntimeSignerPublication({
        crypto: input.crypto,
        publication: initial.publication,
        resolveHistoricalManagerAuthority: (context) =>
          exactContext(context, managerContext) ? managerKey : null,
      })
    ) {
      throw new TypeError("Task result signer history signature is invalid");
    }
    const assertCurrent = async () => {
      const current = await load();
      if (
        current.envelope.committerDeviceId !==
          initial.envelope.committerDeviceId ||
        !sameBytes(
          current.envelope.envelopeBytes,
          initial.envelope.envelopeBytes,
        ) ||
        !sameBytes(current.publicationBytes, initial.publicationBytes)
      ) {
        throw new TypeError(
          "Task result Runtime signer changed during history use",
        );
      }
    };
    await assertCurrent();
    active = true;
    const value = await input.use(
      Object.freeze({
        resolveHistoricalRuntimeCommitter: (context) =>
          active && exactContext(context, committerContext)
            ? committerKey
            : null,
        resolveHistoricalSignerPublicationManager: (context) =>
          active && exactContext(context, managerContext) ? managerKey : null,
      }),
    );
    active = false;
    await assertCurrent();
    return value;
  } finally {
    active = false;
    for (const bytes of owned) bytes.fill(0);
  }
}
