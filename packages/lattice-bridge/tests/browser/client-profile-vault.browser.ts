/// <reference lib="dom" />

import {
  BrowserPreparedArtifactCiphertextSidecar,
  createBrowserClientProfileVault,
  createBrowserClientNamespaceGenerationCacheVaultV1,
  createBrowserPreparedMutationJournalVault,
} from "../../src/client/browser/index.ts";
import { createBrowserAdditionalDeviceTransitionJournalVault } from
  "../../src/client/memory/browser-prepared-mutation-journal-vault.ts";
import { createPreparedMutationJournal } from "../../src/client/memory/prepared-mutation-journal.ts";
import { runClientProfileVaultConformance } from "../../src/testing/client-profile-vault.ts";
import { runPendingInitialDeviceBootstrapBrowserVaultTest } from
  "./pending-initial-device-bootstrap-vault.browser.ts";

const coordinates = {
  serverScope: location.origin,
  userId: "10000000-0000-4000-8000-000000000001",
  humanActorId: "20000000-0000-4000-8000-000000000001",
  profileId: "profile_browser_integration",
  deviceId: "device_browser_integration",
  installationLineageDigest:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
} as const;

declare global {
  interface Window {
    runNautiloBrowserVaultTest(): Promise<readonly string[]>;
  }
}

