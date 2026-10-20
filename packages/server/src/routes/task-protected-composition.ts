import { createHash } from "node:crypto";

import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  ProtectedTaskDefinitionReadReadyEnvelopeV1,
  ProtectedTaskRunResultReadEnvelopeV1,
  ProtectedTaskRunResultReadReadyEnvelopeV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
  ProtectedTaskPublicationPlanRequestV1,
  ProtectedTaskPublicationPlanV1,
} from "@nautilo/api-client";
import {
  validateTaskModelSelectionForCreate,
} from "@nautilo/agent";
import {
  and,
  asc,
  createPostgresJsBridgeConnection,
  encryptionTransitionPolicy,
  eq,
  gte,
  getLatestRunModelByTask,
  getOwnerAgentDisplayNamesByAgentId,
  getTaskById,
  getTaskByIdWithMutationVersion,
  getProtectedTaskMutationSourceById,
  humanCryptoDevices,
  inArray,
  lte,
  objectCryptoAccessManifests,
  taskDefinitionCryptoRevisions,
  taskRuns,
  taskRunResultCryptoRevisions,
  tasks,
  updateTaskIfCurrent,
  type DirectDatabase,
  type NewTask,
  type PostgresJsBridgeConnection,
  type Task,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  deriveTaskContentCryptoObjectIdV1,
  encodeTaskDefinitionContent,
  hasTaskOrdinaryFallbackReceiptV1,
  parseTaskHistoricalRepairProvenanceV1,
  prepareTaskOrdinaryFallbackRepairSourceProofV1,
  parseTaskDefinitionForegroundAuthorizationIdV1,
  taskContentRevisionObjectIdV1,
  type EncryptionDataOperationOwner,
  type TaskHistoricalRepairProvenanceV1,
  type TaskContentAuthorityV1,
  type TaskContentPayloadV1,
  type TaskOrdinaryFallbackRepairSourceProofV1,
} from "@nautilo/lattice-bridge";
import {
  createPostgresTaskContentRepositoryV1,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  destroyVerifiedStoredObjectAccessManifestChainV5,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage,
  PostgresNamespaceProductAuthority,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  verifyCryptoPostgresHandle,
  verifyStoredObjectAccessManifestChainV5,
  refreshHumanMappedTaskContentAccessHead,
  withCurrentHumanDeviceSigningAuthority,
  type ResolveForegroundAgentAcceptedExecutionEvidence,
} from "@nautilo/lattice-bridge/server";
import {
  LatticeCrypto,
  type HumanTaskPublicationRequest,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanTaskPublicationRequestV1,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  computeNextFireAt,
  createHumanApiTaskCreationProvenance,
  createTask as runtimeCreateTask,
  getPlaintextTaskCreationAdmission,
  type TaskCreateInput,
} from "@nautilo/runtime";
import {
  classifyProtectedTaskMetadataV1,
  parseProtectedTaskOperationalMetadataProjectionV1,
  reconstructProtectedTaskMetadataV1,
  type ProtectedTaskOperationalMetadataProjectionV1,
  type ListTasksQuery,
  type TaskContentListV1,
  type TaskContentSummaryV1,
  type TaskCreateResponse,
} from "@nautilo/types";
import {
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  createAcceptedInvocationAuthority,
} from "@nautilo/trust";

import { createHumanProductTransactionContext } from "./human-message-product-store";
import type { CurrentDeviceAdmission } from "../auth/device-admission-gate";
import { importProtectedTaskPublicationV1 } from "./task-protected-publication";
import { prepareProtectedTaskScope } from "./protected-task-scope-creation";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";
import { createProtectedTaskDefinitionForegroundAuthorizationResolver } from
  "./protected-task-runtime-access-lineage";
import { listProtectedTaskContentV1, toTaskContentSummaryV1 } from "./tasks";

export type ProtectedTaskRouteAuthority = Readonly<{
  userId: string;
  subjectHumanId: string;
  actorId: string;
  agentId: string;
  deviceId: string;
  deviceGeneration: number;
  admission?: CurrentDeviceAdmission;
}>;

export interface ProtectedTaskRoutePorts {
  list(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    query: ListTasksQuery;
  }>): Promise<TaskContentListV1>;
  readDefinition(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    objectId: string;
    contentRevision: number;
    cryptoAccessRevision: number;
  }>): Promise<ProtectedTaskDefinitionReadReadyEnvelopeV1>;
  readRunResult(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    taskRunId: string;
  }>): Promise<ProtectedTaskRunResultReadEnvelopeV1>;
  plan(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string | null;
    request: ProtectedTaskPublicationPlanRequestV1;
  }>): Promise<ProtectedTaskPublicationPlanV1>;
  publishCreate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    prepared: ProtectedTaskPreparedCreateRequestV1 | DualTaskPreparedCreateRequestV1;
  }>): Promise<TaskCreateResponse>;
  publishUpdate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    prepared: ProtectedTaskPreparedUpdateRequestV1 | DualTaskPreparedUpdateRequestV1;
  }>): Promise<TaskContentSummaryV1>;
}

export class ProtectedTaskRouteError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtectedTaskRouteError";
  }
}

declare const PROTECTED_TASK_TEST_AUTHORITY: unique symbol;
export type ProtectedTaskTestAuthority = Readonly<{
  [PROTECTED_TASK_TEST_AUTHORITY]: true;
}>;

type ProtectedTaskTestComposition = Readonly<{
  mode: "protected_task_test_shadow";
  target: ProtectedTaskRouteAuthority;
  ports: ProtectedTaskRoutePorts;
}>;

type ProtectedTaskProductionComposition = Readonly<{
  mode: "protected_task_production";
  ports: ProtectedTaskRoutePorts;
}>;

export type ProtectedTaskComposition =
  | ProtectedTaskTestComposition
  | ProtectedTaskProductionComposition;

const testAuthorities = new WeakSet<object>();
const testCompositions = new WeakSet<object>();
const productionCompositions = new WeakSet<object>();

export function createProtectedTaskTestAuthority(): ProtectedTaskTestAuthority {
  const authority = Object.freeze({}) as ProtectedTaskTestAuthority;
  testAuthorities.add(authority);
  return authority;
}

export function createProtectedTaskTestComposition(input: Readonly<{
  authority: ProtectedTaskTestAuthority;
  target: ProtectedTaskRouteAuthority;
  ports: ProtectedTaskRoutePorts;
}>): ProtectedTaskComposition {
  if (!testAuthorities.has(input.authority as object)) {
    throw new TypeError("Protected Task test authority is not recognized");
  }
  const composition = Object.freeze({
    mode: "protected_task_test_shadow" as const,
    target: Object.freeze({ ...input.target }),
    ports: input.ports,
  });
  testCompositions.add(composition);
  return composition;
}

function sameAuthority(
  left: ProtectedTaskRouteAuthority,
  right: ProtectedTaskRouteAuthority,
): boolean {
  return left.userId === right.userId
    && left.subjectHumanId === right.subjectHumanId
    && left.actorId === right.actorId
    && left.agentId === right.agentId
    && left.deviceId === right.deviceId
    && left.deviceGeneration === right.deviceGeneration;
}

/** Resolve an owner-visible Task through its durable agent binding. */
export function resolveOwnedProtectedTaskAuthority(
  authority: ProtectedTaskRouteAuthority,
  task: Pick<Task, "ownerId" | "agentId">,
): ProtectedTaskRouteAuthority | null {
  if (task.ownerId !== authority.userId) return null;
  return task.agentId === authority.agentId
    ? authority
    : Object.freeze({ ...authority, agentId: task.agentId });
}

export function resolveProtectedTaskComposition(input: Readonly<{
  composition: ProtectedTaskComposition;
  authority: ProtectedTaskRouteAuthority;
}>): ProtectedTaskRoutePorts | null {
  if (productionCompositions.has(input.composition as object)
    && input.composition.mode === "protected_task_production") {
    return input.composition.ports;
  }
  return testCompositions.has(input.composition as object)
      && input.composition.mode === "protected_task_test_shadow"
      && sameAuthority(input.composition.target, input.authority)
    ? input.composition.ports
    : null;
}

type OperationalCreate = Extract<
  ProtectedTaskPublicationPlanRequestV1,
  { operation: "create" }
>["task"];
type OperationalUpdate = Extract<
  ProtectedTaskPublicationPlanRequestV1,
  { operation: "update" }
>["task"];
type TaskDefinitionPayload = Extract<
  TaskContentPayloadV1,
  { coordinate: { kind: "definition" } }
>["payload"];

