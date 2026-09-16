/// <reference lib="dom" />

import { createBrowserPendingInitialDeviceBootstrapVault } from
  "../../src/client/browser/index.ts";
import { destroyPendingInitialDeviceBootstrap, type PendingInitialDeviceBootstrap } from
  "../../src/device/restart-safe-initial-device-client-ceremony.ts";
import { nautiloActorId, nautiloUserId } from
  "../../src/identity/product-ids.ts";

const DATABASE_NAME = "nautilo-pending-initial-device-bootstrap-v1";
const KEY_STORE = "wrapping_keys";
const RECORD_STORE = "pending_records";

function pending(revision: 1 | 2): PendingInitialDeviceBootstrap {
  const user = nautiloUserId("00000000-0000-4000-8000-000000000081");
  const human = nautiloActorId("00000000-0000-4000-8000-000000000082");
  if (!user.ok || !human.ok) throw new Error("invalid Browser fixture identity");
  const request = Object.freeze({
    userId: user.value,
    humanActorId: human.value,
    deviceId: "device:browser:pending",
    clientKind: "browser" as const,
    installationLineageDigest: new Uint8Array(32).fill(0x51),
    signingPublicKey: new Uint8Array(32).fill(0x52),
    encryptionPublicKey: new Uint8Array(65).fill(0x53),
    recoveryKeyId: "recovery:browser:pending",
    recoveryPublicKey: new Uint8Array(65).fill(0x54),
    context: Object.freeze({
      kind: "preparation" as const,
      authorityId: "bootstrap:browser:pending",
    }),
    idempotencyKey: "bootstrap:browser:pending",
  });
  return Object.freeze({
    formatVersion: 1,
    revision,
    idempotencyKey: request.idempotencyKey,
    coordinates: Object.freeze({
      serverScope: location.origin,
      userId: user.value,
      humanActorId: human.value,
      profileId: "profile:browser:pending",
      deviceId: request.deviceId,
      installationLineageDigest: "51".repeat(32),
    }),
    request,
    profileBytes: new TextEncoder().encode("pending-browser-secret-profile"),
    recoveryArchiveBytes: new TextEncoder().encode(
      "pending-browser-secret-recovery",
    ),
    publicFingerprint: new Uint8Array(32).fill(0x55),
    challenge: revision === 1 ? null : Object.freeze({
      ...request,
      formatVersion: 1 as const,
      challengeId: "challenge:browser:pending",
      authorizationEvidenceDigest: new Uint8Array(32).fill(0x56),
      authorizationDigest: new Uint8Array(32).fill(0x57),
      issuedAt: 100,
      expiresAt: 200,
    }),
    deviceProof: revision === 1 ? null : new Uint8Array(64).fill(0x58),
  });
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("pending Browser IndexedDB request failed"),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("pending Browser transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("pending Browser transaction aborted"),
    );
  });
}

async function database(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, 1);
  return requestResult(request);
}

async function rawRecord<Result>(
  database: IDBDatabase,
  store: string,
  key: string,
): Promise<Result> {
  const transaction = database.transaction(store, "readonly");
  const done = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore(store).get(key)) as Result;
  await done;
  return value;
}

async function putRaw(
  database: IDBDatabase,
  store: string,
  value: unknown,
): Promise<void> {
  const transaction = database.transaction(store, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(store).put(value);
  await done;
}

async function deleteRaw(
  database: IDBDatabase,
  store: string,
  key: string,
): Promise<void> {
  const transaction = database.transaction(store, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(store).delete(key);
  await done;
}

export async function runPendingInitialDeviceBootstrapBrowserVaultTest():
Promise<readonly string[]> {
  const checks: string[] = [];
  const revisionOne = pending(1);
  const revisionTwo = pending(2);
  const first = createBrowserPendingInitialDeviceBootstrapVault();
  if (await first.create(revisionOne) !== "inserted") {
    throw new Error("Browser pending bootstrap was not inserted");
  }
  const restarted = createBrowserPendingInitialDeviceBootstrapVault();
  const detached = await restarted.load(revisionOne.idempotencyKey);
  if (detached === null) throw new Error("Browser pending bootstrap restart failed");
  detached.profileBytes.fill(0);
  const reopened = await restarted.load(revisionOne.idempotencyKey);
  if (reopened === null
    || new TextDecoder().decode(reopened.profileBytes)
      !== "pending-browser-secret-profile") {
    throw new Error("Browser pending bootstrap load was not detached");
  }
  const contenders = await Promise.all([
    first.compareAndSwap({ expected: revisionOne, replacement: revisionTwo }),
    restarted.compareAndSwap({ expected: revisionOne, replacement: revisionTwo }),
  ]);
  if (contenders.filter(Boolean).length !== 1) {
    throw new Error("Browser pending bootstrap CAS was not serialized");
  }
  destroyPendingInitialDeviceBootstrap(detached);
  destroyPendingInitialDeviceBootstrap(reopened);
  checks.push("pending-bootstrap-restart-cas");

  const db = await database();
  const keyRecord = await rawRecord<{ readonly key: CryptoKey }>(
    db,
    KEY_STORE,
    "root",
  );
  if (keyRecord.key.extractable || keyRecord.key.algorithm.name !== "AES-GCM") {
    throw new Error("Browser pending bootstrap key is not nonextractable AES-GCM");
  }
  const stored = await rawRecord<{
    readonly idempotencyKey: string;
    readonly ciphertext: Uint8Array;
  }>(db, RECORD_STORE, revisionOne.idempotencyKey);
  const ciphertextText = new TextDecoder().decode(stored.ciphertext);
  if (ciphertextText.includes("pending-browser-secret")) {
    throw new Error("Browser pending bootstrap leaked plaintext");
  }
  const corrupt = {
    ...stored,
    ciphertext: stored.ciphertext.map((byte, index) =>
      index === 0 ? byte ^ 1 : byte
    ),
  };
  await putRaw(db, RECORD_STORE, corrupt);
  let corruptionRejected = false;
  try {
    await createBrowserPendingInitialDeviceBootstrapVault().load(
      revisionOne.idempotencyKey,
    );
  } catch {
    corruptionRejected = true;
  }
  if (!corruptionRejected) {
    throw new Error("Browser pending bootstrap accepted corruption");
  }
  await putRaw(db, RECORD_STORE, stored);
  await deleteRaw(db, KEY_STORE, "root");
  let keyLossRejected = false;
  try {
    await createBrowserPendingInitialDeviceBootstrapVault().load(
      revisionOne.idempotencyKey,
    );
  } catch (error) {
    keyLossRejected = String(error).includes("wrapping key is missing");
  }
  if (!keyLossRejected) {
    throw new Error("Browser pending bootstrap accepted key loss");
  }
  checks.push("pending-bootstrap-nonextractable-fail-closed");
  db.close();
  return Object.freeze(checks);
}