window.runNautiloBrowserVaultTest = async () => {
  const checks: string[] = [];
  checks.push(...await runPendingInitialDeviceBootstrapBrowserVaultTest());
  const conformance = await runClientProfileVaultConformance(
    createBrowserClientProfileVault,
  );
  if (conformance.checks.length !== 11) {
    throw new Error("browser vault shared conformance failed");
  }
  checks.push("shared-conformance");
  const vault = createBrowserClientProfileVault();
  const unlocked = await vault.unlock();
  if (unlocked.status !== "available") {
    throw new Error(`browser vault unavailable: ${unlocked.status}`);
  }
  checks.push("unlock");

  await vault.stageProfile({
    coordinates,
    stageId: "stage_browser_1",
    generation: 1,
    profileBytes: new TextEncoder().encode("browser-private-canary"),
    publicState: {
      clientKind: "browser",
      publicFingerprint:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });
  await vault.activateProfile(coordinates, "stage_browser_1");
  const opened = await vault.withOpenProfile(
    coordinates,
    (bytes) => new TextDecoder().decode(bytes),
  );
  if (opened !== "browser-private-canary") {
    throw new Error("browser vault round-trip failed");
  }
  checks.push("round-trip");

  await vault.lock();
  const resumed = createBrowserClientProfileVault();
  if ((await resumed.unlock()).status !== "available") {
    throw new Error("browser vault restart unlock failed");
  }
  if (
    await resumed.withOpenProfile(
      coordinates,
      (bytes) => new TextDecoder().decode(bytes),
    ) !== "browser-private-canary"
  ) {
    throw new Error("browser vault restart persistence failed");
  }
  checks.push("non-extractable-key-persistence");

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nautilo-crypto-client-profile-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB open failed"),
    );
  });
  const transaction = database.transaction("wrapping_keys", "readonly");
  const keyRecord = await new Promise<{ readonly current: CryptoKey }>(
    (resolve, reject) => {
      const request = transaction.objectStore("wrapping_keys").get("root");
      request.onsuccess = () => resolve(
        request.result as { readonly current: CryptoKey },
      );
      request.onerror = () => reject(
        request.error ?? new Error("IndexedDB read failed"),
      );
    },
  );
  if (keyRecord.current.extractable) {
    throw new Error("browser wrapping key is extractable");
  }
  checks.push("non-extractable");

  const namespaceCache = createBrowserClientNamespaceGenerationCacheVaultV1();
  if ((await namespaceCache.unlock()).status !== "available") {
    throw new Error("browser Namespace cache failed to unlock");
  }
  const cacheEntry = {
    namespaceId: "90000000-0000-4000-8000-000000000001",
    keyClass: "ai" as const,
    accessRevision: 2,
    generation: 3,
    headDigest: new Uint8Array(32).fill(0x91),
    publicationDigest: new Uint8Array(32).fill(0x92),
    publicationSetDigest: new Uint8Array(32).fill(0x93),
    audienceFingerprint: new Uint8Array(32).fill(0x94),
    recipientKeyGeneration: 1,
    generationKey: new Uint8Array(32).fill(0x95),
  };
  await namespaceCache.putEntries(coordinates, [cacheEntry]);
  await namespaceCache.lock();
  const resumedCache = createBrowserClientNamespaceGenerationCacheVaultV1();
  if ((await resumedCache.unlock()).status !== "available") {
    throw new Error("browser Namespace cache restart failed");
  }
  const cacheHit = await resumedCache.withEntries(
    coordinates,
    [cacheEntry],
    (entries) => entries[0]!.generationKey.every((byte) => byte === 0x95),
  );
  if (cacheHit.status !== "hit" || !cacheHit.value) {
    throw new Error("browser Namespace cache did not reopen exact authority");
  }
  const cacheContender = createBrowserClientNamespaceGenerationCacheVaultV1();
  if ((await cacheContender.unlock()).status !== "available") {
    throw new Error("browser Namespace cache contender failed to unlock");
  }
  const profileContender = createBrowserClientProfileVault();
  if ((await profileContender.unlock()).status !== "available") {
    throw new Error("browser profile contender failed to unlock");
  }
  let signalCacheUse!: () => void;
  const cacheUseEntered = new Promise<void>((resolve) => signalCacheUse = resolve);
  let signalProfileUse!: () => void;
  const profileUseEntered = new Promise<void>((resolve) => signalProfileUse = resolve);
  let releaseCacheUse!: () => void;
  const cacheMayEnterProfile = new Promise<void>((resolve) => releaseCacheUse = resolve);
  let signalCacheMutationsComplete!: () => void;
  const cacheMutationsComplete = new Promise<void>(
    (resolve) => signalCacheMutationsComplete = resolve,
  );
  let copiedGenerationKey: Uint8Array | undefined;
  const cacheThenProfile = resumedCache.withEntries(
    coordinates,
    [cacheEntry],
    async (entries) => {
      copiedGenerationKey = entries[0]!.generationKey;
      signalCacheUse();
      await cacheMayEnterProfile;
      await cacheMutationsComplete;
      if (!entries[0]!.generationKey.every((byte) => byte === 0x95)) {
        throw new Error("browser Namespace cache callback key changed during forget");
      }
      return resumed.withOpenProfile(coordinates, (bytes) => bytes.length > 0);
    },
  );
  await cacheUseEntered;
  const replacementEntry = {
    ...cacheEntry,
    namespaceId: "90000000-0000-4000-8000-000000000002",
    generationKey: new Uint8Array(32).fill(0x96),
  };
  const profileThenCache = profileContender.withOpenProfile(coordinates, async () => {
    signalProfileUse();
    await cacheContender.putEntries(coordinates, [replacementEntry]);
    await cacheContender.evict(coordinates, replacementEntry.namespaceId);
    await cacheContender.forget(coordinates);
    signalCacheMutationsComplete();
    return true;
  });
  await profileUseEntered;
  releaseCacheUse();
  const cycle = Promise.all([cacheThenProfile, profileThenCache]);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("browser Namespace cache lock cycle stalled")),
      2_000,
    );
  });
  let cacheThenProfileResult;
  let profileThenCacheResult;
  try {
    [cacheThenProfileResult, profileThenCacheResult] = await Promise.race([
      cycle,
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  if (
    cacheThenProfileResult.status !== "hit"
    || !cacheThenProfileResult.value
    || !profileThenCacheResult
  ) throw new Error("browser Namespace cache lock cycle returned an invalid result");
  if (
    copiedGenerationKey === undefined
    || !copiedGenerationKey.every((byte) => byte === 0)
  ) throw new Error("browser Namespace cache callback key was not zeroized");
  if (
    (await resumedCache.withEntries(coordinates, [cacheEntry], () => null))
      .status !== "miss"
  ) throw new Error("browser Namespace cache forget did not affect subsequent reads");
  await cacheContender.lock();
  if ((await cacheContender.availability()).status !== "locked") {
    throw new Error("browser Namespace cache contender did not lock");
  }
  replacementEntry.generationKey.fill(0);
  checks.push("namespace-cache-callback-outside-document-lock");
  const cacheDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nautilo-namespace-generation-cache-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Namespace cache IndexedDB open failed"),
    );
  });
  const cacheKeyTransaction = cacheDatabase.transaction(
    "wrapping_keys",
    "readonly",
  );
  const cacheKeyRecord = await new Promise<{ readonly key: CryptoKey }>(
    (resolve, reject) => {
      const request = cacheKeyTransaction.objectStore("wrapping_keys").get(
        "root",
      );
      request.onsuccess = () => resolve(
        request.result as { readonly key: CryptoKey },
      );
      request.onerror = () => reject(
        request.error ?? new Error("Namespace cache key read failed"),
      );
    },
  );
  if (cacheKeyRecord.key.extractable) {
    throw new Error("browser Namespace cache key is extractable");
  }
  const cacheDocumentTransaction = cacheDatabase.transaction(
    "cache_documents",
    "readonly",
  );
  const sealedCache = await new Promise<{ readonly ciphertext: Uint8Array }>(
    (resolve, reject) => {
      const request = cacheDocumentTransaction.objectStore("cache_documents")
        .get("namespace-cache");
      request.onsuccess = () => resolve(
        request.result as { readonly ciphertext: Uint8Array },
      );
      request.onerror = () => reject(
        request.error ?? new Error("Namespace cache document read failed"),
      );
    },
  );
  let rawKeyMarker = false;
  for (let index = 0; index <= sealedCache.ciphertext.length - 32; index++) {
    if (sealedCache.ciphertext.subarray(index, index + 32).every(
      (byte) => byte === 0x95,
    )) {
      rawKeyMarker = true;
      break;
    }
  }
  if (rawKeyMarker) {
    throw new Error("browser Namespace cache exposed a raw key marker");
  }
  await resumedCache.evict(coordinates, cacheEntry.namespaceId);
  if (
    (await resumedCache.withEntries(coordinates, [cacheEntry], () => null))
      .status !== "miss"
  ) throw new Error("browser Namespace cache eviction failed");
  cacheEntry.headDigest.fill(0);
  cacheEntry.publicationDigest.fill(0);
  cacheEntry.publicationSetDigest.fill(0);
  cacheEntry.audienceFingerprint.fill(0);
  cacheEntry.generationKey.fill(0);
  checks.push("namespace-cache-restart-evict-nonextractable");

  const contender = createBrowserClientProfileVault();
  if ((await contender.unlock()).status !== "available") {
    throw new Error("browser vault concurrent instance failed to unlock");
  }
  const stages = await Promise.allSettled([
    resumed.stageProfile({
      coordinates,
      stageId: "stage_browser_concurrent_a",
      generation: 2,
      profileBytes: new TextEncoder().encode("concurrent-a"),
      publicState: {
        clientKind: "browser",
        publicFingerprint:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    }),
    contender.stageProfile({
      coordinates,
      stageId: "stage_browser_concurrent_b",
      generation: 2,
      profileBytes: new TextEncoder().encode("concurrent-b"),
      publicState: {
        clientKind: "browser",
        publicFingerprint:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    }),
  ]);
  if (
    stages.filter((result) => result.status === "fulfilled").length !== 1
    || stages.filter((result) => result.status === "rejected").length !== 1
  ) {
    throw new Error("browser vault failed to serialize concurrent stages");
  }
  const winningStage = stages[0]?.status === "fulfilled"
    ? "stage_browser_concurrent_a"
    : "stage_browser_concurrent_b";
  const winningBytes = stages[0]?.status === "fulfilled"
    ? "concurrent-a"
    : "concurrent-b";
  await resumed.activateProfile(coordinates, winningStage);
  const staleStage = winningStage === "stage_browser_concurrent_a"
    ? "stage_browser_concurrent_b"
    : "stage_browser_concurrent_a";
  let staleRejected = false;
  try {
    await contender.stageProfile({
      coordinates,
      stageId: staleStage,
      generation: 2,
      profileBytes: new TextEncoder().encode("stale-v3-candidate"),
      publicState: {
        clientKind: "browser",
        publicFingerprint:
          "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
    });
  } catch (error) {
    staleRejected = String(error).includes("generation is stale");
  }
  if (!staleRejected || await resumed.withOpenProfile(
    coordinates,
    (bytes) => new TextDecoder().decode(bytes),
  ) !== winningBytes) {
    throw new Error("browser vault accepted a stale profile candidate");
  }
  checks.push("multi-instance-serialization");

  const mutationVault = createBrowserPreparedMutationJournalVault();
  if ((await mutationVault.unlock()).status !== "available") {
    throw new Error("browser prepared mutation journal failed to unlock");
  }
  let mutationNow = 1_900_000_000_000;
  const journal = createPreparedMutationJournal({
    vault: mutationVault,
    now: () => mutationNow,
  });
  const mutationMemoryId = "81000000-0000-4000-8000-000000000001";
  const mutationNamespaceId = "81000000-0000-4000-8000-000000000010";
  await journal.putBeforeSend({
    kind: "create",
    memoryId: mutationMemoryId,
    request: {
      requestVersion: 1,
      operationId: "browser-mutation:1",
      memoryId: mutationMemoryId,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      cryptoObjectId: `nautilo-memory-v1:${mutationMemoryId}:1`,
      payloadVersion: 1,
      encryptedPayloadBytesBase64url: "YnJvd3Nlci1zZWNyZXQtY2lwaGVydGV4dA",
      accessManifestBytesBase64url: "YnJvd3Nlci1zZWNyZXQtbWFuaWZlc3Q",
      requiredNamespaceIds: [mutationNamespaceId],
      namespaceEnvelopes: [{
        namespaceId: mutationNamespaceId,
        envelopeBytesBase64url: "YnJvd3Nlci1zZWNyZXQtZW52ZWxvcGU",
      }],
      signedContentEmbeddingRequestBytesBase64url:
        "YnJvd3Nlci1zZWNyZXQtc2lnbmVkLXBsYWludGV4dA",
    },
  });
  const mutationTaskId = "84000000-0000-4000-8000-000000000001";
  await journal.putBeforeSend({
    kind: "task_create",
    taskId: mutationTaskId,
    request: {
      requestVersion: 1,
      operationId: "browser-task-mutation:1",
      planDigestBase64url: "T".repeat(43),
      taskId: mutationTaskId,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      resultCryptoAccessRevision: 0,
      cryptoObjectId: `task:v1:${mutationTaskId}:1`,
      payloadVersion: 1,
      requiredNamespaceIds: [mutationNamespaceId],
      encryptedPayloadBytesBase64url: "YnJvd3Nlci10YXNrLWNpcGhlcnRleHQ",
      accessManifestBytesBase64url: "YnJvd3Nlci10YXNrLW1hbmlmZXN0",
      namespaceEnvelopes: [{
        namespaceId: mutationNamespaceId,
        envelopeBytesBase64url: "YnJvd3Nlci10YXNrLWVudmVsb3Bl",
      }],
      signedPublicationRequestBytesBase64url: "YnJvd3Nlci10YXNrLXNpZ25lZA",
      task: {},
      operation: "create",
    },
  });
  const artifactAccessOperationId = "browser-artifact-access:1";
  const artifactAccessDigest = "A".repeat(43);
  const artifactAccessBody = new TextEncoder().encode("artifact-access-body");
  await mutationVault.putSealed({
    index: {
      formatVersion: 1,
      operationId: artifactAccessOperationId,
      authenticatedRequestDigestBase64url: artifactAccessDigest,
      kind: "artifact_access",
      artifactId: "82000000-0000-4000-8000-000000000010",
      canonicalBytes: artifactAccessBody.length,
      sealedBytes: artifactAccessBody.length + 16,
      createdAt: mutationNow,
      updatedAt: mutationNow,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: mutationNow,
      lastAttemptAt: null,
      state: "pending",
    },
    canonicalBody: artifactAccessBody,
  });
  artifactAccessBody.fill(0);
  const legacyLiveShadowOperationId = "l".repeat(256);
  const legacyLiveShadowDigest = "L".repeat(43);
  const legacyLiveShadowBody = new TextEncoder().encode("legacy-live-shadow-body");
  await mutationVault.putSealed({
    index: {
      formatVersion: 1,
      operationId: legacyLiveShadowOperationId,
      authenticatedRequestDigestBase64url: legacyLiveShadowDigest,
      kind: "live_shadow_message",
      roomId: "83000000-0000-4000-8000-000000000099",
      canonicalBytes: legacyLiveShadowBody.length,
      sealedBytes: legacyLiveShadowBody.length + 16,
      createdAt: mutationNow,
      updatedAt: mutationNow,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: mutationNow,
      lastAttemptAt: null,
      state: "pending",
    },
    canonicalBody: legacyLiveShadowBody,
  });
  legacyLiveShadowBody.fill(0);
  await mutationVault.lock();
  const resumedMutationVault = createBrowserPreparedMutationJournalVault();
  if ((await resumedMutationVault.unlock()).status !== "available") {
    throw new Error("browser prepared mutation journal restart failed");
  }
  if (!(await resumedMutationVault.listIndexes()).some((entry) =>
    entry.kind === "artifact_access"
    && entry.operationId === artifactAccessOperationId
  )) throw new Error("browser Artifact access journal record failed restart");
  if (!(await resumedMutationVault.listIndexes()).some((entry) =>
    entry.kind === "live_shadow_message"
    && entry.operationId === legacyLiveShadowOperationId
  )) throw new Error("browser legacy live-shadow journal record failed restart");
  await resumedMutationVault.removeExact(
    artifactAccessOperationId,
    artifactAccessDigest,
  );
  await resumedMutationVault.removeExact(
    legacyLiveShadowOperationId,
    legacyLiveShadowDigest,
  );
  checks.push("journal-artifact-access-restart");
  const resumedJournal = createPreparedMutationJournal({
    vault: resumedMutationVault,
    now: () => mutationNow,
  });
  let openedMutation: string | undefined;
  await resumedJournal.withPrepared("browser-mutation:1", (prepared) => {
    openedMutation = prepared.request.operationId;
  });
  if (openedMutation !== "browser-mutation:1") {
    throw new Error("browser prepared mutation journal round-trip failed");
  }
  await resumedJournal.withPrepared("browser-task-mutation:1", (prepared) => {
    if (prepared.kind !== "task_create" || prepared.taskId !== mutationTaskId) {
      throw new Error("browser prepared Task mutation journal round-trip failed");
    }
  });
  const mutationIndex = (await resumedJournal.listStatus())[0];
  if (mutationIndex === undefined) {
    throw new Error("browser prepared mutation journal index missing");
  }
  await resumedJournal.withPrepared("browser-mutation:1", async () => {
    if ((await resumedJournal.listStatus()).length !== 2) {
      throw new Error("browser prepared mutation journal reentrant read failed");
    }
  });
  mutationNow += 1;
  await resumedJournal.recordOutcome({
    operationId: mutationIndex.operationId,
    authenticatedRequestDigestBase64url:
      mutationIndex.authenticatedRequestDigestBase64url,
    outcome: "retryable",
  });
  checks.push("journal-round-trip-restart-cas-reentrant");

  const mutationDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      "nautilo-protected-memory-mutation-journal-v2",
      1,
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("mutation IndexedDB open failed"),
    );
  });
  const mutationKeyTransaction = mutationDatabase.transaction(
    "wrapping_keys",
    "readonly",
  );
  const mutationKeyRecord = await new Promise<{ readonly key: CryptoKey }>(
    (resolve, reject) => {
      const request = mutationKeyTransaction.objectStore("wrapping_keys").get("root");
      request.onsuccess = () => resolve(request.result as { readonly key: CryptoKey });
      request.onerror = () => reject(
        request.error ?? new Error("mutation key read failed"),
      );
    },
  );
  if (mutationKeyRecord.key.extractable) {
    throw new Error("browser prepared mutation journal key is extractable");
  }
  const mutationRecordTransaction = mutationDatabase.transaction(
    "journal_records",
    "readonly",
  );
  const mutationRecord = await new Promise<{
    readonly operationId: string;
    readonly ciphertext: Uint8Array;
  }>(
    (resolve, reject) => {
      const request = mutationRecordTransaction.objectStore("journal_records")
        .get("browser-mutation:1");
      request.onsuccess = () => resolve(
        request.result as {
          readonly operationId: string;
          readonly ciphertext: Uint8Array;
        },
      );
      request.onerror = () => reject(
        request.error ?? new Error("mutation record read failed"),
      );
    },
  );
  const ciphertextText = new TextDecoder().decode(mutationRecord.ciphertext);
  if (ciphertextText.includes("browser-secret")) {
    throw new Error("browser prepared mutation journal leaked plaintext");
  }
  checks.push("journal-non-extractable-no-plaintext");

  await resumedMutationVault.lock();
  const corruptMutationRecord = {
    ...mutationRecord,
    ciphertext: mutationRecord.ciphertext.map((byte, index) =>
      index === 0 ? byte ^ 1 : byte
    ),
  };
  const corruptionTransaction = mutationDatabase.transaction(
    "journal_records",
    "readwrite",
  );
  corruptionTransaction.objectStore("journal_records").put(corruptMutationRecord);
  await new Promise<void>((resolve, reject) => {
    corruptionTransaction.oncomplete = () => resolve();
    corruptionTransaction.onerror = () => reject(
      corruptionTransaction.error ?? new Error("mutation corruption write failed"),
    );
  });
  const corruptMutationVault = createBrowserPreparedMutationJournalVault();
  const corruptMutationStatus = await corruptMutationVault.unlock();
  if (
    corruptMutationStatus.status !== "corrupt"
    || corruptMutationStatus.reasonCode !== "browser_journal_authentication_failed"
  ) throw new Error("browser prepared mutation journal accepted corruption");
  const restoreTransaction = mutationDatabase.transaction(
    "journal_records",
    "readwrite",
  );
  restoreTransaction.objectStore("journal_records").put(mutationRecord);
  await new Promise<void>((resolve, reject) => {
    restoreTransaction.oncomplete = () => resolve();
    restoreTransaction.onerror = () => reject(
      restoreTransaction.error ?? new Error("mutation record restore failed"),
    );
  });
  checks.push("journal-corruption");

  const mutationKeyDeletion = mutationDatabase.transaction("wrapping_keys", "readwrite");
  mutationKeyDeletion.objectStore("wrapping_keys").delete("root");
  await new Promise<void>((resolve, reject) => {
    mutationKeyDeletion.oncomplete = () => resolve();
    mutationKeyDeletion.onerror = () => reject(
      mutationKeyDeletion.error ?? new Error("mutation key deletion failed"),
    );
    mutationKeyDeletion.onabort = () => reject(
      mutationKeyDeletion.error ?? new Error("mutation key deletion aborted"),
    );
  });
  const lostMutationVault = createBrowserPreparedMutationJournalVault();
  const lostMutationStatus = await lostMutationVault.unlock();
  if (
    lostMutationStatus.status !== "storage_lost"
    || lostMutationStatus.reasonCode !== "browser_journal_key_missing"
  ) throw new Error("browser prepared mutation journal did not detect key loss");
  checks.push("journal-storage-loss");

  const transitionVault =
    createBrowserAdditionalDeviceTransitionJournalVault();
  if ((await transitionVault.unlock()).status !== "available") {
    throw new Error("browser transition journal was poisoned by mutation custody");
  }
  const transitionBody = new TextEncoder().encode("transition-body");
  await transitionVault.putSealed({
    index: {
      formatVersion: 1,
      operationId: "browser-transition:1",
      authenticatedRequestDigestBase64url: "B".repeat(43),
      kind: "additional_device_transition",
      targetDeviceId: "device_browser_transition_target",
      targetClientKind: "electron",
      verificationCode: "ABCDEF-012345-6789AB",
      candidateProfileDigestBase64url: "C".repeat(43),
      candidateProfileGeneration: 2,
      canonicalBytes: transitionBody.length,
      sealedBytes: transitionBody.length + 16,
      createdAt: mutationNow,
      updatedAt: mutationNow,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: mutationNow,
      lastAttemptAt: null,
      state: "pending",
    },
    canonicalBody: transitionBody,
  });
  transitionBody.fill(0);
  await transitionVault.lock();
  const resumedTransitionVault =
    createBrowserAdditionalDeviceTransitionJournalVault();
  if (
    (await resumedTransitionVault.unlock()).status !== "available"
    || (await resumedTransitionVault.listIndexes()).length !== 1
  ) throw new Error("browser transition journal failed isolated restart");
  checks.push("journal-transition-isolation");

  const artifactCiphertext = new TextEncoder().encode(
    "browser-protected-artifact-ciphertext",
  );
  const artifactDigest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    artifactCiphertext,
  ));
  const artifactDigestBase64url = btoa(String.fromCharCode(...artifactDigest))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  artifactDigest.fill(0);
  const artifactReference = {
    formatVersion: 1 as const,
    operationId: "browser-artifact-sidecar:1",
    authenticatedRequestDigestBase64url:
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    artifactId: "82000000-0000-4000-8000-000000000001",
    blobId: "82000000-0000-4000-8000-000000000002",
    blobGeneration: 1,
    ciphertextLength: artifactCiphertext.length,
    ciphertextSha256Base64url: artifactDigestBase64url,
  };
  const artifactSidecar = new BrowserPreparedArtifactCiphertextSidecar();
  await artifactSidecar.unlock();
  await artifactSidecar.put({
    reference: artifactReference,
    ciphertext: {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          next: () => {
            if (emitted) return Promise.resolve({
              done: true as const,
              value: undefined,
            });
            emitted = true;
            return Promise.resolve({
              done: false as const,
              value: artifactCiphertext,
            });
          },
        };
      },
    },
  });
  artifactSidecar.lock();
  const resumedArtifactSidecar = new BrowserPreparedArtifactCiphertextSidecar();
  await resumedArtifactSidecar.unlock();
  const openedArtifactCiphertext = await resumedArtifactSidecar.withOpened(
    artifactReference,
    async (stream) => {
      const bytes: number[] = [];
      for await (const chunk of stream) bytes.push(...chunk);
      return Uint8Array.from(bytes);
    },
  );
  if (openedArtifactCiphertext.length !== artifactCiphertext.length
    || openedArtifactCiphertext.some((byte, index) =>
      byte !== artifactCiphertext[index])) {
    throw new Error("browser Artifact ciphertext sidecar restart failed");
  }
  if (!await resumedArtifactSidecar.removeExact(artifactReference)
    || (await resumedArtifactSidecar.list()).length !== 0) {
    throw new Error("browser Artifact ciphertext sidecar exact removal failed");
  }
  artifactCiphertext.fill(0);
  openedArtifactCiphertext.fill(0);
  resumedArtifactSidecar.lock();
  checks.push("artifact-sidecar-restart");

  if (
    localStorage.length !== 0
    || sessionStorage.length !== 0
    || (await caches.keys()).length !== 0
  ) {
    throw new Error("browser vault used a forbidden storage surface");
  }
  checks.push("no-fallback");

  const keyDeletion = database.transaction("wrapping_keys", "readwrite");
  keyDeletion.objectStore("wrapping_keys").delete("root");
  await new Promise<void>((resolve, reject) => {
    keyDeletion.oncomplete = () => resolve();
    keyDeletion.onerror = () => reject(
      keyDeletion.error ?? new Error("browser key deletion failed"),
    );
    keyDeletion.onabort = () => reject(
      keyDeletion.error ?? new Error("browser key deletion aborted"),
    );
  });
  const storageLost = createBrowserClientProfileVault();
  const storageLostStatus = await storageLost.unlock();
  if (
    storageLostStatus.status !== "storage_lost"
    || storageLostStatus.reasonCode !== "browser_wrapping_key_missing"
  ) {
    throw new Error("browser vault did not fail closed after key loss");
  }
  checks.push("storage-loss");

  await resumed.forgetProfile(coordinates);
  return checks;
};
