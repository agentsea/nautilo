import {createPostgresJsBridgeConnection, getSharedDirectCryptoDb,
  type PostgresJsBridgeConnection} from "@nautilo/db";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, inspectBackgroundAuthorizationResponseV2,
  verifyBackgroundAuthorizationResponseV2, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2, type BackgroundAuthorizationIssuerV2,
  type AnyBackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {PostgresDeviceAdmissionRepository, verifyCryptoPostgresHandle,
  withCurrentStenographerAuthority, withCurrentReflectionAuthority, validatePostgresReflectionAuthorityReprojection, validatePostgresReflectionAuthorityRecovery, validatePostgresReflectionSemanticRecovery, validatePostgresReflectionSemanticPlan, matchesStenographerRequestAdmission,
  type CurrentDeviceAdmissionAuthority} from "@nautilo/lattice-bridge/server";
import {PostgresBackgroundAuthorizationRepository, BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES, BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
  type BackgroundAuthorizationRepository} from "@nautilo/runtime";
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

  return {
    limits: {requestBytes: MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
      requestPageBytes: MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2, maximumRequests: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
      responseBytes: MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2, continuationCharacters: cursorCharacters},
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
        if (page.records.reduce((total, record) => total + (record.descriptorBytes?.length ?? 0), 0)
          > MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2) {
          throw new BackgroundAuthorizationDeviceServiceError("malformed");
        }
        for (const record of page.records) {
          // Earlier protocols are intentionally unmounted. Their private fixtures
          // cannot become current device requests by sharing the durable queue.
          if (record.snapshot.formatVersion !== 2
            || record.snapshot.credentialSubject.kind !== "processor"
            || record.descriptorBytes === null) continue;
          let descriptor: AnyBackgroundProcessorWorkDescriptorV2;
          try {descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);}
          catch {continue;}
          try {
            const allowed = await withProcessorAuthority({runner, restricted, crypto, serverScope, descriptor, issuer,
              admission, now, use: () => Promise.resolve(true)});
            if (allowed === true) requests.push({requestBytes: Uint8Array.from(record.descriptorBytes)});
          } finally {destroyBytes(descriptor);}
        }
        admitted(subject);
        return {requests, ...(page.continuation === null ? {} : {continuation: encodeCursor({v: 1,
          through: cursor?.through ?? startedAt, updated: page.continuation.updatedAt, id: page.continuation.requestId})})};
      } catch (error) {destroyBytes(requests); throw error;}
      finally {destroyBytes(device); destroyBytes(issuer); destroyBytes(page);}
    },
    async respond(subject, input) {
      const admission = admitted(subject);
      const responseBytes = Uint8Array.from(input.responseBytes);
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
