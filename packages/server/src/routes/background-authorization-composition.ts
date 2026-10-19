import {createPostgresJsBridgeConnection, getSharedDirectCryptoDb,
  type PostgresJsBridgeConnection} from "@nautilo/db";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  decodeTaskRuntimeBackgroundAuthorizationResponseV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyVerifiedTaskRuntimeSignerAuthorization,
  inspectBackgroundAuthorizationResponseV2,
  isTaskRuntimeBackgroundAuthorizationRequestV2Carrier,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier,
  verifyCurrentTaskRuntimeSignerAuthorization,
  verifyBackgroundAuthorizationResponseV2, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  type BackgroundAuthorizationIssuerV2,
  type TaskRuntimeBackgroundAuthorizationRequestV2,
  type TaskRuntimeBackgroundAuthorizationRequestV3,
  type AnyBackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {destroyDomainForegroundAuthorizationPlanV2, destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2, parseDomainForegroundAuthorizationV2,
  verifyDomainForegroundAuthorizationV2, DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
  type DomainForegroundAuthorizationPlanV2} from "@nautilo/lattice-crypto/wire";
import {PostgresDeviceAdmissionRepository, verifyCryptoPostgresHandle,
  withCurrentTaskRuntimeAuthority,
  withCurrentStenographerAuthority, withCurrentReflectionAuthority, validatePostgresReflectionAuthorityReprojection, validatePostgresReflectionAuthorityRecovery, validatePostgresReflectionSemanticRecovery, validatePostgresReflectionSemanticPlan, matchesStenographerRequestAdmission,
  type CurrentDeviceAdmissionAuthority, type StenographerRequestAdmission} from "@nautilo/lattice-bridge/server";
import {PostgresBackgroundAuthorizationRepository, BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES, BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
  type BackgroundAuthorizationRepository, type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3} from "@nautilo/runtime";
import {createHumanProductTransactionContext} from "./human-message-product-store";
import {BackgroundAuthorizationDeviceServiceError,
  type BackgroundAuthorizationDeviceSubject, type BackgroundAuthorizationDeviceService} from "./background-authorization";

interface Cursor {readonly v: 1; readonly through: number; readonly updated: number; readonly id: string}
// Fixed JSON fields, maximum durable timestamp widths and portable ASCII ID.
const cursorJsonMaximum = JSON.stringify({v: 1, through: BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
  updated: BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS, id: ""}).length + BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES;
