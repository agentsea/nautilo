import { createHash } from "node:crypto";
import type { DirectDatabase, PostgresJsBridgeConnection } from "@nautilo/db";
import {
  authenticatePreparedHistoricalTaskContentCryptoRevisionV1,
  createDormantTaskContentShadowRepository,
  deriveTaskHistoricalContentCryptoObjectIdV1,
  encodeTaskPayloadV1, encodeTaskRunResultPayloadV1,
  type EncryptionDataOperationOwner,
  type TaskContentCoordinateV1,
} from "@nautilo/lattice-bridge";
import {
  createPostgresTaskContentCryptoCompletion,
  inspectStagedHistoricalTaskContentPublication,
  PostgresHumanDeviceSignerHistory, PostgresTaskContentProductStore,
  stageHistoricalTaskContentPublication,
  verifyConversationProductPostgresHandle, verifyCryptoPostgresHandle,
  type VerifiedStagedHistoricalTaskContentPublication,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { createProtectedTaskHistoricalHumanDeviceSigningKeyResolver } from
  "./protected-task-historical-human-device-signing-key";
import {
  createTaskContentBackfillAuthority,
  type HeldTaskContentBackfillAuthority, type TaskContentBackfillSubject,
} from "./task-content-backfill-authority";
import { readTaskContentBackfillSource } from "./task-content-backfill-source";

const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length
  && left.every((value, index) => value === right[index]);

export type TaskContentBackfillPublicationPlan = Readonly<{
  planVersion: 1;
  claimId: string;
  operationId: string;
  coordinate: TaskContentCoordinateV1;
  objectId: string;
  namespaceId: string;
  domainId: string;
  requesterHumanId: string;
  deviceId: string;
  hostAuthorizationRevision: number;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  keyGeneration: number;
  bindingHashBase64url: string;
  sourceDigestBase64url: string;
  sourcePayloadHashBase64url: string;
  operationalFieldsDigestBase64url: string;
  planDigestBase64url: string;
  expiresAt: number;
}>;

function plan(current: HeldTaskContentBackfillAuthority): TaskContentBackfillPublicationPlan | null {
  const source = current.source.classification;
  if (source.status !== "supported") return null;
  const candidate = current.claim.candidate;
  const coordinate: TaskContentCoordinateV1 = Object.freeze(candidate.kind === "definition"
    ? { kind: "definition" as const, taskId: candidate.taskId, contentRevision: 1 }
    : { kind: "run_result" as const, taskId: candidate.taskId,
        taskRunId: candidate.taskRunId, contentRevision: 1 });
  const objectId = deriveTaskHistoricalContentCryptoObjectIdV1({ coordinate,
    sourceDigest: source.sourceDigest, namespaceId: current.authority.namespaceId });
  const unsigned = Object.freeze({
    planVersion: 1 as const, claimId: current.claim.claimId,
    operationId: `task-historical-publish:${objectId.split(":").at(-1)!}`,
    coordinate, objectId,
    namespaceId: current.authority.namespaceId, domainId: current.authority.domainId,
    requesterHumanId: current.authority.requesterHumanId,
    deviceId: current.claim.deviceId,
    hostAuthorizationRevision: current.hostAuthorizationRevision,
    expectedAccessRevision: current.authority.expectedAccessRevision,
    expectedPolicyRevision: current.authority.expectedPolicyRevision,
    keyGeneration: current.namespace.namespaceKeyGeneration,
    bindingHashBase64url: encode(current.namespace.bundleDigest),
    sourceDigestBase64url: encode(source.sourceDigest),
    sourcePayloadHashBase64url: encode(source.sourcePayloadHash),
    operationalFieldsDigestBase64url: encode(source.operationalFieldsDigest),
    expiresAt: Math.min(current.claim.expiresAt.getTime(), current.admissionExpiresAt),
  });
  // The signed request binds its own deadline. Renewing the same lease or
  // device admission must not invalidate an otherwise-current source plan.
  const { expiresAt: _expiry, ...digestCoordinates } = unsigned;
  return Object.freeze({ ...unsigned,
    planDigestBase64url: createHash("sha256")
      .update("nautilo/task-content-backfill-publication-plan/v1\n")
      .update(JSON.stringify(digestCoordinates)).digest("base64url") });
}

export type TaskContentBackfillPreparedPublication = Readonly<{
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  signedPublicationRequestBytes: Uint8Array;
}>;

export type TaskContentBackfillPublicationSource = Readonly<{
  status: "source";
  plan: TaskContentBackfillPublicationPlan;
  payloadBytesBase64url: string;
  sourceRoomId: string;
}> | Readonly<{ status: Exclude<HeldTaskContentBackfillAuthority["source"]["classification"]["status"], "supported"> }>;

type Input = Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  now?: () => number;
}>;