function historicalRepairV2(
  value: unknown,
): Extract<TaskHistoricalRepairProvenanceV1, { version: 2 }> | null {
  if (value === null || value === undefined) return null;
  const parsed = parseTaskHistoricalRepairProvenanceV1(value);
  if (parsed.version !== 2) {
    throw new TypeError("Historical Task read provenance is unsupported");
  }
  return parsed;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

type ForegroundAgentSignerPrincipal = Parameters<
  ResolveForegroundAgentAcceptedExecutionEvidence
>[0];

type RetainedForegroundAgentExecution = Readonly<{
  principal: ForegroundAgentSignerPrincipal;
  planBytes: Uint8Array;
  planDigest: Uint8Array;
  acceptedAuthority?: Readonly<{
    subjectHumanId: string;
    authorizedNamespaces: readonly Readonly<{ namespaceId: string; domainId: string }>[];
  }>;
}>;

function sameForegroundAgentSigner(
  left: ForegroundAgentSignerPrincipal,
  right: ForegroundAgentSignerPrincipal,
): boolean {
  return left.agentId === right.agentId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.signerKeyId === right.signerKeyId;
}

/**
 * Lend a retained foreground signer to the manifest verifier while retaining
 * only the portable accepted-plan proof that the Human client can authenticate.
 */
export function createProtectedTaskForegroundSignerTransport(input: Readonly<{
  resolveEvidence: ResolveForegroundAgentAcceptedExecutionEvidence;
}>) {
  let retained: RetainedForegroundAgentExecution | null = null;
  return Object.freeze({
    resolveSigner: async (
      principal: ForegroundAgentSignerPrincipal,
    ): Promise<Uint8Array | null> => {
      const evidence = await input.resolveEvidence(principal);
      if (evidence === null) return null;
      try {
        const next = Object.freeze({
          principal: Object.freeze({ ...principal }),
          planBytes: Uint8Array.from(evidence.planBytes),
          planDigest: Uint8Array.from(evidence.planDigest),
          ...(evidence.acceptedAuthority === undefined ? {} : {
            acceptedAuthority: Object.freeze({
              subjectHumanId: evidence.acceptedAuthority.subjectHumanId,
              authorizedNamespaces: Object.freeze(evidence.acceptedAuthority
                .authorizedNamespaces.map(entry => Object.freeze({ ...entry }))),
            }),
          }),
        });
        if (retained !== null && (
          !sameForegroundAgentSigner(retained.principal, next.principal)
          || !sameBytes(retained.planBytes, next.planBytes)
          || !sameBytes(retained.planDigest, next.planDigest)
        )) {
          next.planBytes.fill(0);
          next.planDigest.fill(0);
          throw new TypeError("Foreground Task signer evidence was substituted");
        }
        if (retained === null) retained = next;
        return Uint8Array.from(evidence.signerPublicKey);
      } finally {
        evidence.signerPublicKey.fill(0);
        evidence.planBytes.fill(0);
        evidence.planDigest.fill(0);
      }
    },
    resolveDefinitionSigner: async (
      principal: ForegroundAgentSignerPrincipal,
      parentOperationHash: Uint8Array,
    ): Promise<Uint8Array | null> => {
      const evidence = await input.resolveEvidence(principal, {
        parentOperationHash,
      });
      if (evidence === null) return null;
      try {
        const next = Object.freeze({
          principal: Object.freeze({ ...principal }),
          planBytes: Uint8Array.from(evidence.planBytes),
          planDigest: Uint8Array.from(evidence.planDigest),
          ...(evidence.acceptedAuthority === undefined ? {} : {
            acceptedAuthority: Object.freeze({
              subjectHumanId: evidence.acceptedAuthority.subjectHumanId,
              authorizedNamespaces: Object.freeze(evidence.acceptedAuthority
                .authorizedNamespaces.map(entry => Object.freeze({ ...entry }))),
            }),
          }),
        });
        if (retained !== null) {
          next.planBytes.fill(0);
          next.planDigest.fill(0);
          throw new TypeError("Foreground Task definition evidence was duplicated");
        }
        retained = next;
        return Uint8Array.from(evidence.signerPublicKey);
      } finally {
        evidence.signerPublicKey.fill(0);
        evidence.planBytes.fill(0);
        evidence.planDigest.fill(0);
      }
    },
    evidenceFor: (
      principal: ForegroundAgentSignerPrincipal,
      expectedAgentId: string,
    ) => retained !== null
      && principal.agentId === expectedAgentId
      && sameForegroundAgentSigner(retained.principal, principal)
      ? Object.freeze({
          kind: "foreground_agent_accepted_execution" as const,
          planBytesBase64url: Buffer.from(retained.planBytes).toString("base64url"),
          planDigestBase64url: Buffer.from(retained.planDigest).toString("base64url"),
        })
      : null,
    definitionEvidenceFor: (
      principal: ForegroundAgentSignerPrincipal,
      expected: Readonly<{
        taskAgentId: string;
        subjectHumanId: string;
        domainId: string;
        namespaceId: string;
      }>,
    ) => retained !== null
      && sameForegroundAgentSigner(retained.principal, principal)
      && (principal.agentId === expected.taskAgentId
        || retained.acceptedAuthority?.subjectHumanId
          === expected.subjectHumanId
          && retained.acceptedAuthority.authorizedNamespaces.some(entry =>
            entry.domainId === expected.domainId
              && entry.namespaceId === expected.namespaceId))
      ? Object.freeze({
          kind: "foreground_agent_accepted_execution" as const,
          planBytesBase64url: Buffer.from(retained.planBytes).toString("base64url"),
          planDigestBase64url: Buffer.from(retained.planDigest).toString("base64url"),
        })
      : null,
    destroy: () => {
      retained?.planBytes.fill(0);
      retained?.planDigest.fill(0);
      retained = null;
    },
  });
}

type ProtectedTaskRunResultForegroundSignerEvidence = Extract<
  ProtectedTaskRunResultReadReadyEnvelopeV1["signerEvidence"][number],
  { kind: "foreground_agent_accepted_execution" }
>;

type ProtectedTaskRunResultAgentSignerEvidence =
  | ProtectedTaskRunResultForegroundSignerEvidence
  | Readonly<{
    kind: "agent_runtime_publication" | "task_runtime_signer_certificate";
    evidenceBytesBase64url: string;
  }>;

/** Project the already verified native Task signer evidence onto the public
 * result-read transport while preserving its authenticated evidence kind. */
export function projectVerifiedProtectedTaskRunResultAgentSignerEvidence(
  input: Readonly<{
    verifiedSignerEvidence: Awaited<ReturnType<
      typeof verifyStoredObjectAccessManifestChainV5
    >>["signerEvidence"];
    foregroundEvidence: ProtectedTaskRunResultForegroundSignerEvidence | null;
  }>,
): readonly ProtectedTaskRunResultAgentSignerEvidence[] | null {
  if (input.foregroundEvidence !== null) {
    return input.verifiedSignerEvidence.length === 0
      ? Object.freeze([input.foregroundEvidence])
      : null;
  }
  if (input.verifiedSignerEvidence.length !== 1) return null;
  const evidence = input.verifiedSignerEvidence[0]!;
  if (evidence.kind !== "agent_runtime_publication"
    && evidence.kind !== "task_runtime_signer_certificate") return null;
  return Object.freeze([Object.freeze({
    kind: evidence.kind,
    evidenceBytesBase64url:
      Buffer.from(evidence.evidenceBytes).toString("base64url"),
  })]);
}

type HumanSignerContext = Readonly<{
  subjectHumanId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
}>;

function humanSignerCoordinate(input: HumanSignerContext): string {
  return `${input.subjectHumanId}\0${input.committerDeviceId}\0${input.hostAuthorizationRevision}`;
}

function exactDatabaseCounter(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function createProtectedTaskHumanSignerTransport(
  resolveHistoricalHumanDeviceSigningPublicKey: (
    context: HumanSignerContext,
  ) => Promise<Uint8Array | null>,
) {
  const retained = new Map<string, Readonly<{
    context: HumanSignerContext;
    key: Uint8Array;
  }>>();
  return Object.freeze({
    resolve: async (context: HumanSignerContext): Promise<Uint8Array | null> => {
      const resolved = await resolveHistoricalHumanDeviceSigningPublicKey(
        context,
      );
      if (resolved === null) return null;
      const coordinate = humanSignerCoordinate(context);
      const key = Uint8Array.from(resolved);
      const existing = retained.get(coordinate);
      if (existing !== undefined && !sameBytes(existing.key, key)) {
        key.fill(0);
        resolved.fill(0);
        throw new TypeError("Foreground Task Human signer evidence collided");
      }
      if (existing === undefined) {
        retained.set(coordinate, Object.freeze({
          context: Object.freeze({ ...context }),
          key,
        }));
      } else {
        key.fill(0);
      }
      return resolved;
    },
    evidence: () => Object.freeze([...retained.values()].map(entry =>
      Object.freeze({
        kind: "human_device" as const,
        subjectHumanId: entry.context.subjectHumanId,
        committerDeviceId: entry.context.committerDeviceId,
        hostAuthorizationRevision: entry.context.hostAuthorizationRevision,
        signingPublicKeyBase64url: Buffer.from(entry.key).toString("base64url"),
      }))),
    destroy: () => {
      retained.forEach(entry => entry.key.fill(0));
      retained.clear();
    },
  });
}

function wipeDecodedAccessManifest(
  manifest: ReturnType<typeof decodeObjectAccessManifestV5>,
): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach(value => value.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  manifest.signature.fill(0);
}

function validateProtectedTaskReadManifestSigners(input: Readonly<{
  crypto: LatticeCrypto;
  chain: readonly Uint8Array[];
  expectedAgentId: string;
  requesterHumanId: string;
  historicalRepair: Extract<TaskHistoricalRepairProvenanceV1, { version: 2 }> | null;
  allowHumanGenesis: boolean;
  allowForegroundDefinitionAuthor?: boolean;
}>): "agent_runtime" | "human_device" {
  if (input.chain.length === 0) {
    throw new TypeError("Protected Task access chain is empty");
  }
  let genesisKind: "agent_runtime" | "human_device" | null = null;
  for (let index = 0; index < input.chain.length; index += 1) {
    const manifest = decodeObjectAccessManifestV5(input.chain[index]!);
    try {
      if (index === 0) {
        if (manifest.accessRevision !== 0
          || manifest.previousManifestHash !== null) {
          throw new TypeError("Protected Task access genesis is invalid");
        }
        if (manifest.signer.kind === "agent_runtime"
          && input.historicalRepair === null
          && (manifest.signer.agentId === input.expectedAgentId
            || input.allowForegroundDefinitionAuthor === true)) {
          genesisKind = "agent_runtime";
        } else if (manifest.signer.kind === "human_device"
          && (input.allowHumanGenesis || input.historicalRepair !== null)
          && manifest.signer.subjectHumanId === input.requesterHumanId) {
          genesisKind = "human_device";
        } else {
          throw new TypeError("Protected Task access genesis signer is invalid");
        }
        if (input.historicalRepair !== null) {
          const digest = input.crypto.hash(input.chain[0]!);
          try {
            if (manifest.signer.kind !== "human_device"
              || manifest.signer.committerDeviceId
                !== input.historicalRepair.publisherDeviceId
              || hex(digest) !== input.historicalRepair.genesisManifestHash) {
              throw new TypeError(
                "Protected Task historical access genesis is invalid",
              );
            }
          } finally {
            digest.fill(0);
          }
        }
      } else if (manifest.signer.kind !== "human_device"
        || manifest.signer.subjectHumanId !== input.requesterHumanId) {
        throw new TypeError("Protected Task access rewrap signer is invalid");
      }
    } finally {
      wipeDecodedAccessManifest(manifest);
    }
  }
  return genesisKind!;
}

type ProductionDependencies = Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  observer: { kick(): void };
  now?: () => number;
  resolveRequesterPrivateRoom?: ProtectedTaskRequesterPrivateRoomResolver;
}>;

type ProtectedTaskReadAuthorityCoordinate = Readonly<{
  generation: number;
  accessRevision: number;
}>;

type ProtectedTaskNamespaceReadAuthority =
  ProtectedTaskDefinitionReadReadyEnvelopeV1["readAuthority"];

function toBase64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** Resolve public Namespace read metadata only while the exact canonical
 * requester-private Room and its current membership remain established. */
export function createProtectedTaskPrivateReadAuthorityResolver(input: Readonly<{
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  productAuthority: Pick<
    PostgresNamespaceProductAuthority,
    "withCurrentPrivateRoom"
  >;
  domainKeys: Pick<
    PostgresDomainKeyAuthorityRepository,
    "inspectNamespaceGenerationAuthorityMetadata"
  >;
}>) {
  return async (
    authority: ProtectedTaskRouteAuthority,
    expectedNamespaceId: string,
    requested: ProtectedTaskReadAuthorityCoordinate,
  ): Promise<ProtectedTaskNamespaceReadAuthority | null> => {
    const privateRoom = await input.resolveRequesterPrivateRoom(
      authority.userId,
      authority.agentId,
      expectedNamespaceId,
    );
    if (privateRoom === null
      || privateRoom.namespaceId !== expectedNamespaceId) return null;
    return input.productAuthority.withCurrentPrivateRoom({
      subjectUserId: authority.userId,
      subjectHumanId: authority.subjectHumanId,
      roomId: privateRoom.roomId,
      namespaceId: expectedNamespaceId,
      use: async () => {
        const inspected = await input.domainKeys
          .inspectNamespaceGenerationAuthorityMetadata({
            namespaceId: expectedNamespaceId,
            keyClass: "ai",
            requested: [requested],
          });
        if (inspected.status !== "ready") return null;
        try {
          if (inspected.namespaceId !== expectedNamespaceId
            || !inspected.retainedGenerations.some(entry =>
              entry.generation === inspected.currentGeneration)
            || !inspected.retainedGenerations.some(entry =>
              entry.generation === requested.generation
              && entry.accessRevision === requested.accessRevision)) return null;
          return Object.freeze({
            sourceRoomId: privateRoom.roomId,
            namespaceId: expectedNamespaceId,
            currentGeneration: inspected.currentGeneration,
            retainedGenerations:
              inspected.retainedGenerations.map(entry => Object.freeze({
                generation: entry.generation,
                accessRevision: entry.accessRevision,
                headDigestBase64url: toBase64url(entry.headDigest),
                publicationDigestBase64url:
                  toBase64url(entry.publicationDigest),
                publicationSetDigestBase64url:
                  toBase64url(entry.publicationSetDigest),
                audienceFingerprintBase64url:
                  toBase64url(entry.audienceFingerprint),
              })),
          });
        } finally {
          inspected.retainedGenerations.forEach(entry => {
            entry.headDigest.fill(0);
            entry.publicationDigest.fill(0);
            entry.publicationSetDigest.fill(0);
            entry.audienceFingerprint.fill(0);
          });
        }
      },
    });
  };
}

async function resolveProtectedTaskEnvelopeReadAuthority(input: Readonly<{
  objectId: string;
  namespaceId: string;
  envelopeBytes: Uint8Array;
  authority: ProtectedTaskRouteAuthority;
  resolveReadAuthority: ReturnType<
    typeof createProtectedTaskPrivateReadAuthorityResolver
  >;
}>): Promise<ProtectedTaskNamespaceReadAuthority | null> {
  const envelope = decodeNamespaceObjectEnvelopeV2(input.envelopeBytes);
  try {
    if (envelope.context.objectId !== input.objectId
      || envelope.context.namespaceId !== input.namespaceId
      || envelope.context.keyClass !== "ai") {
      throw new TypeError("Protected Task Namespace envelope is invalid");
    }
    return input.resolveReadAuthority(
      input.authority,
      input.namespaceId,
      {
        generation: envelope.context.keyGeneration,
        accessRevision: envelope.context.bindingRevisionAtWrap,
      },
    );
  } finally {
    envelope.wrappedDek.fill(0);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Protected Task plan is not canonical");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digestJson(crypto: LatticeCrypto, value: unknown): string {
  const bytes = new TextEncoder().encode(
    `nautilo/protected-task-publication-plan/v1\n${canonicalJson(value)}`,
  );
  try { return Buffer.from(crypto.hash(bytes)).toString("base64url"); }
  finally { bytes.fill(0); }
}

export function deterministicTaskId(
  authority: ProtectedTaskRouteAuthority,
  operationId: string,
): string {
  const digest = createHash("sha256").update([
    "nautilo/protected-task-id/v1",
    authority.subjectHumanId,
    authority.agentId,
    operationId,
  ].join("\n")).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  digest.fill(0);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseRunAt(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ProtectedTaskRouteError(400, "invalid_schedule", "Task runAt is invalid");
  }
  return date;
}

export function validateSchedule(input: Readonly<{
  scheduleKind: Task["scheduleKind"];
  runAt: Date | null | undefined;
  cron: string | null | undefined;
  timezone: string;
}>): void {
  try {
    computeNextFireAt(
      input.scheduleKind,
      input.runAt,
      input.cron,
      input.timezone,
    );
  } catch (error) {
    throw new ProtectedTaskRouteError(
      400,
      "invalid_schedule",
      error instanceof Error ? error.message : "Task schedule is invalid",
    );
  }
}

export function toolsFields(
  tools: readonly string[] | undefined,
): Pick<NewTask, "toolsMode" | "toolsWhitelist"> | Record<string, never> {
  if (tools === undefined) return {};
  return tools.length === 0
    ? { toolsMode: "none", toolsWhitelist: [] }
    : { toolsMode: "whitelist", toolsWhitelist: [...tools] };
}

function metadataFor(task: Pick<Task, "metadata">) {
  const classified = classifyProtectedTaskMetadataV1(task.metadata ?? {});
  if (classified.status !== "supported") {
    throw new ProtectedTaskRouteError(
      409,
      "task_metadata_unsupported",
      "Task metadata cannot be protected",
    );
  }
  return classified.operational;
}

function emptyMetadata() {
  return metadataFor({ metadata: {} });
}

export function validateCreateShape(task: OperationalCreate): void {
  if (task.parentTaskId != null) {
    throw new ProtectedTaskRouteError(
      422,
      "nested_task_unsupported",
      "Protected nested Tasks are not supported",
    );
  }
  validateSelection(task);
}

function validateSelection(
  task: Pick<OperationalCreate, "requestedModelId" | "selectionProfile"
    | "selectionSpec" | "tools">,
): void {
  const selectedTools = toolsFields(task.tools);
  const error = validateTaskModelSelectionForCreate({
    requestedModelId: task.requestedModelId,
    profile: task.selectionProfile,
    spec: task.selectionSpec,
    toolsMode: "toolsMode" in selectedTools ? selectedTools.toolsMode : "auto",
    toolsWhitelist: "toolsWhitelist" in selectedTools
      ? selectedTools.toolsWhitelist : undefined,
  });
  if (error !== null) {
    throw new ProtectedTaskRouteError(422, "task_selection_invalid", error);
  }
}

export function taskCreateInput(
  authority: ProtectedTaskRouteAuthority,
  taskId: string,
  task: OperationalCreate,
  payload: TaskDefinitionPayload | null,
): TaskCreateInput {
  validateCreateShape(task);
  return {
    id: taskId,
    ownerId: authority.userId,
    requestorId: authority.userId,
    agentId: authority.agentId,
    prompt: payload?.prompt ?? "",
    expectedOutput: payload?.expectedOutput ?? null,
    metadata: emptyMetadata(),
    scheduleKind: task.scheduleKind ?? "now",
    runAt: parseRunAt(task.runAt) ?? null,
    cron: task.cron ?? null,
    timezone: task.timezone ?? "UTC",
    targetChat: task.targetChat ?? "orphan",
    resultDelivery: task.resultDelivery ?? "wake",
    useScope: task.useScope ?? false,
    ...(task.scopeId == null ? {} : { scopeId: task.scopeId }),
    ...(task.timeLimitSeconds === undefined
      ? {} : { timeLimitSeconds: task.timeLimitSeconds }),
    ...(task.selectionProfile === undefined
      ? {} : { selectionProfile: task.selectionProfile }),
    ...(task.selectionSpec === undefined
      ? {} : { selectionSpec: task.selectionSpec }),
    ...(task.requestedModelId === undefined
      ? {} : { requestedModelId: task.requestedModelId }),
    preset: "task",
    depth: 0,
    ...toolsFields(task.tools),
  };
}

function readCreatedTask(
  current: Task | undefined,
  authority: ProtectedTaskRouteAuthority,
): Task {
  if (current === undefined || current.ownerId !== authority.userId
    || current.agentId !== authority.agentId) {
    throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
  }
  // The requested schedule was stored with the paused placeholder and its
  // mapping atomically made the task pending. A replay must only observe the
  // current task; recomputing the schedule could resurrect a completed run.
  return current;
}

export function taskUpdatePatch(
  current: Task,
  task: OperationalUpdate,
  payload: TaskDefinitionPayload | null,
  operationalMetadata: ProtectedTaskOperationalMetadataProjectionV1 = metadataFor(current),
): Partial<NewTask> {
  const patch: Partial<NewTask> = {
    metadata: operationalMetadata,
    ...(payload === null ? {} : {
      prompt: payload.prompt,
      expectedOutput: payload.expectedOutput,
    }),
  };
  if (task.scheduleKind !== undefined) patch.scheduleKind = task.scheduleKind;
  const runAt = parseRunAt(task.runAt);
  if (runAt !== undefined) patch.runAt = runAt;
  if (task.cron !== undefined) patch.cron = task.cron;
  if (task.timezone !== undefined) patch.timezone = task.timezone;
  if (task.targetChat !== undefined) patch.targetChat = task.targetChat;
  if (task.resultDelivery !== undefined) patch.resultDelivery = task.resultDelivery;
  if (task.tools !== undefined) Object.assign(patch, toolsFields(task.tools));
  if (task.timeLimitSeconds !== undefined) patch.timeLimitSeconds = task.timeLimitSeconds;
  if (task.selectionProfile !== undefined) patch.selectionProfile = task.selectionProfile;
  if (task.selectionSpec !== undefined) patch.selectionSpec = task.selectionSpec;
  if (task.requestedModelId !== undefined) patch.requestedModelId = task.requestedModelId;
  if (task.scheduleKind !== undefined || task.runAt !== undefined
    || task.cron !== undefined || task.timezone !== undefined) {
    patch.nextFireAt = computeNextFireAt(
      task.scheduleKind ?? current.scheduleKind,
      runAt ?? current.runAt,
      task.cron ?? current.cron,
      task.timezone ?? current.timezone,
    );
  }
  return patch;
}

type VersionedTask = Task & Readonly<{ mutationVersion: string }>;

type SelectedTaskSource = Readonly<{
  task: Task;
  projected: boolean;
}>;

type SelectedMutationSource = SelectedTaskSource & Readonly<{
  task: VersionedTask;
}>;

type VersionedTaskWithFallbackReceipt = VersionedTask & Readonly<{
  ordinaryFallbackOperationId: string;
  ordinaryFallbackRequestDigest: Uint8Array;
  ordinaryFallbackReason: "target_encryption_not_ready";
  ordinaryFallbackPolicyRevision: number;
  ordinaryFallbackCompletedAt: Date;
}>;

function fallbackRepairSource(
  task: VersionedTask,
): TaskOrdinaryFallbackRepairSourceProofV1 | null {
  if ((task.status !== "pending" && task.status !== "paused")
    || task.fireLockId !== null
    || task.contentRepresentation !== "dual"
    || task.contentNamespaceId === null
    || task.contentRevision < 1
    || task.cryptoObjectId === null
    || task.cryptoAccessRevision < 0
    || !(task.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.cryptoMappingState !== "stale"
    || !hasTaskOrdinaryFallbackReceiptV1(task)) return null;
  const receipt = task as VersionedTaskWithFallbackReceipt;
  return prepareTaskOrdinaryFallbackRepairSourceProofV1({
    taskId: task.id,
    sourceMutationVersion: task.mutationVersion,
    sourceUpdatedAt: task.updatedAt,
    sourceContentRevision: task.contentRevision,
    sourceNamespaceId: task.contentNamespaceId,
    sourceCryptoObjectId: task.cryptoObjectId,
    sourceCryptoAccessRevision: task.cryptoAccessRevision,
    sourceRequiredNamespaceFingerprint:
      task.cryptoRequiredNamespaceFingerprint,
    fallbackOperationId: receipt.ordinaryFallbackOperationId,
    fallbackRequestDigest: receipt.ordinaryFallbackRequestDigest,
    fallbackReason: receipt.ordinaryFallbackReason,
    fallbackPolicyRevision: receipt.ordinaryFallbackPolicyRevision,
    fallbackCompletedAt: receipt.ordinaryFallbackCompletedAt,
  });
}

function fallbackRepairPlanBinding(
  source: TaskOrdinaryFallbackRepairSourceProofV1,
) {
  return Object.freeze({
    sourceMutationVersion: source.sourceMutationVersion,
    sourceUpdatedAt: source.sourceUpdatedAt.toISOString(),
    sourceContentRevision: source.sourceContentRevision,
    sourceNamespaceId: source.sourceNamespaceId,
    sourceCryptoObjectId: source.sourceCryptoObjectId,
    sourceCryptoAccessRevision: source.sourceCryptoAccessRevision,
    sourceRequiredNamespaceFingerprintBase64url: Buffer.from(
      source.sourceRequiredNamespaceFingerprint,
    ).toString("base64url"),
    fallbackOperationId: source.fallbackOperationId,
    fallbackRequestDigestBase64url: Buffer.from(
      source.fallbackRequestDigest,
    ).toString("base64url"),
    fallbackReason: source.fallbackReason,
    fallbackPolicyRevision: source.fallbackPolicyRevision,
    fallbackCompletedAt: source.fallbackCompletedAt.toISOString(),
  });
}

function sameFallbackRepairSource(
  left: TaskOrdinaryFallbackRepairSourceProofV1 | null,
  right: TaskOrdinaryFallbackRepairSourceProofV1 | null,
): boolean {
  return left === null || right === null
    ? left === right
    : JSON.stringify(fallbackRepairPlanBinding(left))
      === JSON.stringify(fallbackRepairPlanBinding(right));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** @internal Exact device/custody lock held through the product mapping commit. */
export async function withCurrentProtectedTaskPublicationDeviceAuthority<Value>(
  restricted: PostgresJsBridgeConnection,
  authority: ProtectedTaskRouteAuthority,
  request: HumanTaskPublicationRequest,
  publish: () => Promise<Value>,
): Promise<Value> {
  if (request.subjectHumanId !== authority.subjectHumanId
    || request.committerDeviceId !== authority.deviceId) {
    throw new ProtectedTaskRouteError(
      403,
      "task_authority_unavailable",
      "Task authority is unavailable",
    );
  }
  const result = await withCurrentHumanDeviceSigningAuthority(restricted, {
    subjectUserId: authority.userId,
    subjectHumanId: authority.subjectHumanId,
    humanActorId: authority.actorId,
    deviceId: request.committerDeviceId,
    deviceSigningKeyGeneration: authority.deviceGeneration,
    hostAuthorizationRevision: request.hostAuthorizationRevision,
  }, publish);
  if (result === null) {
    throw new ProtectedTaskRouteError(
      403,
      "task_authority_unavailable",
      "Task authority is unavailable",
    );
  }
  return result;
}

function decodePreparedTaskPublicationRequest(
  prepared: ProtectedTaskPreparedCreateRequestV1
    | DualTaskPreparedCreateRequestV1
    | ProtectedTaskPreparedUpdateRequestV1
    | DualTaskPreparedUpdateRequestV1,
): HumanTaskPublicationRequest {
  const bytes = Uint8Array.from(Buffer.from(
    prepared.signedPublicationRequestBytesBase64url,
    "base64url",
  ));
  try {
    return decodeHumanTaskPublicationRequestV1(bytes);
  } finally {
    bytes.fill(0);
  }
}

function destroyTaskPublicationRequest(request: HumanTaskPublicationRequest): void {
  request.planDigest.fill(0);
  request.operationalFieldsDigest.fill(0);
  request.bindingHash.fill(0);
  request.payloadHash.fill(0);
  request.manifestHash.fill(0);
  request.envelopeHash.fill(0);
  request.signature.fill(0);
}

/** Production Task definition transport backed by current product and crypto authority. */
export function createProductionProtectedTaskComposition(
  dependencies: ProductionDependencies,
): ProtectedTaskComposition {
  const now = dependencies.now ?? Date.now;
  let cryptoHandlePromise: ReturnType<typeof verifyCryptoPostgresHandle> | null = null;
  const cryptoHandle = () =>
    cryptoHandlePromise ??= verifyCryptoPostgresHandle(dependencies.restricted);
  const productConnection = createPostgresJsBridgeConnection(dependencies.db);
  const resolveRequesterPrivateRoom = dependencies.resolveRequesterPrivateRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(dependencies.db);
  const productAuthority = new PostgresNamespaceProductAuthority(
    productConnection,
  );
  const domainKeys = new PostgresDomainKeyAuthorityRepository(
    dependencies.restricted,
    dependencies.crypto,
    dependencies.serverScope,
  );
  const resolvePrivateReadAuthority =
    createProtectedTaskPrivateReadAuthorityResolver({
      resolveRequesterPrivateRoom,
      productAuthority,
      domainKeys,
    });

  const readProjectedMutationSource = async (
    db: DirectDatabase,
    authority: ProtectedTaskRouteAuthority,
    taskId: string,
  ): Promise<SelectedMutationSource | undefined> => {
    const task = await getProtectedTaskMutationSourceById(
      db,
      taskId,
      authority.userId,
    );
    if (task === undefined) return undefined;
    return { task, projected: true };
  };

  const readMutationSource = (
    authority: ProtectedTaskRouteAuthority,
    taskId: string,
    db: DirectDatabase = dependencies.db,
  ): Promise<SelectedMutationSource | undefined> => dependencies.owner.runMutation<SelectedMutationSource | undefined>({
    ordinary: async () => {
      const task = await getTaskByIdWithMutationVersion(db, taskId);
      return task === undefined ? undefined : {
        task,
        projected: false,
      };
    },
    protected: () => readProjectedMutationSource(db, authority, taskId),
    dual: () => readProjectedMutationSource(db, authority, taskId),
  });

  const readTaskSource = (
    authority: ProtectedTaskRouteAuthority,
    taskId: string,
    db: DirectDatabase = dependencies.db,
  ): Promise<SelectedTaskSource | undefined> => dependencies.owner.runMutation<SelectedTaskSource | undefined>({
    ordinary: async () => {
      const task = await getTaskById(db, taskId);
      return task === undefined ? undefined : { task, projected: false };
    },
    protected: () => readProjectedMutationSource(db, authority, taskId),
    dual: () => readProjectedMutationSource(db, authority, taskId),
  });

  const operationalMetadataFor = (
    source: SelectedTaskSource,
  ): ProtectedTaskOperationalMetadataProjectionV1 => {
    if (!source.projected) return metadataFor(source.task);
    const operationalMetadata = parseProtectedTaskOperationalMetadataProjectionV1(
      source.task.metadata,
    );
    if (operationalMetadata === null) {
      throw new ProtectedTaskRouteError(
        409,
        "task_metadata_unsupported",
        "Task metadata cannot be protected",
      );
    }
    return operationalMetadata;
  };

  const foregroundSignerTransport = async (userId: string) => {
    const product = await createHumanProductTransactionContext(
      userId,
      dependencies.db,
    );
    return createProtectedTaskForegroundSignerTransport({
      resolveEvidence:
        createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
          product: product.handle,
          crypto: dependencies.crypto,
          rejectInvalidSelectedEvidence: true,
        }),
    });
  };

  const readAccessManifestChain = async (
    objectId: string,
    headAccessRevision: number,
  ): Promise<readonly Uint8Array[]> => {
    if (!Number.isSafeInteger(headAccessRevision)
      || headAccessRevision < 0) {
      throw new ProtectedTaskRouteError(
        409,
        "unsupported_crypto_access_revision",
        "Protected Task access history exceeds the supported read profile",
      );
    }
    const chain: Uint8Array[] = [];
    let cursor = 0;
    try {
      while (cursor <= headAccessRevision) {
        const rows = await executeTypedCryptoQuery(
          await cryptoHandle(),
          cryptoTypedDb.select({
            access_revision: objectCryptoAccessManifests.accessRevision,
            manifest_bytes: objectCryptoAccessManifests.manifestBytes,
          }).from(objectCryptoAccessManifests).where(and(
            eq(objectCryptoAccessManifests.objectId, objectId),
            gte(objectCryptoAccessManifests.accessRevision, cursor),
            lte(objectCryptoAccessManifests.accessRevision, headAccessRevision),
          )).orderBy(asc(objectCryptoAccessManifests.accessRevision)).limit(64),
        );
        try {
          if (rows.length === 0 || rows.some((row, index) =>
            exactDatabaseCounter(row.access_revision) !== cursor + index)) {
            throw new ProtectedTaskRouteError(
              409,
              "task_content_integrity_failure",
              "Protected Task access history is incomplete",
            );
          }
          rows.forEach(row => chain.push(Uint8Array.from(row.manifest_bytes)));
          const lastRevision = cursor + rows.length - 1;
          if (lastRevision === headAccessRevision) break;
          cursor = lastRevision + 1;
        } finally {
          rows.forEach(row => row.manifest_bytes.fill(0));
        }
      }
      return Object.freeze(chain);
    } catch (error) {
      chain.forEach(bytes => bytes.fill(0));
      throw error;
    }
  };

  const readPolicyRevision = async (): Promise<number> => {
    const rows = await dependencies.db.select({
      revision: encryptionTransitionPolicy.revision,
      mode: encryptionTransitionPolicy.mode,
    }).from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"));
    const policy = rows[0];
    if (rows.length !== 1 || policy === undefined
      || policy.mode === "plaintext_only" || policy.revision < 1) {
      throw new ProtectedTaskRouteError(
        409,
        "protected_task_policy_unavailable",
        "Protected Task policy is unavailable",
      );
    }
    return policy.revision;
  };

  const resolveHistoricalHumanDeviceSigningPublicKey = async (
    context: HumanSignerContext,
  ): Promise<Uint8Array | null> => {
    const rows = await executeTypedCryptoQuery(
      await cryptoHandle(),
      cryptoTypedDb.select({
        human_id: humanCryptoDevices.humanId,
        signing_public_key: humanCryptoDevices.signingPublicKey,
        revision: humanCryptoDevices.revision,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.deviceId, context.committerDeviceId),
        eq(humanCryptoDevices.humanId, context.subjectHumanId),
        inArray(humanCryptoDevices.state, ["active", "revoked"]),
      )).limit(2),
    );
    const row = rows[0];
    return rows.length === 1 && row !== undefined
        && row.revision >= context.hostAuthorizationRevision
        && row.signing_public_key instanceof Uint8Array
      ? Uint8Array.from(row.signing_public_key) : null;
  };

  const refreshMappedReadAccess = async (
    authority: ProtectedTaskRouteAuthority,
    coordinate: Parameters<typeof refreshHumanMappedTaskContentAccessHead>[0]["coordinate"],
    expectedNamespaceId: string,
    definitionObjectId?: string | null,
  ): Promise<"applied" | "duplicate" | "unavailable"> => {
    if (authority.admission === undefined) return "unavailable";
    const privateRoom = await resolveRequesterPrivateRoom(
      authority.userId,
      authority.agentId,
      expectedNamespaceId,
    );
    if (privateRoom === null || privateRoom.namespaceId !== expectedNamespaceId) {
      return "unavailable";
    }
    const product = await createHumanProductTransactionContext(
      authority.userId,
      dependencies.db,
    );
    const headDigest = Uint8Array.from(authority.admission.headDigest);
    try {
      return await refreshHumanMappedTaskContentAccessHead({
        runner: product.canonicalRunner,
        restricted: dependencies.restricted,
        crypto: dependencies.crypto,
        serverScope: dependencies.serverScope,
        coordinate,
        sourceRoomId: privateRoom.roomId,
        expectedPolicyRevision: await readPolicyRevision(),
        ...(coordinate.kind !== "definition" || definitionObjectId == null ? {} : {
          resolveTaskDefinitionForegroundAuthorization: async (evidence: Parameters<
            NonNullable<Parameters<typeof refreshHumanMappedTaskContentAccessHead>[0]["resolveTaskDefinitionForegroundAuthorization"]>
          >[0], current: Parameters<
            NonNullable<Parameters<typeof refreshHumanMappedTaskContentAccessHead>[0]["resolveTaskDefinitionForegroundAuthorization"]>
          >[1]) => {
            const resolver = await createProtectedTaskDefinitionForegroundAuthorizationResolver({
              product, currentProduct: current, handle: current.handle, crypto: dependencies.crypto,
              requesterHumanId: authority.subjectHumanId,
              task: {
                id: coordinate.taskId, ownerId: authority.userId, agentId: authority.agentId,
                contentNamespaceId: expectedNamespaceId, cryptoObjectId: definitionObjectId,
                contentRevision: coordinate.contentRevision,
              },
            });
            return resolver === null ? null : resolver(evidence);
          },
        }),
        subject: {
          userId: authority.userId,
          humanActorId: authority.subjectHumanId,
          admission: {
            status: "admitted",
            ...authority.admission,
            headDigest,
          },
        },
        now,
      });
    } finally {
      headDigest.fill(0);
    }
  };

  type CurrentPrivateAuthority = Readonly<{
    sourceRoomId: string;
    content: TaskContentAuthorityV1;
    bindingHash: Uint8Array;
    keyGeneration: number;
  }>;

  type CurrentPrivateAuthorityInspection =
    | Readonly<{ status: "ready"; value: CurrentPrivateAuthority }>
    | Readonly<{
      status: "unavailable";
      reason: "authority_unavailable" | "encryption_not_ready";
    }>;

  const inspectCurrentPrivateAuthority = async (
    authority: ProtectedTaskRouteAuthority,
    expectedNamespaceId?: string,
  ): Promise<CurrentPrivateAuthorityInspection> => {
    const privateRoom = await resolveRequesterPrivateRoom(
      authority.userId,
      authority.agentId,
      expectedNamespaceId,
    );
    if (privateRoom === null || (expectedNamespaceId !== undefined
      && privateRoom.namespaceId !== expectedNamespaceId)) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "authority_unavailable" as const,
      });
    }
    // Global policy reads must not borrow another pool connection while the
    // private Room owner retains its product locks.
    const policyRevision = await readPolicyRevision();
    const current = await productAuthority.withCurrentPrivateRoom({
        subjectUserId: authority.userId,
        subjectHumanId: authority.subjectHumanId,
        roomId: privateRoom.roomId,
        namespaceId: privateRoom.namespaceId,
        use: async () => {
          const domain = await domainKeys.inspectForegroundNamespaceAuthority({
            namespaceId: privateRoom.namespaceId,
            keyClass: "ai",
          });
          if (domain.status !== "ready") {
            return Object.freeze({
              status: "unavailable" as const,
              reason: domain.reason === "namespace_bundle_unavailable"
                ? "encryption_not_ready" as const
                : "authority_unavailable" as const,
            });
          }
          return Object.freeze({
            status: "ready" as const,
            value: Object.freeze({
              sourceRoomId: privateRoom.roomId,
              content: Object.freeze({
                authorityVersion: 1 as const,
                kind: "requester_private_namespace" as const,
                keyClass: "ai" as const,
                requesterHumanId: authority.subjectHumanId,
                namespaceId: privateRoom.namespaceId,
                domainId: domain.domainId,
                expectedAccessRevision: domain.namespaceAccessRevision,
                expectedPolicyRevision: policyRevision,
              }),
              bindingHash: domain.bundleDigest.slice(),
              keyGeneration: domain.namespaceKeyGeneration,
            }),
          });
        },
      });
    if (current === null) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "authority_unavailable" as const,
      });
    }
    if (current.status !== "ready") return current;
    try {
      if (await readPolicyRevision() === policyRevision) return current;
    } catch (error) {
      current.value.bindingHash.fill(0);
      throw error;
    }
    current.value.bindingHash.fill(0);
    return Object.freeze({
      status: "unavailable" as const,
      reason: "authority_unavailable" as const,
    });
  };

  const currentPrivateAuthority = async (
    authority: ProtectedTaskRouteAuthority,
    expectedNamespaceId?: string,
  ): Promise<CurrentPrivateAuthority | null> => {
    const inspected = await inspectCurrentPrivateAuthority(
      authority,
      expectedNamespaceId,
    );
    return inspected.status === "ready" ? inspected.value : null;
  };

  const buildPlan = async (
    authority: ProtectedTaskRouteAuthority,
    taskId: string | null,
    request: ProtectedTaskPublicationPlanRequestV1,
    expectedUpdateSource?: Readonly<{
      mutationVersion: string;
      fallbackRepairSource: TaskOrdinaryFallbackRepairSourceProofV1 | null;
    }>,
  ): Promise<ProtectedTaskPublicationPlanV1> => {
    if (request.operation === "create") {
      validateCreateShape(request.task);
      validateSchedule({
        scheduleKind: request.task.scheduleKind ?? "now",
        runAt: parseRunAt(request.task.runAt),
        cron: request.task.cron ?? null,
        timezone: request.task.timezone ?? "UTC",
      });
    }
    const id = request.operation === "create"
      ? deterministicTaskId(authority, request.operationId)
      : taskId!;
    let expectedContentRevision = 0;
    let expectedCryptoAccessRevision = 0;
    let expectedNamespaceId: string | undefined;
    let taskAuthority = authority;
    let repairSource: TaskOrdinaryFallbackRepairSourceProofV1 | null = null;
    let repairTask: VersionedTask | undefined;
    if (request.operation === "update") {
      const selected = await readMutationSource(authority, id);
      if (selected === undefined) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const { task } = selected;
      const resolved = resolveOwnedProtectedTaskAuthority(authority, task);
      if (resolved === null) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      taskAuthority = resolved;
      // Revision-zero definitions are owned by the existing historical repair
      // path. They cannot be admitted as a normal n -> n+1 protected edit.
      if ((task.status === "pending" || task.status === "paused")
        && task.fireLockId === null && task.ownerId === task.requestorId
        && task.parentTaskId === null && task.depth === 0
        && task.contentRepresentation === "ordinary" && task.contentRevision === 0
        && task.contentNamespaceId === null && task.cryptoObjectId === null
        && task.cryptoAccessRevision === 0 && task.cryptoRequiredNamespaceFingerprint === null
        && task.cryptoMappingState === "unmapped"
        && (hasTaskOrdinaryFallbackReceiptV1(task)
          || task.ordinaryFallbackOperationId === null
            && task.ordinaryFallbackRequestDigest === null
            && task.ordinaryFallbackReason === null
            && task.ordinaryFallbackPolicyRevision === null
            && task.ordinaryFallbackCompletedAt === null)) {
        throw new ProtectedTaskRouteError(409, "task_counterpart_not_ready",
          "Task representation repair is required before a protected update");
      }
      repairSource = fallbackRepairSource(task);
      if (repairSource !== null) repairTask = task;
      if ((task.status !== "pending" && task.status !== "paused")
        || task.fireLockId !== null
        || (task.contentRepresentation !== "protected"
          && task.contentRepresentation !== "dual")
        || task.contentNamespaceId === null
        || task.cryptoMappingState !== "verified" && repairSource === null) {
        throw new ProtectedTaskRouteError(409, "task_not_mutable", "Task cannot be updated");
      }
      if (expectedUpdateSource !== undefined
        && (task.mutationVersion !== expectedUpdateSource.mutationVersion
          || !sameFallbackRepairSource(
            repairSource,
            expectedUpdateSource.fallbackRepairSource,
          ))) {
        throw new ProtectedTaskRouteError(
          409,
          "task_changed",
          "Task changed while the update was prepared",
        );
      }
      expectedContentRevision = task.contentRevision;
      expectedCryptoAccessRevision = task.cryptoAccessRevision;
      expectedNamespaceId = task.contentNamespaceId;
      validateSchedule({
        scheduleKind: request.task.scheduleKind ?? task.scheduleKind,
        runAt: request.task.runAt === undefined
          ? task.runAt : parseRunAt(request.task.runAt),
        cron: request.task.cron ?? task.cron,
        timezone: request.task.timezone ?? task.timezone,
      });
      if (request.task.tools !== undefined
        || request.task.requestedModelId !== undefined
        || request.task.selectionProfile !== undefined
        || request.task.selectionSpec !== undefined) {
        const selectedTools = request.task.tools === undefined
          ? { toolsMode: task.toolsMode, toolsWhitelist: task.toolsWhitelist }
          : toolsFields(request.task.tools);
        const error = validateTaskModelSelectionForCreate({
          requestedModelId: request.task.requestedModelId !== undefined
            ? request.task.requestedModelId : task.requestedModelId,
          profile: request.task.selectionProfile !== undefined
            ? request.task.selectionProfile : task.selectionProfile,
          spec: request.task.selectionSpec !== undefined
            ? request.task.selectionSpec : task.selectionSpec,
          toolsMode: selectedTools.toolsMode,
          toolsWhitelist: selectedTools.toolsWhitelist,
        });
        if (error !== null) {
          throw new ProtectedTaskRouteError(422, "task_selection_invalid", error);
        }
      }
    }
    const inspected = await inspectCurrentPrivateAuthority(
      taskAuthority,
      expectedNamespaceId,
    );
    if (inspected.status !== "ready") {
      if (inspected.reason === "encryption_not_ready") {
        throw new ProtectedTaskRouteError(
          409,
          "task_encryption_not_ready",
          "Task encryption is not ready",
        );
      }
      throw new ProtectedTaskRouteError(
        403,
        "task_authority_unavailable",
        "Task authority is unavailable",
      );
    }
    const current = inspected.value;
    try {
      const sourceTask = repairTask;
      // The shared owner alone selects whether the ordinary sibling may be
      // serialized. Full and Plain never invoke the Shadow source loader.
      const ordinaryRepairPayloadBase64url = sourceTask === undefined
        || Object.keys(request.task).length !== 0 ? undefined
        : await dependencies.owner.mutate<string | undefined, string | undefined>({
          ordinary: () => Promise.resolve(undefined),
          protected: () => Promise.resolve(undefined),
          dual: async () => {
            const exactSource = await getTaskByIdWithMutationVersion(
              dependencies.db,
              sourceTask.id,
            );
            if (exactSource === undefined
              || exactSource.ownerId !== taskAuthority.userId
              || exactSource.agentId !== taskAuthority.agentId
              || exactSource.mutationVersion !== sourceTask.mutationVersion
              || !sameFallbackRepairSource(fallbackRepairSource(exactSource), repairSource)) {
              throw new ProtectedTaskRouteError(
                409,
                "task_changed",
                "Task changed while the update was prepared",
              );
            }
            const classified = classifyProtectedTaskMetadataV1(exactSource.metadata ?? {});
            if (classified.status !== "supported") {
              throw new ProtectedTaskRouteError(409, "task_metadata_unsupported",
                "Task metadata cannot be protected");
            }
            const content = {
              prompt: exactSource.prompt,
              expectedOutput: exactSource.expectedOutput,
              protectedMetadata: classified.protectedContent,
            };
            const bytes = encodeTaskDefinitionContent(exactSource.lastError === null
              ? { formatVersion: 1, ...content }
              : { formatVersion: 2, ...content,
                  retainedHistoricalError: exactSource.lastError });
            try {
              return Buffer.from(bytes).toString("base64url");
            } finally {
              bytes.fill(0);
            }
          },
          publish: (payload) => Promise.resolve(payload),
        });
      const plan = {
        planVersion: 1 as const,
        operation: request.operation,
        operationId: request.operationId,
        taskId: id,
        expectedContentRevision,
        nextContentRevision: expectedContentRevision + 1,
        expectedCryptoAccessRevision,
        ...(ordinaryRepairPayloadBase64url === undefined ? {} : {
          ordinaryRepairPayloadBase64url,
        }),
        authority: {
          requesterHumanId: current.content.requesterHumanId,
          sourceRoomId: current.sourceRoomId,
          namespaceId: current.content.namespaceId,
          domainId: current.content.domainId,
          expectedAccessRevision: current.content.expectedAccessRevision,
          expectedPolicyRevision: current.content.expectedPolicyRevision,
          bindingHashBase64url: Buffer.from(current.bindingHash).toString("base64url"),
          keyGeneration: current.keyGeneration,
        },
      };
      return Object.freeze({
        ...plan,
        planDigestBase64url: digestJson(dependencies.crypto, repairSource === null
          ? { ...plan, task: request.task }
          : { ...plan, task: request.task,
              fallbackRepairSource: fallbackRepairPlanBinding(repairSource) }),
      });
    } finally {
      current.bindingHash.fill(0);
    }
  };

  const currentContentAuthority = async (
    authority: ProtectedTaskRouteAuthority,
    expected: Readonly<{ requesterHumanId: string; namespaceId: string }>,
  ): Promise<TaskContentAuthorityV1 | null> => {
    if (expected.requesterHumanId !== authority.subjectHumanId) return null;
    return (await currentPrivateAuthority(authority, expected.namespaceId))
      ?.content ?? null;
  };

  const repository = async (authority: ProtectedTaskRouteAuthority) => {
    const product = await createHumanProductTransactionContext(
      authority.userId,
      dependencies.db,
    );
    const verifiedCryptoHandle = await cryptoHandle();
    const signerHistory = new PostgresHumanDeviceSignerHistory({
      handle: verifiedCryptoHandle,
      crypto: dependencies.crypto,
    });
    const resolveHistoricalHumanDeviceSigningPublicKey = async (context: Readonly<{
      subjectHumanId: string;
      committerDeviceId: string;
      hostAuthorizationRevision: number;
    }>): Promise<Uint8Array | null> => {
      const rows = await executeTypedCryptoQuery(
        verifiedCryptoHandle,
        cryptoTypedDb.select({
          human_id: humanCryptoDevices.humanId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          revision: humanCryptoDevices.revision,
        }).from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, context.committerDeviceId),
          eq(humanCryptoDevices.humanId, context.subjectHumanId),
          inArray(humanCryptoDevices.state, ["active", "revoked"]),
        )),
      );
      const row = rows[0];
      return rows.length === 1 && row !== undefined
          && row.revision >= context.hostAuthorizationRevision
          && row.signing_public_key instanceof Uint8Array
        ? row.signing_public_key.slice() : null;
    };
    return createPostgresTaskContentRepositoryV1<Task>({
      product: {
        handle: product.handle,
        resolveCurrentAuthority: (expected) =>
          currentContentAuthority(authority, expected),
      },
      crypto: {
        handle: verifiedCryptoHandle,
        crypto: dependencies.crypto,
        resolveCurrentAuthority: async (coordinate) => {
          const task = (await readTaskSource(authority, coordinate.taskId))?.task;
          if (task === undefined || task.contentNamespaceId === null) return null;
          const taskAuthority = resolveOwnedProtectedTaskAuthority(authority, task);
          if (taskAuthority === null) return null;
          return currentContentAuthority(taskAuthority, {
            requesterHumanId: taskAuthority.subjectHumanId,
            namespaceId: task.contentNamespaceId,
          });
        },
        resolveHistoricalAgentSignerAuthority:
          signerHistory.resolveAgentRuntimeSignerManager,
        resolveHistoricalHumanDeviceSigningPublicKey:
          resolveHistoricalHumanDeviceSigningPublicKey,
      },
      content: {
        prepareProtected: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Server Task preparation is unsupported",
        )),
        publishProduct: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Unprepared Task publication is unsupported",
        )),
        readOrdinary: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Ordinary Task reads are outside protected transport",
        )),
        readProtected: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Protected Task plaintext remains in client custody",
        )),
      },
    });
  };

  const resolveSignedAuthority = async (
    authority: ProtectedTaskRouteAuthority,
    request: HumanTaskPublicationRequest,
  ): Promise<Uint8Array | null> => {
    if (request.subjectHumanId !== authority.subjectHumanId
      || request.committerDeviceId !== authority.deviceId) return null;
    const current = await currentPrivateAuthority(authority, request.namespaceId);
    if (current === null) return null;
    try {
      if (request.domainId !== current.content.domainId
        || request.expectedNamespaceAccessRevision
          !== current.content.expectedAccessRevision
        || request.expectedPolicyRevision
          !== current.content.expectedPolicyRevision
        || request.keyGeneration !== current.keyGeneration
        || !sameBytes(request.bindingHash, current.bindingHash)) return null;
      return withCurrentHumanDeviceSigningAuthority(dependencies.restricted, {
        subjectUserId: authority.userId,
        subjectHumanId: authority.subjectHumanId,
        humanActorId: authority.actorId,
        deviceId: request.committerDeviceId,
        deviceSigningKeyGeneration: authority.deviceGeneration,
        hostAuthorizationRevision: request.hostAuthorizationRevision,
      }, (key) => Promise.resolve(key.slice()));
    } finally {
      current.bindingHash.fill(0);
    }
  };

  const createProduct = async (
    authority: ProtectedTaskRouteAuthority,
    taskId: string,
    task: OperationalCreate,
    payload: TaskDefinitionPayload | null,
  ): Promise<Task> => {
    const existing = (await readTaskSource(authority, taskId))?.task;
    if (existing !== undefined) {
      if (existing.ownerId !== authority.userId || existing.agentId !== authority.agentId) {
        throw new ProtectedTaskRouteError(409, "task_identity_conflict", "Task identity conflicts");
      }
      return existing;
    }
    const [identity] = await dependencies.db.select({ id: tasks.id })
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (identity !== undefined) {
      throw new ProtectedTaskRouteError(409, "task_identity_conflict", "Task identity conflicts");
    }
    try {
      return await dependencies.db.transaction(async (transaction) => {
        const transactionDb = transaction as unknown as DirectDatabase;
        const scopeId = task.useScope === true
          ? await prepareProtectedTaskScope(transaction, {
              taskId,
              requesterUserId: authority.userId,
              agentId: authority.agentId,
              scopeId: task.scopeId ?? null,
            })
          : task.scopeId;
        await runtimeCreateTask({
          db: transactionDb,
          observer: { kick() {} },
          invocationAuthority: createAcceptedInvocationAuthority(authority.userId),
          provenance: createHumanApiTaskCreationProvenance({
            ownerId: authority.userId,
            requestedParentTaskId: null,
          }),
          admission: getPlaintextTaskCreationAdmission(),
        }, taskCreateInput(authority, taskId, {
          ...task,
          ...(scopeId == null ? {} : { scopeId }),
        }, payload));
        const created = (await readMutationSource(
          authority,
          taskId,
          transactionDb,
        ))?.task;
        if (created === undefined) {
          throw new Error("Protected Task product disappeared");
        }
        // The ordinary observer cannot claim a paused revision-zero placeholder.
        // Definition mapping changes it to pending in the same transaction that
        // makes the protected representation dispatchable.
        const parked = await updateTaskIfCurrent(transactionDb, {
          id: created.id,
          ownerId: authority.userId,
          expectedStatus: "pending",
          expectedMutationVersion: created.mutationVersion,
          expectedContentRevision: 0,
        }, { status: "paused" });
        if (parked === undefined) {
          throw new Error("Protected Task placeholder changed during creation");
        }
        return parked;
      });
    } catch (error) {
      if (error instanceof AgentInvocationDeniedError
        || error instanceof ServerProviderCredentialsDeniedError) {
        throw new ProtectedTaskRouteError(
          403,
          "task_creation_forbidden",
          error.message,
        );
      }
      throw error;
    }
  };

  const updateProduct = async (
    authority: ProtectedTaskRouteAuthority,
    taskId: string,
    expectedContentRevision: number,
    expectedMutationVersion: string,
    expectedFallbackRepairSource:
      TaskOrdinaryFallbackRepairSourceProofV1 | null,
    task: OperationalUpdate,
    payload: TaskDefinitionPayload | null,
  ): Promise<Task> => {
    const selected = await readMutationSource(authority, taskId);
    if (selected === undefined || selected.task.ownerId !== authority.userId
      || selected.task.agentId !== authority.agentId) {
      throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
    }
    const { task: current } = selected;
    if (current.contentRevision === expectedContentRevision + 1
      && current.cryptoMappingState === "verified") return current;
    if (current.status !== "pending" && current.status !== "paused") {
      throw new ProtectedTaskRouteError(409, "task_not_mutable", "Task cannot be updated");
    }
    if (current.mutationVersion !== expectedMutationVersion
      || !sameFallbackRepairSource(
        fallbackRepairSource(current),
        expectedFallbackRepairSource,
      )) {
      throw new ProtectedTaskRouteError(
        409,
        "task_changed",
        "Task changed while the update was prepared",
      );
    }
    const operationalMetadata = operationalMetadataFor(selected);
    const patch = taskUpdatePatch(current, task, payload, operationalMetadata);
    if (expectedFallbackRepairSource !== null && payload !== null) {
      const reconstructed = reconstructProtectedTaskMetadataV1(
        operationalMetadata,
        payload.protectedMetadata,
      );
      if (reconstructed.status !== "supported") {
        throw new ProtectedTaskRouteError(
          409,
          "task_metadata_unsupported",
          "Task metadata cannot be protected",
        );
      }
      patch.metadata = reconstructed.metadata;
    }
    const updated = await updateTaskIfCurrent(dependencies.db, {
      id: current.id,
      ownerId: authority.userId,
      expectedStatus: current.status,
      expectedMutationVersion,
      expectedContentRevision,
    }, patch);
    if (updated === undefined) {
      throw new ProtectedTaskRouteError(
        409,
        "task_changed",
        "Task changed while the update was prepared",
      );
    }
    return updated;
  };

  const ports: ProtectedTaskRoutePorts = {
    list: (input) =>
      listProtectedTaskContentV1(input.authority.userId, input.query),

    async readDefinition(input) {
      let task = (await readTaskSource(input.authority, input.taskId))?.task;
      if (task === undefined
        || task.ownerId !== input.authority.userId
        || task.requestorId !== input.authority.userId) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const taskAuthority = resolveOwnedProtectedTaskAuthority(
        input.authority,
        task,
      );
      if (taskAuthority === null) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      if (task.contentNamespaceId !== null) {
        let refreshedAccess: Awaited<ReturnType<typeof refreshMappedReadAccess>>;
        try {
          refreshedAccess = await refreshMappedReadAccess(taskAuthority, {
            kind: "definition",
            taskId: input.taskId,
            contentRevision: input.contentRevision,
          }, task.contentNamespaceId, task.cryptoObjectId);
        } catch (error) {
          if (error instanceof TypeError
            || error instanceof ClassifiedDataOperationError
              && error.failureClass === "integrity") {
            throw new ProtectedTaskRouteError(
              409,
              "task_content_integrity_failure",
              "Task content could not be verified",
            );
          }
          throw error;
        }
        const refreshed = refreshedAccess === "unavailable" ? task
          : (await readTaskSource(input.authority, input.taskId))?.task;
        if (refreshed === undefined
          || refreshed.ownerId !== input.authority.userId
          || refreshed.requestorId !== input.authority.userId
          || resolveOwnedProtectedTaskAuthority(input.authority, refreshed) === null) {
          throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
        }
        task = refreshed;
      }
      if ((task.contentRepresentation !== "protected"
        && task.contentRepresentation !== "dual")
        || task.cryptoMappingState !== "verified"
        || task.cryptoObjectId !== input.objectId
        || task.contentRevision !== input.contentRevision
        || task.cryptoAccessRevision !== input.cryptoAccessRevision
        || task.contentNamespaceId === null) {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_changed",
          "Task content reference changed",
        );
      }
      const ledgerRows = await dependencies.db.select({
        taskId: taskDefinitionCryptoRevisions.taskId,
        contentNamespaceId: taskDefinitionCryptoRevisions.contentNamespaceId,
        contentRevision: taskDefinitionCryptoRevisions.contentRevision,
        requesterHumanId: taskDefinitionCryptoRevisions.requesterHumanId,
        cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
        representation: taskDefinitionCryptoRevisions.representation,
        cryptoAccessRevision: taskDefinitionCryptoRevisions.cryptoAccessRevision,
        completion: taskDefinitionCryptoRevisions.completion,
        disposition: taskDefinitionCryptoRevisions.disposition,
        historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
      }).from(taskDefinitionCryptoRevisions).where(and(
        eq(taskDefinitionCryptoRevisions.taskId, input.taskId),
        eq(taskDefinitionCryptoRevisions.contentRevision, input.contentRevision),
      )).limit(2);
      const ledger = ledgerRows[0];
      let historicalRepair: Extract<
        TaskHistoricalRepairProvenanceV1,
        { version: 2 }
      > | null;
      try {
        historicalRepair = historicalRepairV2(ledger?.historicalRepair);
      } catch {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_integrity_failure",
          "Task historical content provenance is invalid",
        );
      }
      const expectedObjectId = taskContentRevisionObjectIdV1({
        coordinate: {
          kind: "definition",
          taskId: input.taskId,
          contentRevision: input.contentRevision,
        },
        namespaceId: task.contentNamespaceId,
        historicalRepair,
      });
      if (ledgerRows.length !== 1 || ledger === undefined
        || ledger.taskId !== input.taskId
        || ledger.contentNamespaceId !== task.contentNamespaceId
        || ledger.contentRevision !== input.contentRevision
        || ledger.requesterHumanId !== input.authority.subjectHumanId
        || ledger.cryptoObjectId !== input.objectId
        || ledger.cryptoObjectId !== expectedObjectId
        || ledger.representation !== task.contentRepresentation
        // The allocation ledger pins the signed genesis. Human metadata
        // rewraps advance the Task/access head while this immutable coordinate
        // remains revision zero; the complete chain below proves that head.
        || ledger.cryptoAccessRevision !== 0
        || ledger.completion !== "complete"
        || ledger.disposition !== "mapped"
        || historicalRepair !== null && (
          ledger.representation !== "dual" || input.contentRevision !== 1
        )) {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_integrity_failure",
          "Task content mapping is invalid",
        );
      }
      const current = await currentPrivateAuthority(
        taskAuthority,
        task.contentNamespaceId,
      );
      if (current === null) {
        throw new ProtectedTaskRouteError(
          403,
          "task_authority_unavailable",
          "Task authority is unavailable",
        );
      }
      current.bindingHash.fill(0);
      const verifiedCryptoHandle = await cryptoHandle();
      const storage = new PostgresLatticeStorage(verifiedCryptoHandle);
      const [object, access] = await Promise.all([
        storage.getObject(input.objectId),
        storage.getObjectAccessState(input.objectId),
      ]);
      if (object === null || access === null
        || access.head.accessRevision !== input.cryptoAccessRevision
        || access.namespaceEnvelopes.length !== 1
        || access.namespaceEnvelopes[0]?.namespaceId
          !== task.contentNamespaceId) {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_integrity_failure",
          "Task ciphertext is incomplete",
        );
      }
      const history = new PostgresHumanDeviceSignerHistory({
        handle: verifiedCryptoHandle,
        crypto: dependencies.crypto,
      });
      const foreground = historicalRepair === null
        ? await foregroundSignerTransport(input.authority.userId)
        : null;
      const taskDefinitionAuthorization = historicalRepair === null
        ? await createProtectedTaskDefinitionForegroundAuthorizationResolver({
            product: await createHumanProductTransactionContext(
              input.authority.userId,
              dependencies.db,
            ),
            handle: verifiedCryptoHandle,
            crypto: dependencies.crypto,
            requesterHumanId: input.authority.subjectHumanId,
            task: {
              id: task.id,
              ownerId: task.ownerId,
              agentId: task.agentId,
              contentNamespaceId: task.contentNamespaceId,
              cryptoObjectId: task.cryptoObjectId,
              contentRevision: task.contentRevision,
            },
          })
        : null;
      const humanSigners = createProtectedTaskHumanSignerTransport(
        resolveHistoricalHumanDeviceSigningPublicKey,
      );
      let chain: readonly Uint8Array[];
      try {
        chain = await readAccessManifestChain(
          input.objectId,
          input.cryptoAccessRevision,
        );
      } catch (error) {
        foreground?.destroy();
        humanSigners.destroy();
        object.payloadBytes.fill(0);
        access.head.manifestBytes.fill(0);
        access.head.manifestHash.fill(0);
        access.namespaceEnvelopes.forEach(entry => {
          entry.envelopeBytes.fill(0);
          entry.envelopeHash.fill(0);
        });
        throw error;
      }
      const payloadHash = dependencies.crypto.hash(object.payloadBytes);
      let verified: Awaited<ReturnType<
        typeof verifyStoredObjectAccessManifestChainV5
      >> | undefined;
      try {
        try {
          verified = await verifyStoredObjectAccessManifestChainV5({
            executor: verifiedCryptoHandle,
            crypto: dependencies.crypto,
            objectId: input.objectId,
            headAccessRevision: input.cryptoAccessRevision,
            expectedPayloadHash: payloadHash,
            expectedHeadManifestHash: access.head.manifestHash,
            resolveHistoricalAgentManagerAuthority:
              history.resolveAgentRuntimeSignerManager,
            resolveLiveShadowAgentSigner: foreground?.resolveSigner,
            ...(taskDefinitionAuthorization === null ? {} : {
              resolveTaskDefinitionForegroundAuthorization:
                taskDefinitionAuthorization,
            }),
            resolveHistoricalHumanDeviceSigningPublicKey:
              humanSigners.resolve,
          });
        } finally {
          payloadHash.fill(0);
        }
        const genesis = decodeObjectAccessManifestV5(chain[0]!);
        let genesisKind: "agent_runtime" | "human_device";
        let genesisIsTaskAgent = false;
        let foregroundEvidence: ReturnType<
          NonNullable<typeof foreground>["evidenceFor"]
        > = null;
        try {
          genesisKind = validateProtectedTaskReadManifestSigners({
            crypto: dependencies.crypto,
            chain,
            expectedAgentId: task.agentId,
            requesterHumanId: input.authority.subjectHumanId,
            historicalRepair,
            allowHumanGenesis: true,
            allowForegroundDefinitionAuthor: true,
          });
          genesisIsTaskAgent = genesis.signer.kind === "agent_runtime"
            && genesis.signer.agentId === task.agentId;
          const taskDefinitionEvidence = verified
            .taskDefinitionForegroundAuthorizationEvidence;
          if (genesis.signer.kind === "agent_runtime"
            && taskDefinitionEvidence.length === 1) {
            const authorization = parseDomainForegroundAuthorizationV2(
              taskDefinitionEvidence[0]!,
            );
            if (authorization === null) {
              throw new TypeError("Task definition authorization evidence is invalid");
            }
            const coordinates = parseTaskDefinitionForegroundAuthorizationIdV1(
              authorization.authorizationId,
            );
            try {
              if (coordinates === null) {
                throw new TypeError("Task definition authorization ID is invalid");
              }
              const key = await foreground?.resolveDefinitionSigner(
                genesis.signer,
                coordinates.parentOperationHash,
              ) ?? null;
              key?.fill(0);
              if (key === null) {
                throw new TypeError("Task definition parent evidence is unavailable");
              }
            } finally {
              coordinates?.parentOperationHash.fill(0);
              coordinates?.workDescriptorDigest.fill(0);
              destroyDomainForegroundAuthorizationV2(authorization);
            }
          } else if (taskDefinitionEvidence.length !== 0) {
            throw new TypeError("Task definition authorization evidence is inexact");
          }
          foregroundEvidence = genesis.signer.kind === "agent_runtime"
            ? foreground?.definitionEvidenceFor(genesis.signer, {
                taskAgentId: task.agentId,
                subjectHumanId: input.authority.subjectHumanId,
                domainId: current.content.domainId,
                namespaceId: task.contentNamespaceId,
              }) ?? null
            : null;
        } finally {
          wipeDecodedAccessManifest(genesis);
        }
        const publicationEvidence = verified.signerEvidence.length === 1
          && verified.signerEvidence[0]?.kind === "agent_runtime_publication"
          ? verified.signerEvidence[0]
          : null;
        const humanGenesis = genesisKind === "human_device"
          && verified.genesisHumanId === input.authority.subjectHumanId;
        const agentGenesis = genesisKind === "agent_runtime"
          && historicalRepair === null
          && verified.genesisHumanId === null
          && (foregroundEvidence !== null
            ? verified.signerEvidence.length === 0
            : genesisIsTaskAgent && publicationEvidence !== null);
        if (!humanGenesis && !agentGenesis) {
          throw new ProtectedTaskRouteError(
            409,
            "task_content_integrity_failure",
            "Task signer is invalid",
          );
        }
        const agentEvidence = agentGenesis
          ? foregroundEvidence !== null ? [foregroundEvidence] : [Object.freeze({
              kind: "agent_runtime_publication" as const,
              evidenceBytesBase64url: Buffer.from(
                publicationEvidence!.evidenceBytes,
              ).toString("base64url"),
            })]
          : [];
        const taskDefinitionEvidence = verified
          .taskDefinitionForegroundAuthorizationEvidence.map(bytes =>
            Object.freeze({
              kind: "task_definition_foreground_authorization" as const,
              evidenceBytesBase64url: Buffer.from(bytes).toString("base64url"),
            }));
        const signerEvidence = [
          ...agentEvidence,
          ...taskDefinitionEvidence,
          ...humanSigners.evidence(),
        ];
        let readAuthority: ProtectedTaskNamespaceReadAuthority | null;
        try {
          readAuthority = await resolveProtectedTaskEnvelopeReadAuthority({
            objectId: input.objectId,
            namespaceId: task.contentNamespaceId,
            envelopeBytes: access.namespaceEnvelopes[0].envelopeBytes,
            authority: taskAuthority,
            resolveReadAuthority: resolvePrivateReadAuthority,
          });
        } catch (error) {
          if (error instanceof TypeError) {
            throw new ProtectedTaskRouteError(
              409,
              "task_content_integrity_failure",
              "Task Namespace envelope is invalid",
            );
          }
          throw error;
        }
        if (readAuthority === null) {
          throw new ProtectedTaskRouteError(
            403,
            "task_authority_unavailable",
            "Task authority is unavailable",
          );
        }
        const stableAccess = await storage.getObjectAccessState(input.objectId);
        if (stableAccess === null
          || stableAccess.head.accessRevision !== input.cryptoAccessRevision
          || !sameBytes(stableAccess.head.manifestHash, access.head.manifestHash)) {
          stableAccess?.head.manifestBytes.fill(0);
          stableAccess?.head.manifestHash.fill(0);
          stableAccess?.namespaceEnvelopes.forEach(entry => {
            entry.envelopeBytes.fill(0);
            entry.envelopeHash.fill(0);
          });
          throw new ProtectedTaskRouteError(
            409,
            "task_content_changed",
            "Task access changed while it was being read",
          );
        }
        stableAccess.head.manifestBytes.fill(0);
        stableAccess.head.manifestHash.fill(0);
        stableAccess.namespaceEnvelopes.forEach(entry => {
          entry.envelopeBytes.fill(0);
          entry.envelopeHash.fill(0);
        });
        return Object.freeze({
          readVersion: 1 as const,
          status: "ready" as const,
          taskId: input.taskId,
          objectId: input.objectId,
          contentRevision: input.contentRevision,
          cryptoAccessRevision: input.cryptoAccessRevision,
          namespaceId: task.contentNamespaceId,
          readAuthority,
          encryptedPayloadBytesBase64url:
            Buffer.from(object.payloadBytes).toString("base64url"),
          accessManifestBytesBase64url:
            Buffer.from(access.head.manifestBytes).toString("base64url"),
          accessManifestProofBytesBase64url: chain.slice(0, -1).map(value =>
            Buffer.from(value).toString("base64url")),
          namespaceEnvelopeBytesBase64url: Buffer.from(
            access.namespaceEnvelopes[0].envelopeBytes,
          ).toString("base64url"),
          ...(historicalRepair === null ? {} : { historicalRepair }),
          signerEvidence,
        });
      } finally {
        foreground?.destroy();
        humanSigners.destroy();
        chain.forEach(value => value.fill(0));
        object.payloadBytes.fill(0);
        access.head.manifestBytes.fill(0);
        access.head.manifestHash.fill(0);
        for (const envelope of access.namespaceEnvelopes) {
          envelope.envelopeBytes.fill(0);
          envelope.envelopeHash.fill(0);
        }
        if (verified !== undefined) {
          destroyVerifiedStoredObjectAccessManifestChainV5(verified);
        }
      }
    },

    async readRunResult(input) {
      let taskRows = await dependencies.db.select({
        ownerId: tasks.ownerId,
        requestorId: tasks.requestorId,
        agentId: tasks.agentId,
        contentRepresentation: tasks.contentRepresentation,
        contentNamespaceId: tasks.contentNamespaceId,
        cryptoMappingState: tasks.cryptoMappingState,
      }).from(tasks).where(eq(tasks.id, input.taskId)).limit(2);
      let task = taskRows[0];
      if (taskRows.length !== 1 || task === undefined
        || task.ownerId !== input.authority.userId
        || task.requestorId !== input.authority.userId) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const taskAuthority = resolveOwnedProtectedTaskAuthority(
        input.authority,
        task,
      );
      if (taskAuthority === null) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      let runRows = await dependencies.db.select({
        taskId: taskRuns.taskId,
        status: taskRuns.status,
        resultRepresentation: taskRuns.resultRepresentation,
        resultContentNamespaceId: taskRuns.resultContentNamespaceId,
        resultRevision: taskRuns.resultRevision,
        resultCryptoObjectId: taskRuns.resultCryptoObjectId,
        resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
        resultCryptoMappingState: taskRuns.resultCryptoMappingState,
      }).from(taskRuns).where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
      )).limit(2);
      let run = runRows[0];
      if (runRows.length !== 1 || run === undefined) {
        throw new ProtectedTaskRouteError(404, "task_run_not_found", "Task run not found");
      }
      if (task.contentNamespaceId !== null) {
        const refreshedAccess = await refreshMappedReadAccess(taskAuthority, {
          kind: "run_result",
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          contentRevision: run.resultRevision === 1 || run.resultRevision === 2
            ? run.resultRevision
            : run.status === "cancelled" ? 2 : 1,
        }, task.contentNamespaceId);
        if (refreshedAccess !== "unavailable") {
        taskRows = await dependencies.db.select({
          ownerId: tasks.ownerId,
          requestorId: tasks.requestorId,
          agentId: tasks.agentId,
          contentRepresentation: tasks.contentRepresentation,
          contentNamespaceId: tasks.contentNamespaceId,
          cryptoMappingState: tasks.cryptoMappingState,
        }).from(tasks).where(eq(tasks.id, input.taskId)).limit(2);
        runRows = await dependencies.db.select({
          taskId: taskRuns.taskId,
          status: taskRuns.status,
          resultRepresentation: taskRuns.resultRepresentation,
          resultContentNamespaceId: taskRuns.resultContentNamespaceId,
          resultRevision: taskRuns.resultRevision,
          resultCryptoObjectId: taskRuns.resultCryptoObjectId,
          resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
          resultCryptoMappingState: taskRuns.resultCryptoMappingState,
        }).from(taskRuns).where(and(
          eq(taskRuns.id, input.taskRunId),
          eq(taskRuns.taskId, input.taskId),
        )).limit(2);
        task = taskRows[0];
        run = runRows[0];
        if (taskRows.length !== 1 || task === undefined
          || runRows.length !== 1 || run === undefined
          || resolveOwnedProtectedTaskAuthority(input.authority, task) === null) {
          throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
        }
        }
      }
      const terminalResultRevision = run.status === "cancelled"
        ? 2 as const
        : run.status === "completed" || run.status === "errored"
        ? 1 as const
        : null;
      const resultRevision = terminalResultRevision ?? 1;
      let reference: Readonly<{
        readVersion: 1;
        taskId: string;
        taskRunId: string;
        objectId: string;
        resultRevision: 1 | 2;
        cryptoAccessRevision: number;
      }> = Object.freeze({
        readVersion: 1 as const,
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        objectId: deriveTaskContentCryptoObjectIdV1({
          kind: "run_result",
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          contentRevision: resultRevision,
        }),
        resultRevision,
        cryptoAccessRevision: 0,
      });
      const unavailable = (
        reason: Extract<
          ProtectedTaskRunResultReadEnvelopeV1,
          { status: "unavailable" }
        >["reason"],
      ): ProtectedTaskRunResultReadEnvelopeV1 => Object.freeze({
        ...reference,
        status: "unavailable" as const,
        reason,
      });
      if (
        (task.contentRepresentation !== "protected"
          && task.contentRepresentation !== "dual")
        || task.cryptoMappingState !== "verified"
        || task.contentNamespaceId === null
      ) return unavailable("result_not_protected");
      const ledgerRows = await dependencies.db.select({
        taskId: taskRunResultCryptoRevisions.taskId,
        taskRunId: taskRunResultCryptoRevisions.taskRunId,
        requesterHumanId: taskRunResultCryptoRevisions.requesterHumanId,
        contentNamespaceId: taskRunResultCryptoRevisions.contentNamespaceId,
        anchorNamespaceId: taskRunResultCryptoRevisions.anchorNamespaceId,
        resultRevision: taskRunResultCryptoRevisions.resultRevision,
        cryptoObjectId: taskRunResultCryptoRevisions.cryptoObjectId,
        representation: taskRunResultCryptoRevisions.representation,
        cryptoAccessRevision:
          taskRunResultCryptoRevisions.cryptoAccessRevision,
        completion: taskRunResultCryptoRevisions.completion,
        disposition: taskRunResultCryptoRevisions.disposition,
        failureCode: taskRunResultCryptoRevisions.failureCode,
        historicalRepair: taskRunResultCryptoRevisions.historicalRepair,
      }).from(taskRunResultCryptoRevisions).where(and(
        eq(taskRunResultCryptoRevisions.taskId, input.taskId),
        eq(taskRunResultCryptoRevisions.taskRunId, input.taskRunId),
      )).limit(3);
      const selectedLedgers = ledgerRows.filter(candidate =>
        run.status === "cancelled"
          ? candidate.resultRevision === 2
            || candidate.resultRevision === 1
              && candidate.historicalRepair !== null
          : candidate.resultRevision === resultRevision);
      const ledger = run.status === "cancelled"
        ? selectedLedgers.find(candidate => candidate.resultRevision === 2)
          ?? selectedLedgers[0]
        : selectedLedgers[0];
      if (selectedLedgers.length > 1 && ledger?.resultRevision !== 2) {
        return unavailable("integrity_failure");
      }
      let historicalRepair: Extract<
        TaskHistoricalRepairProvenanceV1,
        { version: 2 }
      > | null;
      try {
        historicalRepair = historicalRepairV2(ledger?.historicalRepair);
      } catch {
        return unavailable("integrity_failure");
      }
      if (historicalRepair !== null) {
        if (ledger === undefined || ledger.resultRevision !== 1) {
          return unavailable("integrity_failure");
        }
        reference = Object.freeze({
          ...reference,
          objectId: ledger.cryptoObjectId,
          resultRevision: 1 as const,
        });
      }
      const exactLedger = ledger !== undefined
        && ledger.taskId === input.taskId
        && ledger.taskRunId === input.taskRunId
        && ledger.contentNamespaceId === task.contentNamespaceId
        && ledger.anchorNamespaceId === task.contentNamespaceId
        && ledger.resultRevision === reference.resultRevision
        && ledger.cryptoObjectId === reference.objectId
        && (ledger.representation === "protected"
          || ledger.representation === "dual")
        // Result allocation likewise remains the immutable genesis coordinate
        // after a Human metadata rewrap advances the mapped Run head.
        && ledger.cryptoAccessRevision === 0
        && (historicalRepair === null || (
          task.contentRepresentation === "dual"
          && ledger.representation === "dual"
          && ledger.cryptoObjectId === taskContentRevisionObjectIdV1({
            coordinate: {
              kind: "run_result",
              taskId: input.taskId,
              taskRunId: input.taskRunId,
              contentRevision: 1,
            },
            namespaceId: ledger.contentNamespaceId,
            historicalRepair,
          })
        ));
      if (
        run.resultRepresentation === "ordinary"
        && run.resultRevision === 0
        && run.resultContentNamespaceId === null
        && run.resultCryptoObjectId === null
        && run.resultCryptoAccessRevision === 0
        && run.resultCryptoMappingState === "unmapped"
      ) {
        if (ledger === undefined) {
          return run.status === "completed" || run.status === "errored"
            || run.status === "cancelled"
            ? unavailable("result_not_protected")
            : Object.freeze({
                readVersion: 1 as const,
                taskId: reference.taskId,
                taskRunId: reference.taskRunId,
                objectId: reference.objectId,
                resultRevision: reference.resultRevision,
                cryptoAccessRevision: 0 as const,
                status: "waiting" as const,
                reason: "result_not_mapped" as const,
              });
        }
        if (!exactLedger) return unavailable("integrity_failure");
        if (ledger.disposition === "active"
          && (ledger.completion === "pending"
            || ledger.completion === "complete")) {
          return Object.freeze({
            readVersion: 1 as const,
            taskId: reference.taskId,
            taskRunId: reference.taskRunId,
            objectId: reference.objectId,
            resultRevision: reference.resultRevision,
            cryptoAccessRevision: 0 as const,
            status: "waiting" as const,
            reason: "result_not_mapped" as const,
          });
        }
        return unavailable(ledger.failureCode === "authority_stale"
          ? "authority_changed" : "integrity_failure");
      }
      reference = Object.freeze({
        ...reference,
        cryptoAccessRevision: run.resultCryptoAccessRevision,
      });
      if (
        terminalResultRevision === null
        || (run.resultRepresentation !== "protected"
          && run.resultRepresentation !== "dual")
        || run.resultRevision !== reference.resultRevision
        || run.resultContentNamespaceId !== task.contentNamespaceId
        || run.resultCryptoObjectId !== reference.objectId
        || run.resultCryptoMappingState !== "verified"
      ) return unavailable("integrity_failure");
      if (!exactLedger || ledger === undefined
        || ledger.completion !== "complete"
        || ledger.disposition !== "mapped"
        || ledger.representation !== run.resultRepresentation) {
        return unavailable("integrity_failure");
      }
      const current = await currentPrivateAuthority(
        taskAuthority,
        run.resultContentNamespaceId,
      );
      if (current === null) return unavailable("authority_changed");
      try {
        if (current.content.requesterHumanId !== input.authority.subjectHumanId
          || current.content.requesterHumanId !== ledger.requesterHumanId) {
          return unavailable("authority_changed");
        }
      } finally {
        current.bindingHash.fill(0);
      }
      const verifiedCryptoHandle = await cryptoHandle();
      const storage = new PostgresLatticeStorage(verifiedCryptoHandle);
      let object;
      let access;
      try {
        [object, access] = await Promise.all([
          storage.getObject(reference.objectId),
          storage.getObjectAccessState(reference.objectId),
        ]);
      } catch (error) {
        if (error instanceof ClassifiedDataOperationError
          || error instanceof TypeError) {
          return unavailable("integrity_failure");
        }
        throw error;
      }
      if (object === null || access === null
        || access.head.accessRevision !== run.resultCryptoAccessRevision
        || access.namespaceEnvelopes.length !== 1
        || access.namespaceEnvelopes[0]?.namespaceId
          !== run.resultContentNamespaceId) {
        object?.payloadBytes.fill(0);
        access?.head.manifestBytes.fill(0);
        access?.head.manifestHash.fill(0);
        access?.namespaceEnvelopes.forEach((envelope) => {
          envelope.envelopeBytes.fill(0);
          envelope.envelopeHash.fill(0);
        });
        return unavailable("integrity_failure");
      }
      const history = new PostgresHumanDeviceSignerHistory({
        handle: verifiedCryptoHandle,
        crypto: dependencies.crypto,
      });
      const foreground = historicalRepair === null
        ? await foregroundSignerTransport(input.authority.userId)
        : null;
      const humanSigners = createProtectedTaskHumanSignerTransport(
        resolveHistoricalHumanDeviceSigningPublicKey,
      );
      let chain: readonly Uint8Array[];
      try {
        chain = await readAccessManifestChain(
          reference.objectId,
          run.resultCryptoAccessRevision,
        );
      } catch (error) {
        foreground?.destroy();
        humanSigners.destroy();
        object.payloadBytes.fill(0);
        access.head.manifestBytes.fill(0);
        access.head.manifestHash.fill(0);
        access.namespaceEnvelopes.forEach(entry => {
          entry.envelopeBytes.fill(0);
          entry.envelopeHash.fill(0);
        });
        if (error instanceof ProtectedTaskRouteError) {
          return unavailable(error.code === "unsupported_crypto_access_revision"
            ? "unsupported_crypto_access_revision" : "integrity_failure");
        }
        throw error;
      }
      const payloadHash = dependencies.crypto.hash(object.payloadBytes);
      let verified;
      try {
        try {
          verified = await verifyStoredObjectAccessManifestChainV5({
            executor: verifiedCryptoHandle,
            crypto: dependencies.crypto,
            objectId: reference.objectId,
            headAccessRevision: run.resultCryptoAccessRevision,
            expectedPayloadHash: payloadHash,
            expectedHeadManifestHash: access.head.manifestHash,
            resolveHistoricalAgentManagerAuthority:
              history.resolveAgentRuntimeSignerManager,
            resolveLiveShadowAgentSigner: foreground?.resolveSigner,
            resolveHistoricalHumanDeviceSigningPublicKey:
              humanSigners.resolve,
          });
        } catch (error) {
          if (error instanceof ClassifiedDataOperationError
            || error instanceof TypeError) {
            return unavailable("integrity_failure");
          }
          throw error;
        }
        const genesis = decodeObjectAccessManifestV5(chain[0]!);
        let genesisKind: "agent_runtime" | "human_device";
        let foregroundEvidence: ReturnType<
          NonNullable<typeof foreground>["evidenceFor"]
        > = null;
        try {
          genesisKind = validateProtectedTaskReadManifestSigners({
            crypto: dependencies.crypto,
            chain,
            expectedAgentId: task.agentId,
            requesterHumanId: input.authority.subjectHumanId,
            historicalRepair,
            allowHumanGenesis: false,
          });
          foregroundEvidence = genesis.signer.kind === "agent_runtime"
            ? foreground?.evidenceFor(genesis.signer, task.agentId) ?? null
            : null;
        } finally {
          wipeDecodedAccessManifest(genesis);
        }
        const historicalSigner = historicalRepair !== null
          && genesisKind === "human_device"
          && verified.genesisHumanId === input.authority.subjectHumanId;
        const agentEvidence = historicalRepair === null
          && genesisKind === "agent_runtime"
          && verified.genesisHumanId === null
          ? projectVerifiedProtectedTaskRunResultAgentSignerEvidence({
              verifiedSignerEvidence: verified.signerEvidence,
              foregroundEvidence,
            })
          : null;
        const nativeSigner = historicalRepair === null
          && genesisKind === "agent_runtime"
          && verified.genesisHumanId === null
          && agentEvidence !== null;
        if (!historicalSigner && !nativeSigner) {
          return unavailable("integrity_failure");
        }
        const signerEvidence = [
          ...(agentEvidence ?? []),
          ...humanSigners.evidence(),
        ];
        let readAuthority: ProtectedTaskNamespaceReadAuthority | null;
        try {
          readAuthority = await resolveProtectedTaskEnvelopeReadAuthority({
            objectId: reference.objectId,
            namespaceId: run.resultContentNamespaceId,
            envelopeBytes: access.namespaceEnvelopes[0].envelopeBytes,
            authority: taskAuthority,
            resolveReadAuthority: resolvePrivateReadAuthority,
          });
        } catch (error) {
          if (error instanceof TypeError) return unavailable("integrity_failure");
          throw error;
        }
        if (readAuthority === null) return unavailable("authority_changed");
        const stableAccess = await storage.getObjectAccessState(reference.objectId);
        if (stableAccess === null
          || stableAccess.head.accessRevision !== run.resultCryptoAccessRevision
          || !sameBytes(stableAccess.head.manifestHash, access.head.manifestHash)) {
          stableAccess?.head.manifestBytes.fill(0);
          stableAccess?.head.manifestHash.fill(0);
          stableAccess?.namespaceEnvelopes.forEach(entry => {
            entry.envelopeBytes.fill(0);
            entry.envelopeHash.fill(0);
          });
          return unavailable("authority_changed");
        }
        stableAccess.head.manifestBytes.fill(0);
        stableAccess.head.manifestHash.fill(0);
        stableAccess.namespaceEnvelopes.forEach(entry => {
          entry.envelopeBytes.fill(0);
          entry.envelopeHash.fill(0);
        });
        return Object.freeze({
          ...reference,
          status: "ready" as const,
          namespaceId: run.resultContentNamespaceId,
          readAuthority,
          encryptedPayloadBytesBase64url:
            Buffer.from(object.payloadBytes).toString("base64url"),
          accessManifestBytesBase64url:
            Buffer.from(access.head.manifestBytes).toString("base64url"),
          accessManifestProofBytesBase64url: chain.slice(0, -1).map(value =>
            Buffer.from(value).toString("base64url")),
          namespaceEnvelopeBytesBase64url: Buffer.from(
            access.namespaceEnvelopes[0].envelopeBytes,
          ).toString("base64url"),
          ...(historicalRepair === null ? {} : { historicalRepair }),
          signerEvidence,
        }) satisfies ProtectedTaskRunResultReadReadyEnvelopeV1;
      } finally {
        foreground?.destroy();
        humanSigners.destroy();
        chain.forEach(value => value.fill(0));
        payloadHash.fill(0);
        object.payloadBytes.fill(0);
        access.head.manifestBytes.fill(0);
        access.head.manifestHash.fill(0);
        for (const envelope of access.namespaceEnvelopes) {
          envelope.envelopeBytes.fill(0);
          envelope.envelopeHash.fill(0);
        }
        if (verified !== undefined) {
          destroyVerifiedStoredObjectAccessManifestChainV5(verified);
        }
      }
    },

    plan: (input) =>
      buildPlan(input.authority, input.taskId, input.request),

    async publishCreate({ authority, prepared }) {
      const durable = await repository(authority);
      const freshPlan = await buildPlan(authority, null, {
        requestVersion: 1,
        operation: "create",
        operationId: prepared.operationId,
        task: prepared.task,
      });
      const imported = await importProtectedTaskPublicationV1({
        crypto: dependencies.crypto,
        now: now(),
        plan: freshPlan.planDigestBase64url === prepared.planDigestBase64url
          ? freshPlan : null,
        prepared,
        resolveCurrentAuthority: (request) =>
          resolveSignedAuthority(authority, request),
        lookupPreparedReplay: (request) => durable.lookupPreparedReplay(request),
      });
      const common = {
        owner: dependencies.owner,
        operationId: prepared.operationId,
        requestDigest: imported.requestDigest,
        authority: imported.authority,
        operationalMetadata: emptyMetadata(),
        prepared: imported.prepared,
      } as const;
      const publicationRequest = decodePreparedTaskPublicationRequest(prepared);
      let publication;
      try {
        publication = await withCurrentProtectedTaskPublicationDeviceAuthority(
          dependencies.restricted,
          authority,
          publicationRequest,
          () => imported.representation === "dual"
            ? durable.publishPrepared({
              ...common,
              representation: "dual",
              ordinaryContent: imported.ordinaryContent,
              publishProduct: (content: TaskContentPayloadV1) =>
                createProduct(
                  authority,
                  prepared.taskId,
                  prepared.task,
                  (content as Extract<TaskContentPayloadV1, {
                    coordinate: { kind: "definition" };
                  }>).payload,
                ),
            })
            : durable.publishPrepared({
              ...common,
              representation: "protected",
              publishProduct: () => createProduct(
                authority,
                prepared.taskId,
                prepared.task,
                null,
              ),
            }),
        );
      } finally {
        destroyTaskPublicationRequest(publicationRequest);
      }
      if (publication.protectedRevision?.status !== "mapped"
        && publication.protectedRevision?.status !== "replayed") {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_mapping_pending",
          "Task content mapping is pending",
        );
      }
      const activated = readCreatedTask(
        (await readTaskSource(authority, publication.product.id))?.task,
        authority,
      );
      if (activated.status === "pending" && activated.scheduleKind === "now") {
        dependencies.observer.kick();
      }
      return Object.freeze({
        taskId: activated.id,
        status: activated.status,
        nextFireAt: activated.nextFireAt?.toISOString() ?? null,
      });
    },

    async publishUpdate({ authority, taskId, prepared }) {
      const ownedSource = await readMutationSource(authority, taskId);
      if (ownedSource === undefined) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const ownedTask = ownedSource.task;
      const taskAuthority = resolveOwnedProtectedTaskAuthority(authority, ownedTask);
      if (taskAuthority === null) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const repairSource = fallbackRepairSource(ownedTask);
      const durable = await repository(taskAuthority);
      const freshPlan = await buildPlan(taskAuthority, taskId, {
        requestVersion: 1,
        operation: "update",
        operationId: prepared.operationId,
        task: prepared.task,
      }, {
        mutationVersion: ownedTask.mutationVersion,
        fallbackRepairSource: repairSource,
      });
      const imported = await importProtectedTaskPublicationV1({
        crypto: dependencies.crypto,
        now: now(),
        plan: freshPlan.planDigestBase64url === prepared.planDigestBase64url
          ? freshPlan : null,
        prepared,
        resolveCurrentAuthority: (request) =>
          resolveSignedAuthority(taskAuthority, request),
        lookupPreparedReplay: (request) => durable.lookupPreparedReplay(request),
      });
      const currentSource = await readMutationSource(taskAuthority, taskId);
      if (currentSource === undefined || currentSource.task.ownerId !== taskAuthority.userId
        || currentSource.task.agentId !== taskAuthority.agentId) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const { task: current } = currentSource;
      if (current.mutationVersion !== ownedTask.mutationVersion
        || !sameFallbackRepairSource(fallbackRepairSource(current), repairSource)) {
        throw new ProtectedTaskRouteError(
          409,
          "task_changed",
          "Task changed while the update was prepared",
        );
      }
      if (repairSource !== null && imported.representation !== "dual") {
        throw new ProtectedTaskRouteError(
          409,
          "task_not_mutable",
          "Fallback Task repair requires dual publication",
        );
      }
      const operationalMetadata = operationalMetadataFor(currentSource);
      const common = {
        owner: dependencies.owner,
        operationId: prepared.operationId,
        requestDigest: imported.requestDigest,
        authority: imported.authority,
        operationalMetadata,
        prepared: imported.prepared,
        ...(repairSource === null ? {} : {
          fallbackRepairSource: repairSource,
        }),
      } as const;
      const publicationRequest = decodePreparedTaskPublicationRequest(prepared);
      let publication;
      try {
        publication = await withCurrentProtectedTaskPublicationDeviceAuthority(
          dependencies.restricted,
          taskAuthority,
          publicationRequest,
          () => imported.representation === "dual"
            ? durable.publishPrepared({
              ...common,
              representation: "dual",
              ordinaryContent: imported.ordinaryContent,
              publishProduct: (content: TaskContentPayloadV1) =>
                updateProduct(
                  taskAuthority,
                  taskId,
                  prepared.expectedContentRevision,
                  ownedTask.mutationVersion,
                  repairSource,
                  prepared.task,
                  (content as Extract<TaskContentPayloadV1, {
                    coordinate: { kind: "definition" };
                  }>).payload,
                ),
            })
            : durable.publishPrepared({
              ...common,
              representation: "protected",
              publishProduct: () => updateProduct(
                taskAuthority,
                taskId,
                prepared.expectedContentRevision,
                ownedTask.mutationVersion,
                repairSource,
                prepared.task,
                null,
              ),
            }),
        );
      } finally {
        destroyTaskPublicationRequest(publicationRequest);
      }
      if (publication.protectedRevision?.status !== "mapped"
        && publication.protectedRevision?.status !== "replayed") {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_mapping_pending",
          "Task content mapping is pending",
        );
      }
      const task = (await readTaskSource(taskAuthority, taskId))?.task;
      if (task === undefined) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const [names, models] = await Promise.all([
        getOwnerAgentDisplayNamesByAgentId(
          dependencies.db,
          taskAuthority.userId,
          [task.agentId],
        ),
        getLatestRunModelByTask(dependencies.db, [task.id]),
      ]);
      return toTaskContentSummaryV1(task, {
        agentName: names.get(task.agentId) ?? null,
        lastModelId: models.get(task.id) ?? null,
      });
    },
  };

  const composition = Object.freeze({
    mode: "protected_task_production" as const,
    ports: Object.freeze(ports),
  });
  productionCompositions.add(composition);
  return composition;
}
