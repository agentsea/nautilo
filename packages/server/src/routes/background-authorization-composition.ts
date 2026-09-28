import {createPostgresJsBridgeConnection, getSharedDirectCryptoDb,
  type PostgresJsBridgeConnection} from "@nautilo/db";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1, inspectBackgroundAuthorizationResponseV2,
  verifyBackgroundAuthorizationResponseV2, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2, MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
  type BackgroundAuthorizationIssuerV2,
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
  use(request: NonNullable<ReturnType<typeof decodeTaskRuntimeBackgroundAuthorizationRequestV1>>,
    plan: DomainForegroundAuthorizationPlanV2,
    domains: DomainForegroundAuthorizationPlanV2["domains"],
    device: CurrentDeviceAdmissionAuthority,
    restricted: PostgresJsBridgeConnection): Promise<Value>;
}>) => Promise<Value | null>;

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

  const withTaskAuthority: WithCurrentTaskAuthority = dependencies.withTaskAuthority ?? (async input => {
    if (!(dependencies.isTaskRecipientActive?.(input.record) ?? false)) return null;
    const descriptorBytes = input.record.descriptorBytes;
    if (descriptorBytes === null) return null;
    const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(descriptorBytes);
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
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1),
      requestPageBytes: Math.max(MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1), maximumRequests: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
      responseBytes: Math.max(MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
        DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2), continuationCharacters: cursorCharacters},
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
      try {
        if (!matchesStenographerRequestAdmission(admission, device, now())) {
          throw new BackgroundAuthorizationDeviceServiceError("unauthorized");
        }
        const {canonicalRunner: runner} = await context(subject.userId);
        page = await (await repository(restricted)).listAwaitingDevicePage({now: startedAt,
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
      finally {destroyBytes(device); destroyBytes(issuer); destroyBytes(page);}
    },
    async respond(subject, input) {
      const admission = admitted(subject);
      const responseBytes = Uint8Array.from(input.responseBytes);
      const taskResponse = parseDomainForegroundAuthorizationV2(responseBytes);
      if (taskResponse !== null) {
        try {
          const restricted = connection();
          const record = await (await repository(restricted)).get(taskResponse.authorizationId);
          if (record === null || !isTaskRuntimeRecord(record)) return {status: "stale"};
          const accepted = await withTaskAuthority({subject, admission, restricted, record,
            use: async (request, plan, domains, currentDeviceAuthority, restrictedInTx) => {
              if (!sameBytes(taskResponse.planBytes, request.authorizationPlanBytes)) {
                throw new BackgroundAuthorizationDeviceServiceError("malformed");
              }
              const verified = verifyDomainForegroundAuthorizationV2(crypto, {
                authorizationBytes: responseBytes,
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
              const responseHash = crypto.hash(responseBytes);
              const descriptorHash = crypto.hash(record.descriptorBytes!);
              const issuerSigningPublicKeyHash = crypto.hash(currentDeviceAuthority.signingPublicKey);
              try {
                const result = await (await repository(restrictedInTx)).acceptVerifiedResponse({
                  response: {
                    formatVersion: 3,
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
                    authorizationHash: Uint8Array.from(responseHash),
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
                responseHash.fill(0);
                descriptorHash.fill(0);
                issuerSigningPublicKeyHash.fill(0);
              }
            }});
          if (accepted?.status === "accepted") dependencies.wakeProtectedTask?.();
          return accepted ?? {status: "stale"};
        } finally {
          destroyDomainForegroundAuthorizationV2(taskResponse);
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