const cursorCharacters = Math.ceil(cursorJsonMaximum * 4 / 3);
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function decodeCursor(value: string, now: number): Cursor {
  try {
    if (value.length > cursorCharacters || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (cursor === null || cursor.v !== 1 || !Number.isSafeInteger(cursor.through) || cursor.through > now
      || cursor.through < 0 || !Number.isSafeInteger(cursor.updated) || cursor.updated < 0
      || cursor.updated > cursor.through || typeof cursor.id !== "string"
      || cursor.id.length > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(cursor.id)
      || encodeCursor({v: 1, through: cursor.through, updated: cursor.updated, id: cursor.id}) !== value) throw new Error();
    return cursor;
  } catch { throw new BackgroundAuthorizationDeviceServiceError("malformed"); }
}
function destroyBytes(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {value.fill(0); return;}
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const field of Object.values(value)) destroyBytes(field, seen);
}
function issuerFromDevice(crypto: LatticeCrypto, device: CurrentDeviceAdmissionAuthority): BackgroundAuthorizationIssuerV2 {
  return {humanId: device.humanActorId, deviceId: device.deviceId, deviceGeneration: device.deviceGeneration,
    serverInstanceId: device.serverInstanceId, lineageGeneration: device.lineageGeneration,
    epoch: device.epoch, securityRevision: device.securityRevision,
    headDigest: Uint8Array.from(device.headDigest), signingPublicKeyHash: crypto.hash(device.signingPublicKey)};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameTaskRuntimeIssuer(
  left: BackgroundAuthorizationIssuerV2,
  right: BackgroundAuthorizationIssuerV2,
): boolean {
  return left.humanId === right.humanId
    && left.deviceId === right.deviceId
    && left.deviceGeneration === right.deviceGeneration
    && left.serverInstanceId === right.serverInstanceId
    && left.lineageGeneration === right.lineageGeneration
    && left.epoch === right.epoch
    && left.securityRevision === right.securityRevision
    && sameBytes(left.headDigest, right.headDigest)
    && sameBytes(left.signingPublicKeyHash, right.signingPublicKeyHash);
}

function exactCertifiedTaskRuntimeRequest(
  request: TaskRuntimeBackgroundAuthorizationRequestV2
    | TaskRuntimeBackgroundAuthorizationRequestV3,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const expected = record.authoritySet.namespaceRequirements;
  const exactWork = request.formatVersion === 2
    ? request.work.taskRunId === record.snapshot.workId
    : request.work.kind === record.workKind
      && request.work.kind === record.purpose
      && (request.work.kind === "task.delivery_wake"
        ? request.work.jobId === record.snapshot.workId
        : request.work.taskRunId === record.snapshot.workId);
  return exactWork
    && sameBytes(request.work.workIdentityHash, record.workIdentityHash)
    && request.namespaceRequirements.length === expected.length
    && request.namespaceRequirements.every((actual, index) => {
      const requirement = expected[index];
      return requirement !== undefined
        && actual.ordinal === requirement.ordinal
        && actual.namespaceId === requirement.namespaceId
        && actual.domainId === requirement.domainId
        && actual.expectedAccessRevision === requirement.expectedAccessRevision
        && actual.expectedPolicyRevision === requirement.expectedPolicyRevision
        && actual.operations.length === requirement.operations.length
        && actual.operations.every((operation, operationIndex) =>
          operation === requirement.operations[operationIndex]);
    });
}

function isTaskRuntimeRecord(record: BackgroundAuthorizationRecord):
  record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.descriptorBytes !== null;
}

type WithCurrentTaskAuthority = <Value>(input: Readonly<{
  subject: BackgroundAuthorizationDeviceSubject;
  admission: StenographerRequestAdmission;
  restricted: PostgresJsBridgeConnection;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  use(request: NonNullable<ReturnType<typeof decodeTaskRuntimeBackgroundAuthorizationRequestBase>>,
    plan: DomainForegroundAuthorizationPlanV2,
    domains: DomainForegroundAuthorizationPlanV2["domains"],
    device: CurrentDeviceAdmissionAuthority,
    restricted: PostgresJsBridgeConnection): Promise<Value>;
}>) => Promise<Value | null>;

type BindTaskRecipient = (input: Readonly<{
  subject: BackgroundAuthorizationDeviceSubject;
  admission: StenographerRequestAdmission;
  device: CurrentDeviceAdmissionAuthority;
  restricted: PostgresJsBridgeConnection;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
}>) => Promise<Readonly<{
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  requestBytes: Uint8Array;
}> | null>;

type AwaitingCursor = Readonly<{updatedAt: number; requestId: string}>;
function compareAwaitingCursor(left: AwaitingCursor, right: AwaitingCursor): number {
  return left.updatedAt - right.updatedAt || left.requestId.localeCompare(right.requestId);
}
function recordCursor(record: BackgroundAuthorizationRecord): AwaitingCursor {
  return {updatedAt: record.snapshot.updatedAt, requestId: record.snapshot.requestId};
}

/** Metadata transport composition. All Room, policy, key-authority and acceptance
 * checks enter Lattice's existing authority owners; no plaintext enters these routes.
 */
