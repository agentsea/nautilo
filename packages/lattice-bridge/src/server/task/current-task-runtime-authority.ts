import {
  acquireEncryptionConsumptionFence,
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
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
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
  policyRevision: number;
}>;

export type TaskRuntimeAuthoritySubject = Readonly<{
  userId: string;
  humanActorId: string;
  deviceId: string;
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
    ...requirement,
    operations: Object.freeze([...requirement.operations]),
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
    || requirement.operations.length !== 2
    || requirement.operations[0] !== "decrypt"
    || requirement.operations[1] !== "encrypt"
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
  const {
    request,
    plan,
    subject,
    admission,
    device,
    namespaces,
    domainRequirements,
    domains,
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
    })
    && matchesStenographerRequestAdmission(admission, device, input.now);
}

function retainBytes(value: object, owned: Uint8Array[]): void {
  for (const field of Object.values(value)) {
    if (field instanceof Uint8Array) owned.push(field);
  }
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
              const device = await new PostgresDeviceAdmissionRepository(
                await verifyCryptoPostgresHandle(restricted),
                input.crypto,
              ).currentAuthorityForDelegation(input.subject);
              if (device === null) return null;
              retainBytes(device, owned);
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
              if (inspected.committerDeviceId !== device.deviceId
                || inspected.committerDeviceSigningGeneration
                  !== device.deviceGeneration
                || inspected.hostAuthorizationRevision
                  !== device.securityRevision
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