/** Device source preparation, durable crypto stage, and atomic historical mapping. */
export function createTaskContentBackfillPublication(input: Input) {
  const authority = createTaskContentBackfillAuthority(input);
  const now = input.now ?? Date.now;

  const inspect = async (current: HeldTaskContentBackfillAuthority,
    expected: TaskContentBackfillPublicationPlan) => {
    const source = current.source.classification;
    if (source.status !== "supported") return null;
    const handle = await verifyCryptoPostgresHandle(input.restricted);
    const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
    return inspectStagedHistoricalTaskContentPublication({
      handle, crypto: input.crypto, objectId: expected.objectId,
      expected: { coordinate: expected.coordinate, operationId: expected.operationId,
        sourceDigest: source.sourceDigest, sourcePayloadHash: source.sourcePayloadHash,
        operationalFieldsDigest: source.operationalFieldsDigest,
        requesterHumanId: current.authority.requesterHumanId,
        namespaceId: current.authority.namespaceId },
      currentAuthority: current.authority, assertCurrent: current.assertCurrent,
      resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
      resolveHistoricalHumanDeviceSigningPublicKey:
        createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle),
    });
  };

  const map = async (current: HeldTaskContentBackfillAuthority,
    expected: TaskContentBackfillPublicationPlan,
    staged: VerifiedStagedHistoricalTaskContentPublication) => {
    const source = current.source.classification;
    if (source.status !== "supported") return false;
    const handle = await verifyCryptoPostgresHandle(current.restricted);
    const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
    const product = new PostgresTaskContentProductStore(
      await verifyConversationProductPostgresHandle(current.product),
      ({ requesterHumanId, namespaceId }) => {
        current.assertCurrent();
        return requesterHumanId === current.authority.requesterHumanId
          && namespaceId === current.authority.namespaceId ? current.authority : null;
      },
      () => current.assertCurrent(), undefined,
      async (borrowed, proof) => {
        current.assertCurrent();
        if (!current.isCurrentProductTransaction(borrowed)) return false;
        const fresh = await readTaskContentBackfillSource(current.transaction, current.claim);
        if (fresh?.classification.status !== "supported"
          || proof.provenance.version !== 2
          || proof.provenance.sourceDigest !== hex(fresh.classification.sourceDigest)
          || proof.provenance.sourcePayloadHash !== hex(fresh.classification.sourcePayloadHash)
          || proof.provenance.signedRequestDigest !== hex(staged.signedRequestDigest)
          || proof.provenance.genesisManifestHash !== hex(staged.genesisManifestHash)) return false;
        return equal(fresh.classification.sourceDigest, source.sourceDigest);
      },
    );
    const repository = createDormantTaskContentShadowRepository({ product,
      crypto: createPostgresTaskContentCryptoCompletion({
        handle, crypto: input.crypto,
        resolveCurrentAuthority: () => {
          current.assertCurrent(); return Promise.resolve(current.authority);
        },
        resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
        resolveHistoricalHumanDeviceSigningPublicKey:
          createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle),
      }),
    });
    // The caller owns this one canonical transaction. A failed completion or
    // mapping must throw so its historical reservation cannot commit alone.
    const reserved = await repository.reserveRevision({
      operationId: expected.operationId, requestDigest: staged.signedRequestDigest,
      representation: "dual", authority: staged.originalAuthority,
      prepared: staged.prepared, historicalRepair: true,
      operationalMetadata: expected.coordinate.kind === "definition"
        ? source.operationalMetadata : null,
    });
    if (reserved.status !== "reserved" && reserved.status !== "replayed") {
      throw new Error("Historical Task repair reservation did not match current source");
    }
    const completed = await repository.completeRevision({
      coordinate: expected.coordinate, prepared: staged.prepared,
    });
    if (completed.status !== "mapped" && completed.status !== "replayed") {
      throw new Error("Historical Task repair mapping is pending");
    }
    current.assertCurrent();
    return true;
  };

  return Object.freeze({
    source(subject: TaskContentBackfillSubject, claimId: string) {
      return authority.withCurrent<TaskContentBackfillPublicationSource>({ subject, claimId, use: current => {
        const classification = current.source.classification;
        if (classification.status !== "supported") {
          return Promise.resolve(Object.freeze({ status: classification.status }));
        }
        const preparedPlan = plan(current);
        if (preparedPlan === null) throw new Error("Supported historical Task source has no publication plan");
        const payload = classification.kind === "definition"
          ? encodeTaskPayloadV1(classification.payload)
          : encodeTaskRunResultPayloadV1(classification.payload);
        try {
          return Promise.resolve(Object.freeze({ status: "source" as const, plan: preparedPlan,
            sourceRoomId: current.roomId, payloadBytesBase64url: encode(payload) }));
        } finally { payload.fill(0); }
      } });
    },
    async publish(subject: TaskContentBackfillSubject, claimId: string,
      upload: TaskContentBackfillPreparedPublication) {
      const owned = Object.freeze({ payloadBytes: Uint8Array.from(upload.payloadBytes),
        manifestBytes: Uint8Array.from(upload.manifestBytes),
        envelopeBytes: Uint8Array.from(upload.envelopeBytes),
        signedPublicationRequestBytes: Uint8Array.from(upload.signedPublicationRequestBytes) });
      try {
        return await authority.withCurrent({ subject, claimId, use: async current => {
          const expected = plan(current);
          const source = current.source.classification;
          if (expected === null || source.status !== "supported") return false;
          let staged = await inspect(current, expected);
          if (staged === null) {
            const prepared = await authenticatePreparedHistoricalTaskContentCryptoRevisionV1({
              ...owned, crypto: input.crypto, now: now(),
              operationId: expected.operationId, claimId: current.claim.claimId,
              coordinate: expected.coordinate, authority: current.authority,
              sourceDigest: source.sourceDigest, sourcePayloadHash: source.sourcePayloadHash,
              operationalFieldsDigest: source.operationalFieldsDigest,
              planDigest: Buffer.from(expected.planDigestBase64url, "base64url"),
              resolveCurrentAuthority: request => {
                current.assertCurrent();
                return Promise.resolve(request.committerDeviceId === current.claim.deviceId
                  && request.hostAuthorizationRevision === current.hostAuthorizationRevision
                  && request.keyGeneration === current.namespace.namespaceKeyGeneration
                  && equal(request.bindingHash, current.namespace.bundleDigest)
                  && request.deadlineAt <= current.claim.expiresAt.getTime()
                  && request.deadlineAt <= current.admissionExpiresAt
                  ? current.signingPublicKey.slice() : null);
              },
            });
            // This separate owned crypto transaction commits before the
            // borrowed product transaction can publish its FK mapping.
            const handle = await verifyCryptoPostgresHandle(input.restricted);
            const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
            await stageHistoricalTaskContentPublication({
              handle, crypto: input.crypto, prepared, currentAuthority: current.authority,
              assertCurrent: current.assertCurrent,
              resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
              resolveHistoricalHumanDeviceSigningPublicKey:
                createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle),
            });
            staged = await inspect(current, expected);
          }
          if (staged === null) throw new Error("Historical Task repair stage is not durable");
          return map(current, expected, staged);
        } });
      } finally { for (const bytes of Object.values(owned)) bytes.fill(0); }
    },
    recover(subject: TaskContentBackfillSubject, claimId: string) {
      return authority.withCurrent({ subject, claimId, purpose: "read", use: async current => {
        const expected = plan(current);
        if (expected === null) return false;
        const staged = await inspect(current, expected);
        return staged === null ? false : map(current, expected, staged);
      } });
    },
  });
}