export function createProductionBackgroundAuthorizationComposition(dependencies: Partial<{
  crypto: LatticeCrypto;
  serverScope: string;
  now(): number;
  context: typeof createHumanProductTransactionContext;
  restricted(): PostgresJsBridgeConnection;
  repository(connection: PostgresJsBridgeConnection): Promise<BackgroundAuthorizationRepository>;
  withAuthority: typeof withCurrentStenographerAuthority;
  withReflectionAuthority: typeof withCurrentReflectionAuthority;
  currentDevice(connection: PostgresJsBridgeConnection, subject: BackgroundAuthorizationDeviceSubject): Promise<CurrentDeviceAdmissionAuthority | null>;
  /** Process-local custody proof; absent until the Task Runtime owns a live recipient. */
  isTaskRecipientActive(record: BackgroundAuthorizationTaskRuntimeRecordV3): boolean;
  withTaskAuthority: WithCurrentTaskAuthority;
  bindTaskRecipient: BindTaskRecipient;
  wakeProtectedTask(): void;
}> = {}): BackgroundAuthorizationDeviceService {
  const crypto = dependencies.crypto ?? new LatticeCrypto();
  const now = dependencies.now ?? Date.now;
  const serverScope = dependencies.serverScope ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001");
  const context = dependencies.context ?? createHumanProductTransactionContext;
  const connection = dependencies.restricted ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const repository = dependencies.repository ?? (async restricted =>
    new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(restricted)));
  const withAuthority = dependencies.withAuthority ?? withCurrentStenographerAuthority;
  const reflectionAuthority = dependencies.withReflectionAuthority ?? withCurrentReflectionAuthority;
  const withProcessorAuthority = async <Value>(operation: Omit<Parameters<typeof withCurrentStenographerAuthority<Value>>[0], "descriptor" | "use"> & Readonly<{
    descriptor: AnyBackgroundProcessorWorkDescriptorV2;
    use(authority: Readonly<{device: CurrentDeviceAdmissionAuthority}>, product: PostgresJsBridgeConnection, restricted: PostgresJsBridgeConnection): Promise<Value>;
  }>): Promise<Value | null> => {
    if ("authority" in operation.descriptor) return withAuthority({...operation, descriptor: operation.descriptor});
    const descriptor = operation.descriptor;
    return reflectionAuthority({...operation, descriptor,
      validateProduct: async product => descriptor.workKind === "reflection.publication_reconcile"
        ? await validatePostgresReflectionAuthorityRecovery({product, restricted: operation.restricted, crypto, descriptorB: descriptor})
          || await validatePostgresReflectionSemanticRecovery({product, restricted: operation.restricted, crypto, descriptorB: descriptor})
        : descriptor.source.kind === "reflection_semantic"
          ? validatePostgresReflectionSemanticPlan({product, restricted: operation.restricted, crypto, descriptor})
          : validatePostgresReflectionAuthorityReprojection({product, restricted: operation.restricted, crypto, descriptor})});
  };
  const currentDevice = dependencies.currentDevice ?? (async (restricted, subject) =>
    new PostgresDeviceAdmissionRepository(await verifyCryptoPostgresHandle(restricted), crypto)
      .currentAuthorityForDelegation(subject));
  const admitted = (subject: BackgroundAuthorizationDeviceSubject) => {
    if (subject.deviceId !== subject.admission.deviceId || subject.admission.expiresAt <= now()) {
      throw new BackgroundAuthorizationDeviceServiceError("unauthorized");
    }
    return {...subject.admission, userId: subject.userId, humanActorId: subject.humanActorId};
  };
  const bindTaskRecipient = dependencies.bindTaskRecipient;

  const withTaskAuthority: WithCurrentTaskAuthority = dependencies.withTaskAuthority ?? (async input => {
    if (!(dependencies.isTaskRecipientActive?.(input.record) ?? false)) return null;
    const descriptorBytes = input.record.descriptorBytes;
    if (descriptorBytes === null) return null;
    const request = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
      crypto,
      descriptorBytes,
    );
    if (request === null) return null;
    const plan = parseDomainForegroundAuthorizationPlanV2(request.authorizationPlanBytes);
    if (plan === null) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
      return null;
    }
    try {
      const snapshot = input.record.snapshot;
      const namespaces = input.record.authoritySet.namespaceRequirements;
      const domainRequirements = input.record.authoritySet.domainRequirements;
      if (now() < request.issuedAt
        || now() >= request.deadlineAt
        || input.record.expectedPolicyRevision !== plan.policyRevision
        || request.requestId !== snapshot.requestId
        || request.workId !== snapshot.workId
        || request.recipientGeneration !== snapshot.recipientGeneration
        || request.workKind !== input.record.workKind
        || request.workPurpose !== input.record.purpose
        || request.sourceRoomId !== plan.roomId
        || plan.subjectHumanId !== input.subject.humanActorId
        || plan.committerDeviceId !== input.subject.deviceId
        || plan.recipientAuthorizationRevision !== 0
        || plan.operations.length !== 2
        || plan.operations[0] !== "decrypt"
        || plan.operations[1] !== "encrypt"
        || namespaces.some((entry) => entry.expectedPolicyRevision !== plan.policyRevision
          || entry.operations.some((operation) => !plan.operations.includes(operation)))
        || snapshot.recipient?.recipientKeyId !== request.recipientKeyId
        || snapshot.recipient.recipientPublicKey !== Buffer.from(request.recipientPublicKey).toString("base64url")
        || snapshot.recipient.expiresAt !== request.deadlineAt
        || namespaces.length < 1
        || domainRequirements.length !== plan.domains.length) return null;
      const {canonicalRunner: runner} = await context(input.subject.userId);
      return await withCurrentTaskRuntimeAuthority({
        runner,
        restricted: input.restricted,
        crypto,
        serverScope,
        subject: input.subject,
        admission: input.admission,
        request,
        namespaceRequirements: namespaces,
        domainRequirements,
        now,
        use: async (authority, _product, restricted) => input.use(
          request, authority.plan, authority.domains, authority.device, restricted,
        ),
      });
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(plan);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    }
  });

  return {
    limits: {requestBytes: Math.max(MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3),
      requestPageBytes: Math.max(MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3), maximumRequests: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
      responseBytes: Math.max(MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
        DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2), continuationCharacters: cursorCharacters},
    async list(subject, input) {
      const admission = admitted(subject);
      const startedAt = now();
      const cursor = input.continuation === undefined ? undefined : decodeCursor(input.continuation, startedAt);
      const restricted = connection();
      const device = await currentDevice(restricted, subject);
      if (device === null) throw new BackgroundAuthorizationDeviceServiceError("unauthorized");
      const issuer = issuerFromDevice(crypto, device);
      const requests: {requestBytes: Uint8Array}[] = [];
      let page: Awaited<ReturnType<BackgroundAuthorizationRepository["listAwaitingDevicePage"]>> | undefined;
      let taskPage: Awaited<ReturnType<NonNullable<BackgroundAuthorizationRepository["listAwaitingTaskRuntimeRecipientPage"]>>> | undefined;
      try {
        if (!matchesStenographerRequestAdmission(admission, device, now())) {
          throw new BackgroundAuthorizationDeviceServiceError("unauthorized");
        }
        const {canonicalRunner: runner} = await context(subject.userId);
        const store = await repository(restricted);
        if (bindTaskRecipient !== undefined && store.listAwaitingTaskRuntimeRecipientPage !== undefined) {
          const pageInput = {now: startedAt,
            throughUpdatedAt: cursor?.through ?? startedAt, limit: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
            ...(cursor === undefined ? {} : {after: {updatedAt: cursor.updated, requestId: cursor.id}})};
          page = await store.listAwaitingDevicePage(pageInput);
          taskPage = await store.listAwaitingTaskRuntimeRecipientPage(pageInput);
          const continuations = [page.continuation, taskPage.continuation]
            .filter((entry): entry is AwaitingCursor => entry !== null && entry !== undefined)
            .sort(compareAwaitingCursor);
          const frontier = continuations[0] ?? null;
          const candidates: Array<Readonly<{
            source: "device" | "recipient";
            record: BackgroundAuthorizationRecord | BackgroundAuthorizationTaskRuntimeRecordV3;
          }>> = [
            ...page.records.map(record => ({source: "device" as const, record})),
            ...taskPage.records.map(record => ({source: "recipient" as const, record})),
          ].sort((left, right) => compareAwaitingCursor(recordCursor(left.record), recordCursor(right.record)));
          const seen = new Set<string>();
          let lastProcessed: AwaitingCursor | null = null;
          let stopped = false;
          let totalRequestBytes = 0;
          const maximumPageBytes = Math.max(MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
            MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
            MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2,
            MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3);
          for (const candidate of candidates) {
            const coordinate = recordCursor(candidate.record);
            if (frontier !== null && compareAwaitingCursor(coordinate, frontier) > 0) break;
            if (seen.has(coordinate.requestId)) continue;
            seen.add(coordinate.requestId);
            let requestBytes: Uint8Array | null = null;
            let bound: Awaited<ReturnType<BindTaskRecipient>> = null;
            try {
              if (candidate.source === "recipient") {
                bound = await bindTaskRecipient({subject, admission, device, restricted,
                  record: candidate.record as BackgroundAuthorizationTaskRuntimeRecordV3});
                if (bound !== null) {
                  const permitted = await withTaskAuthority({subject, admission, restricted, record: bound.record,
                    use: () => Promise.resolve(true)});
                  if (permitted === true) requestBytes = bound.requestBytes;
                }
              } else {
                const record = candidate.record;
                if (isTaskRuntimeRecord(record)) {
                  const permitted = await withTaskAuthority({subject, admission, restricted, record,
                    use: () => Promise.resolve(true)});
                  if (permitted === true) requestBytes = record.descriptorBytes;
                } else if (record.snapshot.formatVersion === 2
                  && record.snapshot.credentialSubject.kind === "processor"
                  && record.descriptorBytes !== null) {
                  let descriptor: AnyBackgroundProcessorWorkDescriptorV2;
                  try {descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);}
                  catch {lastProcessed = coordinate; continue;}
                  try {
                    const allowed = await withProcessorAuthority({runner, restricted, crypto, serverScope, descriptor, issuer,
                      admission, now, use: () => Promise.resolve(true)});
                    if (allowed === true) requestBytes = record.descriptorBytes;
                  } finally {destroyBytes(descriptor);}
                }
              }
              if (requestBytes !== null) {
                if (requestBytes.length > maximumPageBytes) {
                  throw new BackgroundAuthorizationDeviceServiceError("malformed");
                }
                if (requests.length >= BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH
                  || totalRequestBytes + requestBytes.length > maximumPageBytes) {
                  stopped = true;
                  break;
                }
                requests.push({requestBytes: Uint8Array.from(requestBytes)});
                totalRequestBytes += requestBytes.length;
              }
              lastProcessed = coordinate;
            } finally {destroyBytes(bound);}
          }
          admitted(subject);
          const continuation = stopped ? lastProcessed : frontier;
          return {requests, ...(continuation === null ? {} : {continuation: encodeCursor({v: 1,
            through: cursor?.through ?? startedAt, updated: continuation.updatedAt, id: continuation.requestId})})};
        }
        page = await store.listAwaitingDevicePage({now: startedAt,
          throughUpdatedAt: cursor?.through ?? startedAt, limit: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
          ...(cursor === undefined ? {} : {after: {updatedAt: cursor.updated, requestId: cursor.id}})});
        for (const record of page.records) {
          // Earlier protocols are intentionally unmounted. Their private fixtures
          // cannot become current device requests by sharing the durable queue.
          if (isTaskRuntimeRecord(record)) {
            const permitted = await withTaskAuthority({subject, admission, restricted, record,
              use: () => Promise.resolve(true)});
            if (permitted === true) {
              requests.push({requestBytes: Uint8Array.from(record.descriptorBytes!)});
            }
            continue;
          }
          if (record.snapshot.formatVersion !== 2
            || record.snapshot.credentialSubject.kind !== "processor"
            || record.descriptorBytes === null) {
            continue;
          }
          let descriptor: AnyBackgroundProcessorWorkDescriptorV2;
          try {descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);}
          catch {continue;}
          try {
            const allowed = await withProcessorAuthority({runner, restricted, crypto, serverScope, descriptor, issuer,
              admission, now, use: () => Promise.resolve(true)});
            if (allowed === true) {
              requests.push({requestBytes: Uint8Array.from(record.descriptorBytes)});
            }
          } finally {destroyBytes(descriptor);}
        }
        admitted(subject);
        const continuation = page.continuation;
        return {requests, ...(continuation === null || continuation === undefined ? {} : {continuation: encodeCursor({v: 1,
          through: cursor?.through ?? startedAt, updated: continuation.updatedAt, id: continuation.requestId})})};
      } catch (error) {destroyBytes(requests); throw error;}
      finally {destroyBytes(device); destroyBytes(issuer); destroyBytes(page); destroyBytes(taskPage);}
    },
    async respond(subject, input) {
      const admission = admitted(subject);
      const responseBytes = Uint8Array.from(input.responseBytes);
      let taskWrapper: Readonly<{
        authorizationBytes: Uint8Array;
        certificateBytes: Uint8Array;
      }> | null = null;
      try {
        taskWrapper = decodeTaskRuntimeBackgroundAuthorizationResponseV2(
          responseBytes,
        );
      } catch {
        taskWrapper = null;
      }
      const taskAuthorizationBytes = taskWrapper?.authorizationBytes
        ?? responseBytes;
      const taskResponse = parseDomainForegroundAuthorizationV2(
        taskAuthorizationBytes,
      );
      if (taskWrapper !== null && taskResponse === null) {
        taskWrapper.authorizationBytes.fill(0);
        taskWrapper.certificateBytes.fill(0);
        responseBytes.fill(0);
        throw new BackgroundAuthorizationDeviceServiceError("malformed");
      }
      if (taskResponse !== null) {
        try {
          const restricted = connection();
          const record = await (await repository(restricted)).get(taskResponse.authorizationId);
          if (record === null || !isTaskRuntimeRecord(record)) return {status: "stale"};
          const accepted = await withTaskAuthority({subject, admission, restricted, record,
            use: async (request, plan, domains, currentDeviceAuthority, restrictedInTx) => {
              const certified = isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(record.descriptorBytes!)
                || isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(record.descriptorBytes!);
              if ((taskWrapper !== null) !== certified
                || !sameBytes(taskResponse.planBytes, request.authorizationPlanBytes)) {
                throw new BackgroundAuthorizationDeviceServiceError("malformed");
              }
              const verified = verifyDomainForegroundAuthorizationV2(crypto, {
                ...(["task.cancel_result", "task.deliver_message"].includes(request.workKind)
                  && request.workPurpose === request.workKind
                  ? { expectedOperations: ["encrypt"] as const } : {}),
                authorizationBytes: taskAuthorizationBytes,
                now: now(),
                current: {
                  authorizationId: plan.authorizationId,
                  policyRevision: plan.policyRevision,
                  sessionId: plan.sessionId,
                  roomId: plan.roomId,
                  subjectHumanId: plan.subjectHumanId,
                  committerDeviceId: plan.committerDeviceId,
                  committerDeviceSigningGeneration: plan.committerDeviceSigningGeneration,
                  committerDeviceSigningPublicKey: currentDeviceAuthority.signingPublicKey,
                  committerDeviceActive: true,
                  hostAuthorizationRevision: plan.hostAuthorizationRevision,
                  recipientKind: plan.recipientKind,
                  recipientPrincipalId: plan.recipientPrincipalId,
                  recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
                  recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
                  recipientKeyId: plan.recipientKeyId,
                  recipientAuthorized: true,
                  domains,
                },
              });
              if (verified.status !== "verified") {
                if (verified.reason === "invalid") {
                  throw new BackgroundAuthorizationDeviceServiceError("malformed");
                }
                return {status: "stale" as const};
              }
              const descriptorHash = crypto.hash(record.descriptorBytes!);
              const responseHash = crypto.hash(responseBytes);
              const authorizationHash = crypto.hash(taskAuthorizationBytes);
              const issuerSigningPublicKeyHash = crypto.hash(currentDeviceAuthority.signingPublicKey);
              const currentIssuer = issuerFromDevice(crypto, currentDeviceAuthority);
              let signerAuthorization: Awaited<ReturnType<
                typeof verifyCurrentTaskRuntimeSignerAuthorization
              >> | undefined;
              try {
                if (taskWrapper !== null) {
                  try {
                    signerAuthorization =
                      await verifyCurrentTaskRuntimeSignerAuthorization(
                        crypto,
                        {
                          certificateBytes: taskWrapper.certificateBytes,
                          requestBytes: record.descriptorBytes!,
                          expectedRequestHash: descriptorHash,
                          expectedAuthorizationHash: authorizationHash,
                          now: now(),
                          resolveCurrentIssuer: context =>
                            sameTaskRuntimeIssuer(context.issuer, currentIssuer)
                              ? currentDeviceAuthority.signingPublicKey
                              : null,
                        },
                      );
                  } catch {
                    throw new BackgroundAuthorizationDeviceServiceError(
                      "malformed",
                    );
                  }
                  const base = signerAuthorization.request.baseRequest;
                  if (!sameTaskRuntimeIssuer(
                      signerAuthorization.issuer,
                      currentIssuer,
                    )
                    || !exactCertifiedTaskRuntimeRequest(
                      signerAuthorization.request,
                      record,
                    )
                    || base.requestId !== request.requestId
                    || base.workId !== request.workId
                    || base.workKind !== request.workKind
                    || base.workPurpose !== request.workPurpose
                    || base.recipientGeneration !== request.recipientGeneration
                    || base.recipientKeyId !== request.recipientKeyId
                    || !sameBytes(base.recipientPublicKey, request.recipientPublicKey)
                    || !sameBytes(
                      base.authorizationPlanBytes,
                      request.authorizationPlanBytes,
                    )
                    || base.issuedAt !== request.issuedAt
                    || base.deadlineAt !== request.deadlineAt) {
                    throw new BackgroundAuthorizationDeviceServiceError(
                      "malformed",
                    );
                  }
                }
                const result = await (await repository(restrictedInTx)).acceptVerifiedResponse({
                  response: taskWrapper === null ? {
                    formatVersion: 3 as const,
                    kind: "runtime",
                    requestId: request.requestId,
                    descriptorHash,
                    descriptorBytes: Uint8Array.from(record.descriptorBytes!),
                    recipientGeneration: request.recipientGeneration,
                    recipientKeyId: request.recipientKeyId,
                    recipientPublicKey: Uint8Array.from(request.recipientPublicKey),
                    workId: request.workId,
                    workKind: request.workKind,
                    purpose: request.workPurpose,
                    authoritySet: record.authoritySet,
                    responseBytes: Uint8Array.from(responseBytes),
                    responseHash,
                    authorizationId: taskResponse.authorizationId,
                    authorizationHash: Uint8Array.from(authorizationHash),
                    issuingHumanId: subject.humanActorId,
                    issuingDeviceId: currentDeviceAuthority.deviceId,
                    issuingDeviceAuthorizationRevision: currentDeviceAuthority.securityRevision,
                    issuerSigningPublicKeyHash,
                    issuedAt: plan.issuedAt,
                    expiresAt: plan.deadlineAt,
                  } : {
                    formatVersion: 4 as const,
                    kind: "runtime" as const,
                    requestId: request.requestId,
                    descriptorHash,
                    descriptorBytes: Uint8Array.from(record.descriptorBytes!),
                    recipientGeneration: request.recipientGeneration,
                    recipientKeyId: request.recipientKeyId,
                    recipientPublicKey: Uint8Array.from(request.recipientPublicKey),
                    workId: request.workId,
                    workKind: request.workKind,
                    purpose: request.workPurpose,
                    authoritySet: record.authoritySet,
                    responseBytes: Uint8Array.from(responseBytes),
                    responseHash,
                    authorizationId: taskResponse.authorizationId,
                    authorizationHash: Uint8Array.from(authorizationHash),
                    authorizationBytes: Uint8Array.from(taskAuthorizationBytes),
                    certificateBytes: Uint8Array.from(taskWrapper.certificateBytes),
                    issuingHumanId: subject.humanActorId,
                    issuingDeviceId: currentDeviceAuthority.deviceId,
                    issuingDeviceAuthorizationRevision: currentDeviceAuthority.securityRevision,
                    issuerSigningPublicKeyHash,
                    issuedAt: plan.issuedAt,
                    expiresAt: plan.deadlineAt,
                  }, acceptedAt: now(),
                });
                return {status: result.status === "lost" ? "stale" as const : result.status};
              } finally {
                if (signerAuthorization !== undefined) {
                  destroyVerifiedTaskRuntimeSignerAuthorization(
                    signerAuthorization,
                  );
                }
                responseHash.fill(0);
                authorizationHash.fill(0);
                descriptorHash.fill(0);
                issuerSigningPublicKeyHash.fill(0);
                destroyBytes(currentIssuer);
              }
            }});
          if (accepted?.status === "accepted") dependencies.wakeProtectedTask?.();
          return accepted ?? {status: "stale"};
        } finally {
          destroyDomainForegroundAuthorizationV2(taskResponse);
          taskWrapper?.authorizationBytes.fill(0);
          taskWrapper?.certificateBytes.fill(0);
          responseBytes.fill(0);
        }
      }
      let inspected: ReturnType<typeof inspectBackgroundAuthorizationResponseV2>;
      try {inspected = inspectBackgroundAuthorizationResponseV2(responseBytes);}
      catch {responseBytes.fill(0); throw new BackgroundAuthorizationDeviceServiceError("malformed");}
      try {
        if (inspected.issuer.humanId !== subject.humanActorId || inspected.issuer.deviceId !== subject.deviceId) {
          throw new BackgroundAuthorizationDeviceServiceError("unauthorized");
        }
        const {canonicalRunner: runner} = await context(subject.userId);
        const result = await withProcessorAuthority({runner, restricted: connection(), crypto, serverScope,
          descriptor: inspected.descriptor, issuer: inspected.issuer, admission, now,
          use: async (authority, _product, restricted) => {
            const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {responseBytes, now: now(),
              resolveCurrentIssuer: () => authority.device.signingPublicKey}).catch(() => {
                throw new BackgroundAuthorizationDeviceServiceError("malformed");
              });
            try {
              const accepted = await (await repository(restricted)).acceptVerifiedResponse({
                response: {...verified, formatVersion: 2, kind: "processor"}, acceptedAt: now(),
              });
              return {status: accepted.status === "lost" ? "stale" as const : accepted.status};
            } finally {destroyBytes(verified);}
          }});
        return result ?? {status: "stale"};
      } finally {destroyBytes(inspected); responseBytes.fill(0);}
    },
  };
}
