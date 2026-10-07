import {
  acquireEncryptionConsumptionFence,
  type ParkedProtectedTaskAdditionalAuthority,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  type DomainForegroundAuthorityEntry,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationV2,
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  verifyDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresDomainKeyAuthorityRepository,
} from "../delivery/postgres-domain-key-authority.ts";
import {
  inspectNamespaceProductAuthoritySnapshot,
  PostgresNamespaceProductAuthority,
} from "../delivery/postgres-namespace-product-authority.ts";
import {
  PostgresDeviceAdmissionRepository,
  type CurrentDeviceAdmissionAuthority,
} from "../device/postgres-device-admission-repository.ts";
import {
  matchesStenographerRequestAdmission,
  type StenographerRequestAdmission,
} from "../journal/current-stenographer-authority.ts";
import type {
  ConversationProductCanonicalTransactionRunner,
} from "../message/postgres-conversation-product-store.ts";
import {
  verifyCryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import {
  copyParkedTaskRuntimeAuthority,
  copyParkedTaskRuntimeExpectedNamespaceParticipants,
  currentParkedTaskRuntimeRoutingFacts,
  exactCurrentParkedTaskScopeMemory,
  lockCurrentParkedTaskAdditionalAuthorityWithRouting,
  parkedTaskRuntimeNamespaceParticipantsMatch,
  parkedTaskRuntimeScopeBindingMatches,
  withParkedTaskRuntimeRestrictedAuthority,
  type ParkedTaskRuntimeCurrentRoutingFacts,
  type ParkedTaskRuntimeExpectedNamespaceParticipants,
  type ParkedTaskRuntimeLockedRoutingTask,
} from "./parked-task-runtime-authority.ts";
import {
  copyTaskScopeMemoryBinding,
  type TaskScopeMemoryBinding,
} from "./task-scope-memory-metadata.ts";

export type TaskRuntimeNamespaceAuthorityRequirement = Readonly<{
  ordinal: number;
  namespaceId: string;
  domainId: string;
  operations: readonly ("decrypt" | "encrypt")[];
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
}>;

export type TaskRuntimeDomainAuthorityRequirement = Readonly<{
  ordinal: number;
  domainId: string;
  expectedEpoch: number;
  expectedAuthorizationRevision: number;
}>;

export type CurrentTaskRuntimeAuthority = Readonly<{
  device: CurrentDeviceAdmissionAuthority;
  plan: DomainForegroundAuthorizationPlanV2;
  domains: readonly DomainForegroundAuthorityEntry[];
  namespaceRequirements:
    readonly TaskRuntimeNamespaceAuthorityRequirement[];
  policyRevision: number;
}>;

export type TaskRuntimeAuthoritySubject = Readonly<{
  userId: string;
  humanActorId: string;
  deviceId: string;
}>;

/** Durable V3 facts authenticated at response acceptance, without its bearer. */
export type AcceptedTaskRuntimeAuthorizationV3 = Readonly<{
  descriptorBytes: Uint8Array;
  descriptorDigest: string;
  requestId: string;
  workId: string;
  workKind: TaskRuntimeBackgroundAuthorizationRequestV1["workKind"];
  workPurpose: TaskRuntimeBackgroundAuthorizationRequestV1["workPurpose"];
  recipientGeneration: number;
  recipientKeyId: string;
  recipientPublicKeyBase64url: string;
  expectedPolicyRevision: number;
  namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
  authorizationId: string;
  authorizationBytes: Uint8Array;
  authorizationDigest: string;
  authorizationExpiresAt: number;
  issuingHumanId: string;
  issuingDeviceId: string;
  issuingDeviceAuthorizationRevision: number;
  issuerSigningPublicKeyHash: Uint8Array;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameDomainAuthority(
  expected: DomainForegroundAuthorityEntry,
  current: DomainForegroundAuthorityEntry,
): boolean {
  return expected.domainId === current.domainId
    && expected.sourceNamespaceId === current.sourceNamespaceId
    && expected.participantCount === current.participantCount
    && expected.keyClass === current.keyClass
    && expected.domainKeyGeneration === current.domainKeyGeneration
    && expected.authorizationRevision === current.authorizationRevision
    && expected.activeNamespaceBindingCount
      === current.activeNamespaceBindingCount
    && sameBytes(expected.participantDigest, current.participantDigest)
    && sameBytes(expected.headDigest, current.headDigest)
    && sameBytes(
      expected.activeNamespaceBindingSetDigest,
      current.activeNamespaceBindingSetDigest,
    );
}

function inTransaction(
  connection: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {
    query: connection.query.bind(connection),
    transaction: (use) => use(connection),
    transactionOnce: (use) => use(connection),
  };
}

function copyNamespaceRequirements(
  requirements: readonly TaskRuntimeNamespaceAuthorityRequirement[],
): readonly TaskRuntimeNamespaceAuthorityRequirement[] {
  return Object.freeze(requirements.map((requirement) => Object.freeze({
    ordinal: requirement.ordinal,
    namespaceId: requirement.namespaceId,
    domainId: requirement.domainId,
    operations: Object.freeze([...requirement.operations]),
    expectedAccessRevision: requirement.expectedAccessRevision,
    expectedPolicyRevision: requirement.expectedPolicyRevision,
  })));
}

function copyDomainRequirements(
  requirements: readonly TaskRuntimeDomainAuthorityRequirement[],
): readonly TaskRuntimeDomainAuthorityRequirement[] {
  return Object.freeze(requirements.map((requirement) =>
    Object.freeze({ ...requirement })));
}

function requirementsAreCanonical(
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[],
  domains: readonly TaskRuntimeDomainAuthorityRequirement[],
): boolean {
  if (namespaces.length < 1 || domains.length < 1) return false;
  if (namespaces.some((requirement, index) =>
    requirement.ordinal !== index
    || (index > 0
      && namespaces[index - 1]!.namespaceId >= requirement.namespaceId)
    || !(
      requirement.operations.length === 1
        && (requirement.operations[0] === "decrypt"
          || requirement.operations[0] === "encrypt")
      || requirement.operations.length === 2
        && requirement.operations[0] === "decrypt"
        && requirement.operations[1] === "encrypt"
    )
  )) return false;
  if (domains.some((requirement, index) =>
    requirement.ordinal !== index
    || (index > 0 && domains[index - 1]!.domainId >= requirement.domainId)
  )) return false;
  const namespaceDomainIds = [...new Set(
    namespaces.map((requirement) => requirement.domainId),
  )].sort();
  return namespaceDomainIds.length === domains.length
    && domains.every((requirement, index) =>
      requirement.domainId === namespaceDomainIds[index]);
}

function matchesCurrentTaskRuntimeAuthorityWithoutAdmission(input: Readonly<{
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  plan: DomainForegroundAuthorizationPlanV2;
  subject: TaskRuntimeAuthoritySubject;
  device: CurrentDeviceAdmissionAuthority;
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
  domains: readonly DomainForegroundAuthorityEntry[];
  policyRevision: number;
  now: number;
}>): boolean {
  const {
    request,
    plan,
    subject,
    device,
    namespaces,
    domainRequirements, domains,
  } = input;
  return input.now >= request.issuedAt
    && input.now < request.deadlineAt
    && plan.policyRevision === input.policyRevision
    && plan.subjectHumanId === subject.humanActorId
    && plan.committerDeviceId === subject.deviceId
    && device.userId === subject.userId
    && device.humanActorId === subject.humanActorId
    && device.deviceId === subject.deviceId
    && plan.committerDeviceSigningGeneration === device.deviceGeneration
    && plan.hostAuthorizationRevision === device.securityRevision
    && plan.recipientKind === "runtime"
    && plan.recipientPrincipalId === "nautilo_task_runtime"
    && plan.recipientAuthorizationRevision === 0
    && plan.operations.length === 2
    && plan.operations[0] === "decrypt"
    && plan.operations[1] === "encrypt"
    && requirementsAreCanonical(namespaces, domainRequirements)
    && namespaces.every((requirement) =>
      requirement.expectedPolicyRevision === input.policyRevision
      && requirement.operations.every((operation) =>
        plan.operations.includes(operation)))
    && domains.length === plan.domains.length
    && domains.length === domainRequirements.length
    && domains.every((domain, index) => {
      const expected = plan.domains[index];
      const requirement = domainRequirements[index];
      return expected !== undefined
        && requirement !== undefined
        && sameDomainAuthority(expected, domain)
        && requirement.domainId === domain.domainId
        && requirement.expectedEpoch === domain.domainKeyGeneration
        && requirement.expectedAuthorizationRevision
          === domain.authorizationRevision;
    });
}

export function matchesCurrentTaskRuntimeAuthority(input: Readonly<{
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  plan: DomainForegroundAuthorizationPlanV2;
  subject: TaskRuntimeAuthoritySubject;
  admission: StenographerRequestAdmission;
  device: CurrentDeviceAdmissionAuthority;
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
  domains: readonly DomainForegroundAuthorityEntry[];
  policyRevision: number;
  now: number;
}>): boolean {
  return matchesCurrentTaskRuntimeAuthorityWithoutAdmission(input)
    && matchesStenographerRequestAdmission(
      input.admission,
      input.device,
      input.now,
    );
}

function retainBytes(value: object, owned: Uint8Array[]): void {
  for (const field of Object.values(value)) {
    if (field instanceof Uint8Array) owned.push(field);
  }
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function acceptedRecordMatchesRequest(input: Readonly<{
  accepted: AcceptedTaskRuntimeAuthorizationV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  plan: DomainForegroundAuthorizationPlanV2;
  descriptorDigest: string;
  authorizationDigest: string;
}>): boolean {
  const { accepted, request, plan } = input;
  return accepted.descriptorDigest === input.descriptorDigest
    && accepted.requestId === request.requestId
    && accepted.workId === request.workId
    && accepted.workKind === request.workKind
    && accepted.workPurpose === request.workPurpose
    && accepted.recipientGeneration === request.recipientGeneration
    && accepted.recipientKeyId === request.recipientKeyId
    && accepted.recipientPublicKeyBase64url
      === Buffer.from(request.recipientPublicKey).toString("base64url")
    && accepted.expectedPolicyRevision === plan.policyRevision
    && accepted.authorizationId === plan.authorizationId
    && accepted.authorizationDigest === input.authorizationDigest
    && accepted.authorizationExpiresAt === request.deadlineAt
    && accepted.issuingHumanId === plan.subjectHumanId
    && accepted.issuingDeviceId === plan.committerDeviceId;
}

/**
 * Holds the current Task Runtime grant authority in the canonical
 * policy -> Room/membership -> restricted order. The callback remains inside
 * all three lock lifetimes and must use the supplied connections for the
 * response verification and durable acceptance CAS.
 */
export async function withCurrentTaskRuntimeAuthority<Value>(input: Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  subject: TaskRuntimeAuthoritySubject;
  admission: StenographerRequestAdmission;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
  domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
  now(): number;
  signal?: AbortSignal;
  use(
    authority: CurrentTaskRuntimeAuthority,
    product: PostgresJsBridgeConnection,
    restricted: PostgresJsBridgeConnection,
  ): Promise<Value>;
}>): Promise<Value | null> {
  const encodedRequest = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    input.request,
  );
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(encodedRequest);
  encodedRequest.fill(0);
  if (request === null) {
    throw new TypeError("Task Runtime authorization request is invalid");
  }
  const plan = parseDomainForegroundAuthorizationPlanV2(
    request.authorizationPlanBytes,
  );
  if (plan === null) {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    throw new TypeError("Task Runtime authorization plan is invalid");
  }
  const owned: Uint8Array[] = [];
  try {
    const namespaces = copyNamespaceRequirements(input.namespaceRequirements);
    const domainRequirements = copyDomainRequirements(input.domainRequirements);
    const admission = Object.freeze({
      ...input.admission,
      headDigest: Uint8Array.from(input.admission.headDigest),
    });
    owned.push(admission.headDigest);
    if (!requirementsAreCanonical(namespaces, domainRequirements)) {
      throw new TypeError("Task Runtime authority requirements are invalid");
    }
    input.signal?.throwIfAborted();
    return await input.runner.transaction(async (tx, executor) => {
      const policy = await acquireEncryptionConsumptionFence(tx);
      if (policy.mode === "plaintext_only"
        || policy.revision !== plan.policyRevision
        || namespaces.some((requirement) =>
          requirement.expectedPolicyRevision !== policy.revision)) return null;
      const product = inTransaction(executor);
      return new PostgresNamespaceProductAuthority(product)
        .withCurrentReadableNamespaceSet({
          subjectUserId: input.subject.userId,
          subjectHumanId: input.subject.humanActorId,
          sourceRoomId: request.sourceRoomId,
          namespaceIds: namespaces.map((requirement) =>
            requirement.namespaceId),
          use: async (entries) => {
            if (entries.length !== namespaces.length) return null;
            for (const [index, entry] of entries.entries()) {
              const requirement = namespaces[index];
              const current = inspectNamespaceProductAuthoritySnapshot(
                entry.authority,
              );
              try {
                if (requirement === undefined
                  || entry.namespaceId !== requirement.namespaceId
                  || current.accessRevision
                    !== requirement.expectedAccessRevision) return null;
              } finally {
                current.audienceFingerprint.fill(0);
              }
            }
            input.signal?.throwIfAborted();
            return input.restricted.transactionOnce(async (restrictedTx) => {
              const restricted = inTransaction(restrictedTx);
              const inspected = await new PostgresDomainKeyAuthorityRepository(
                restricted,
                input.crypto,
                input.serverScope,
              ).inspectForegroundAuthority({
                namespaceIds: namespaces.map((requirement) =>
                  requirement.namespaceId),
                keyClass: "ai",
                subjectHumanId: input.subject.humanActorId,
                deviceId: input.subject.deviceId,
              });
              if (inspected.status !== "ready") return null;
              for (const domain of inspected.domains) retainBytes(domain, owned);
              // The native inspector has now locked the device/group projection,
              // Namespaces, and Domains. Read group security authority only after
              // those locks; its securityRevision is a distinct counter from the
              // inspector's device-projection revision.
              const device = await new PostgresDeviceAdmissionRepository(
                await verifyCryptoPostgresHandle(restricted),
                input.crypto,
              ).currentAuthorityForDelegation(input.subject);
              if (device === null) return null;
              retainBytes(device, owned);
              if (inspected.committerDeviceId !== device.deviceId
                || inspected.committerDeviceSigningGeneration
                  !== device.deviceGeneration
                || !matchesCurrentTaskRuntimeAuthority({
                  request,
                  plan,
                  subject: input.subject,
                  admission,
                  device,
                  namespaces,
                  domainRequirements,
                  domains: inspected.domains,
                  policyRevision: policy.revision,
                  now: input.now(),
                })) return null;
              input.signal?.throwIfAborted();
              const result = await input.use({
                device,
                plan,
                domains: inspected.domains,
                namespaceRequirements: namespaces,
                policyRevision: policy.revision,
              }, product, restricted);
              input.signal?.throwIfAborted();
              const finishedAt = input.now();
              if (finishedAt >= request.deadlineAt
                || !matchesStenographerRequestAdmission(
                  admission,
                  device,
                  finishedAt,
                )) {
                throw new Error(
                  "Task Runtime authority expired before commit",
                );
              }
              return result;
            }, { isolationLevel: "read committed" });
          },
        });
    }, { isolationLevel: "read committed" });
  } finally {
    owned.forEach((bytes) => bytes.fill(0));
    destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
  }
}

type CurrentAcceptedTaskRuntimeAuthorityInput = Readonly<{
    runner: ConversationProductCanonicalTransactionRunner;
    restricted: PostgresJsBridgeConnection;
    crypto: LatticeCrypto;
    serverScope: string;
    subject: TaskRuntimeAuthoritySubject;
    accepted: AcceptedTaskRuntimeAuthorizationV3;
    now(): number;
    signal?: AbortSignal;
}>;

type CurrentAcceptedTaskRuntimeAuthorityUse<Value> =
  | Readonly<{
    kind: "current";
    use(
      authority: CurrentTaskRuntimeAuthority,
      product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection,
    ): Promise<Value>;
  }>
  | Readonly<{
    kind: "parked";
    expected: ParkedProtectedTaskAdditionalAuthority;
    targetRoomId: string;
    scopeMemory?: TaskScopeMemoryBinding;
    expectedNamespaceParticipants?: ParkedTaskRuntimeExpectedNamespaceParticipants;
    validateCurrentRouting(
      facts: ParkedTaskRuntimeCurrentRoutingFacts,
    ): boolean | Promise<boolean>;
    use(
      authority: CurrentTaskRuntimeAuthority,
      restricted: PostgresJsBridgeConnection,
    ): Promise<Value>;
  }>;

async function withCurrentAcceptedTaskRuntimeAuthorityInternal<Value>(
  input: CurrentAcceptedTaskRuntimeAuthorityInput,
  authorityUse: CurrentAcceptedTaskRuntimeAuthorityUse<Value>,
): Promise<Value | null> {
  const descriptorBytes = Uint8Array.from(input.accepted.descriptorBytes);
  const authorizationBytes = Uint8Array.from(input.accepted.authorizationBytes);
  const issuerSigningPublicKeyHash = Uint8Array.from(
    input.accepted.issuerSigningPublicKeyHash,
  );
  const accepted = Object.freeze({
    ...input.accepted,
    descriptorBytes,
    authorizationBytes,
    issuerSigningPublicKeyHash,
    namespaceRequirements: copyNamespaceRequirements(
      input.accepted.namespaceRequirements,
    ),
    domainRequirements: copyDomainRequirements(
      input.accepted.domainRequirements,
    ),
  });
  const descriptorDigestBytes = input.crypto.hash(descriptorBytes);
  const descriptorDigest = hex(descriptorDigestBytes);
  descriptorDigestBytes.fill(0);
  const authorizationDigestBytes = input.crypto.hash(authorizationBytes);
  const authorizationDigest = hex(authorizationDigestBytes);
  authorizationDigestBytes.fill(0);
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
    descriptorBytes,
  );
  if (request === null) {
    descriptorBytes.fill(0);
    authorizationBytes.fill(0);
    issuerSigningPublicKeyHash.fill(0);
    throw new TypeError("Accepted Task Runtime descriptor is invalid");
  }
  const plan = parseDomainForegroundAuthorizationPlanV2(
    request.authorizationPlanBytes,
  );
  if (plan === null) {
    descriptorBytes.fill(0);
    authorizationBytes.fill(0);
    issuerSigningPublicKeyHash.fill(0);
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    throw new TypeError("Accepted Task Runtime plan is invalid");
  }
  const signed = parseDomainForegroundAuthorizationV2(authorizationBytes);
  if (signed === null) {
    descriptorBytes.fill(0);
    authorizationBytes.fill(0);
    issuerSigningPublicKeyHash.fill(0);
    destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    throw new TypeError("Accepted Task Runtime authorization is invalid");
  }
  const owned: Uint8Array[] = [];
  try {
    const namespaces = accepted.namespaceRequirements;
    const domainRequirements = accepted.domainRequirements;
    if (!requirementsAreCanonical(namespaces, domainRequirements)
      || !acceptedRecordMatchesRequest({
        accepted,
        request,
        plan,
        descriptorDigest,
        authorizationDigest,
      })
      || signed.authorizationId !== accepted.authorizationId
      || !sameBytes(signed.planBytes, request.authorizationPlanBytes)
      || issuerSigningPublicKeyHash.length !== 32) {
      throw new TypeError("Accepted Task Runtime record is inconsistent");
    }
    input.signal?.throwIfAborted();
    return await input.runner.transaction(async (tx, executor) => {
      const policy = await acquireEncryptionConsumptionFence(tx);
      if (policy.mode === "plaintext_only"
        || policy.revision !== plan.policyRevision
        || input.now() < request.issuedAt
        || input.now() >= request.deadlineAt
        || input.now() >= accepted.authorizationExpiresAt
        || namespaces.some((requirement) =>
          requirement.expectedPolicyRevision !== policy.revision)) return null;
      let parkedTask: ParkedTaskRuntimeLockedRoutingTask | undefined;
      if (authorityUse.kind === "parked") {
        const locked = await lockCurrentParkedTaskAdditionalAuthorityWithRouting({
          transaction: tx,
          expected: authorityUse.expected,
        });
        if (locked === null) return null;
        const facts = currentParkedTaskRuntimeRoutingFacts({
          sourceRoomId: request.sourceRoomId,
          targetRoomId: authorityUse.targetRoomId,
          task: locked.task,
          current: locked.current,
        });
        if (facts === null
          || !parkedTaskRuntimeScopeBindingMatches({
            task: locked.task,
            sourceRoomId: request.sourceRoomId,
            namespaceIds: namespaces.map(requirement =>
              requirement.namespaceId),
            scopeMemory: authorityUse.scopeMemory,
          })
          || !await authorityUse.validateCurrentRouting(facts)) return null;
        parkedTask = locked.task;
      }
      const product = inTransaction(executor);
      return new PostgresNamespaceProductAuthority(product)
        .withCurrentReadableNamespaceSet({
          subjectUserId: input.subject.userId,
          subjectHumanId: input.subject.humanActorId,
          sourceRoomId: request.sourceRoomId,
          namespaceIds: namespaces.map((requirement) =>
            requirement.namespaceId),
          use: async (entries) => {
            if (entries.length !== namespaces.length) return null;
            for (const [index, entry] of entries.entries()) {
              const requirement = namespaces[index];
              const current = inspectNamespaceProductAuthoritySnapshot(
                entry.authority,
              );
              try {
                if (requirement === undefined
                  || entry.namespaceId !== requirement.namespaceId
                  || current.accessRevision
                    !== requirement.expectedAccessRevision
                  || authorityUse.kind === "parked"
                    && !parkedTaskRuntimeNamespaceParticipantsMatch(
                      entry.namespaceId,
                      current.participantHumanIds,
                      authorityUse.expectedNamespaceParticipants,
                    )) return null;
              } finally {
                current.audienceFingerprint.fill(0);
              }
            }
            if (authorityUse.kind === "parked"
              && (parkedTask === undefined
                || !await exactCurrentParkedTaskScopeMemory({
                  product,
                  task: parkedTask,
                  sourceRoomId: request.sourceRoomId,
                  requesterHumanId: input.subject.humanActorId,
                  scopeMemory: authorityUse.scopeMemory,
                }))) return null;
            input.signal?.throwIfAborted();
            return input.restricted.transactionOnce(async (restrictedTx) => {
              const restricted = inTransaction(restrictedTx);
              const inspected = await new PostgresDomainKeyAuthorityRepository(
                restricted,
                input.crypto,
                input.serverScope,
              ).inspectForegroundAuthority({
                namespaceIds: namespaces.map((requirement) =>
                  requirement.namespaceId),
                keyClass: "ai",
                subjectHumanId: input.subject.humanActorId,
                deviceId: input.subject.deviceId,
              });
              if (inspected.status !== "ready") return null;
              for (const domain of inspected.domains) retainBytes(domain, owned);
              // The signed Task plan and accepted issuer bind group
              // securityRevision. The inspector reports a separate device-row
              // projection revision, so acquire its locks before reading the
              // current group authority and never compare the two counters.
              const device = await new PostgresDeviceAdmissionRepository(
                await verifyCryptoPostgresHandle(restricted),
                input.crypto,
              ).currentAuthorityForDelegation(input.subject);
              if (device === null) return null;
              retainBytes(device, owned);
              const signingPublicKeyHash = input.crypto.hash(
                device.signingPublicKey,
              );
              const exactAcceptedDevice =
                accepted.issuingHumanId === device.humanActorId
                && accepted.issuingDeviceId === device.deviceId
                && accepted.issuingDeviceAuthorizationRevision
                  === device.securityRevision
                && plan.committerDeviceSigningGeneration
                  === device.deviceGeneration
                && plan.hostAuthorizationRevision === device.securityRevision
                && sameBytes(
                  issuerSigningPublicKeyHash,
                  signingPublicKeyHash,
                );
              signingPublicKeyHash.fill(0);
              if (!exactAcceptedDevice
                || inspected.committerDeviceId !== device.deviceId
                || inspected.committerDeviceSigningGeneration
                  !== device.deviceGeneration
                || !matchesCurrentTaskRuntimeAuthorityWithoutAdmission({
                  request,
                  plan,
                  subject: input.subject,
                  device,
                  namespaces,
                  domainRequirements,
                  domains: inspected.domains,
                  policyRevision: policy.revision,
                  now: input.now(),
                })) return null;
              const verified = verifyDomainForegroundAuthorizationV2(
                input.crypto,
                {
                  authorizationBytes,
                  now: input.now(),
                  current: {
                    authorizationId: plan.authorizationId,
                    policyRevision: policy.revision,
                    sessionId: plan.sessionId,
                    roomId: plan.roomId,
                    subjectHumanId: plan.subjectHumanId,
                    committerDeviceId: plan.committerDeviceId,
                    committerDeviceSigningGeneration:
                      plan.committerDeviceSigningGeneration,
                    committerDeviceSigningPublicKey: device.signingPublicKey,
                    committerDeviceActive: true,
                    hostAuthorizationRevision: plan.hostAuthorizationRevision,
                    recipientKind: plan.recipientKind,
                    recipientPrincipalId: plan.recipientPrincipalId,
                    recipientAuthorizationRevision:
                      plan.recipientAuthorizationRevision,
                    recipientRuntimeGeneration:
                      plan.recipientRuntimeGeneration,
                    recipientKeyId: plan.recipientKeyId,
                    recipientAuthorized: true,
                    domains: inspected.domains,
                  },
                },
              );
              if (verified.status !== "verified") return null;
              input.signal?.throwIfAborted();
              const authority = Object.freeze({
                device,
                plan,
                domains: inspected.domains,
                namespaceRequirements: namespaces,
                policyRevision: policy.revision,
              });
              let result: Value;
              if (authorityUse.kind === "current") {
                result = await authorityUse.use(authority, product, restricted);
              } else {
                result = await withParkedTaskRuntimeRestrictedAuthority(
                  restricted,
                  scoped => authorityUse.use(authority, scoped),
                );
              }
              input.signal?.throwIfAborted();
              const finishedAt = input.now();
              if (finishedAt >= request.deadlineAt
                || finishedAt >= accepted.authorizationExpiresAt) {
                throw new Error(
                  "Accepted Task Runtime authority expired before commit",
                );
              }
              return result;
            }, { isolationLevel: "read committed" });
          },
        });
    }, { isolationLevel: "read committed" });
  } finally {
    owned.forEach((bytes) => bytes.fill(0));
    descriptorBytes.fill(0);
    authorizationBytes.fill(0);
    issuerSigningPublicKeyHash.fill(0);
    destroyDomainForegroundAuthorizationV2(signed);
    destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
  }
}

/**
 * Rechecks an already accepted Task V3 authorization under short canonical
 * locks. Unlike the device list/respond owner above, this execution owner uses
 * the durable accepted record and its signed authorization, never the original
 * HTTP admission or bearer.
 */
export async function withCurrentAcceptedTaskRuntimeAuthority<Value>(
  input: CurrentAcceptedTaskRuntimeAuthorityInput & Readonly<{
    use(
      authority: CurrentTaskRuntimeAuthority,
      product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection,
    ): Promise<Value>;
  }>,
): Promise<Value | null> {
  return withCurrentAcceptedTaskRuntimeAuthorityInternal(input, {
    kind: "current",
    use: (authority, product, restricted) => input.use(
      authority,
      product,
      restricted,
    ),
  });
}

/**
 * Rechecks accepted continuation authority while the exact parked Task, Run,
 * and prior Job remain locked. The callback receives only a lifetime-scoped
 * restricted connection for the grant mutation that completes this phase.
 */
export async function withCurrentAcceptedParkedTaskRuntimeAuthority<Value>(
  input: CurrentAcceptedTaskRuntimeAuthorityInput & Readonly<{
    expected: ParkedProtectedTaskAdditionalAuthority;
    targetRoomId: string;
    scopeMemory?: TaskScopeMemoryBinding;
    expectedNamespaceParticipants?: ParkedTaskRuntimeExpectedNamespaceParticipants;
    validateCurrentRouting(
      facts: ParkedTaskRuntimeCurrentRoutingFacts,
    ): boolean | Promise<boolean>;
    use(
      authority: CurrentTaskRuntimeAuthority,
      restricted: PostgresJsBridgeConnection,
    ): Promise<Value>;
  }>,
): Promise<Value | null> {
  const use = input.use;
  const validateCurrentRouting = input.validateCurrentRouting;
  const expected = copyParkedTaskRuntimeAuthority(input.expected);
  const subject = Object.freeze({ ...input.subject });
  const scopeMemory = input.scopeMemory === undefined
    ? undefined
    : copyTaskScopeMemoryBinding(input.scopeMemory);
  const suppliedNamespaceParticipants = input.expectedNamespaceParticipants;
  let expectedNamespaceParticipants:
    ParkedTaskRuntimeExpectedNamespaceParticipants | undefined;
  if (suppliedNamespaceParticipants !== undefined) {
    const copied = copyParkedTaskRuntimeExpectedNamespaceParticipants(
      suppliedNamespaceParticipants,
    );
    if (copied === null) return null;
    expectedNamespaceParticipants = copied;
  }
  const namespaceIds = input.accepted.namespaceRequirements.map(
    requirement => requirement.namespaceId,
  );
  if (typeof use !== "function" || typeof validateCurrentRouting !== "function"
    || expectedNamespaceParticipants?.some(value =>
      !namespaceIds.includes(value.namespaceId)) === true
    || input.accepted.requestId !== expected.authorizationRequestId
    || input.accepted.workId !== expected.occurrence.run.id
    || input.accepted.workKind !== "task.execute"
    || input.accepted.workPurpose !== "task.execute"
    || subject.userId !== expected.occurrence.task.requestorId
    || !input.accepted.namespaceRequirements.some(requirement =>
      requirement.namespaceId
        === expected.occurrence.task.contentNamespaceId)) return null;
  return withCurrentAcceptedTaskRuntimeAuthorityInternal(
    Object.freeze({ ...input, subject }), {
    kind: "parked",
    expected,
    targetRoomId: input.targetRoomId,
    ...(scopeMemory === undefined ? {} : { scopeMemory }),
    ...(expectedNamespaceParticipants === undefined
      ? {}
      : { expectedNamespaceParticipants }),
    validateCurrentRouting,
    use: (authority, restricted) => use(authority, restricted),
  });
}
