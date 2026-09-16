import { expect, test } from "bun:test";
import { LatticeCrypto, InMemoryLatticeStore, persistPreparedObjectAccessManifestGenesis, humanId, namespaceId, objectId, cryptoDeviceId, authorizationRevision,
  unixTimestamp, prepareHumanExistingMessageRepresentationPublicationRequest } from "@nautilo/lattice-crypto";
import { type MessageBackfillClaim, type MessageBackfillAckRequest } from "@nautilo/api-client";
import { deriveMessageCryptoObjectIdV2, encodeMessagePayloadV2, messageBackfillClaimDigest,
  messageBackfillAcknowledgementDigest, IMMUTABLE_ROOM_NAMESPACE_INVARIANT,
  prepareHumanExistingMessageRepresentationCryptoRevision, prepareHumanPeerLiveShadowCryptoRevision,
  readPreparedConversationCryptoRevision } from "@nautilo/lattice-bridge";
import { recoverReservedMessageBackfillPublication, matchesMessageBackfillAuthority, type MessageBackfillAuthority,
  type MessageBackfillCandidate, type PostgresConversationProductStore } from "@nautilo/lattice-bridge/server";
import { createProductionMessageBackfillComposition, type MessageBackfillSubject } from "../../src/routes/message-backfill-composition.ts";

type Dependencies = NonNullable<Parameters<typeof createProductionMessageBackfillComposition>[0]>;
const id = (n: number) => `31300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

function fixture(keyClass: "human" | "ai" = "human") {
  const crypto = new LatticeCrypto(), signing = crypto.generateSigningKeyPair(), head = crypto.hash(new Uint8Array([1]));
  const now = Date.now(), bytes = encodeMessagePayloadV2({role: "system", content: "canonical", sensitiveMetadata: {reason: "summary"}});
  const manifest = new Uint8Array([5, 6, 7]);
  const claim: MessageBackfillClaim = {version: 1, claimId: id(1), operationId: "repair-42", coordinate: {
    sessionId: id(2), messageId: 42, revision: 0, roomId: id(3), namespaceId: id(4), role: "system", logicalMessageKey: "row:42"},
    sourceRevision: null, action: "verify", subjectHumanId: id(5), deviceId: "device-1", serverInstanceId: "server-1", deviceGeneration: 2,
    lineageGeneration: 1, membershipEpoch: 2, membershipSecurityRevision: 3, membershipHeadDigestBase64url: b64(head),
    hostAuthorizationRevision: 4, policyRevision: 5, keyClass, namespaceAccessRevision: 6, namespaceKeyGeneration: 7,
    namespaceHeadDigestBase64url: b64(head), domainId: "domain-1", domainGeneration: 8, domainAuthorizationRevision: 9,
    domainHeadDigestBase64url: b64(head), namespaceBundleRevision: 10, namespaceBundleDigestBase64url: b64(head),
    repairIdentityDigestBase64url: b64(head), createdAt: now, authorHumanTurnId: null, sessionAgentId: null,
    cryptoObjectId: deriveMessageCryptoObjectIdV2({sessionId: id(2), messageId: 42, revision: 0}), issuedAt: now, expiresAt: now + 25_000};
  const row: MessageBackfillCandidate = {messageId: 42, sessionId: id(2), revision: 0, role: "system", ordinaryPresent: true,
    messageSourceRevision: 0, cryptoObjectId: claim.cryptoObjectId, sessionRoomId: id(3), subthreadRoomId: null, sourceRoomId: id(3), authorityRoomId: id(3),
    namespaceId: id(4), namespaceAccessRevision: 6, sessionOwnerUserId: id(6), sessionAgentId: null, createdAt: new Date(now),
    humanTurnId: null, logicalMessageKey: "row:42", supportedTopology: true, targetKeyClass: keyClass,
    ordinaryRestorationAccepted: false, lifecycle: {sessionId: id(2), messageId: 42, revision: 0, keyClass,
      cryptoObjectId: claim.cryptoObjectId, completion: "complete", disposition: "mapped", parityStatus: "client_authenticated", repairIdentityPresent: true}};
  const device = {userId: id(6), humanActorId: id(5), deviceId: "device-1", deviceGeneration: 2, signingPublicKey: signing.publicKey,
    serverInstanceId: "server-1", lineageGeneration: 1, epoch: 2, securityRevision: 3, headDigest: head};
  const authority = {candidate: row, device, policyRevision: 5, keyClass, namespace: {namespaceId: id(4), namespaceAccessRevision: 6,
    namespaceKeyGeneration: 7, namespaceHeadDigest: head, domainId: "domain-1", domainKeyGeneration: 8,
    domainAuthorizationRevision: 9, domainHeadDigest: head, bundleRevision: 10, bundleDigest: head},
    writer: {committerDeviceRevision: 4}} as MessageBackfillAuthority;
  const subject: MessageBackfillSubject = {userId: id(6), humanActorId: id(5), deviceId: "device-1", admission: {
    ...device, expiresAt: claim.expiresAt}};
  const events: string[] = [];
  let allocationDigest: Uint8Array | undefined, marked: unknown;
  const lifecycle = {sessionId: id(2), roomId: id(3), messageId: 42, revision: 0, keyClass, authorRole: "system", sequence: 1,
    appendIdempotencyKey: "repair-42", terminalOperationId: null, terminalOperationType: null, terminalExpectedRevision: null,
    terminalRequestDigest: null, objectIdScheme: "message_v2", shadowOperationId: null, humanPeerShadowOperationId: null,
    sharedAgentShadowOperationId: null, sharedAgentShadowExecutionId: null, shadowTranscriptOrdinal: null,
    cryptoObjectId: claim.cryptoObjectId, namespaceIdAtAllocation: id(4), completion: "pending", disposition: "active",
    parityStatus: "pending", failureCode: null, attemptCount: 0, nextAttemptAt: new Date(), leaseToken: null, leaseExpiresAt: null,
    allocationRequestDigest: crypto.hash(bytes), repairIdentityDigest: head, representationMode: "shadow_encryption", publicationPolicyRevision: 5};
  const product = {roomNamespaceInvariant: IMMUTABLE_ROOM_NAMESPACE_INVARIANT,
    acceptIndependentMessageParity: async () => {events.push("parity"); return "applied";},
    allocateExistingRepresentation: async (input: {requestDigest: Uint8Array}) => {events.push("allocate"); allocationDigest = input.requestDigest.slice();
      return {status: "allocated", lifecycle};},
    reserveExistingRepresentationPublication: async (input: {repairPublication: {publisherKind: string; publisherId: string; publisherHumanId: string; attestationDigest: Uint8Array}}) => {
      events.push("reserve"); Object.assign(lifecycle, {repairPublisherKind: input.repairPublication.publisherKind,
        repairPublisherId: input.repairPublication.publisherId, repairPublisherHumanId: input.repairPublication.publisherHumanId,
        repairAttestationDigest: input.repairPublication.attestationDigest.slice()}); return "reserved";
    },
    getRevision: async () => ({lifecycle}), resolveCurrentNamespace: async () => id(4),
    markCryptoComplete: async (input: unknown) => {events.push("mark"); marked = input; return "applied";},
    compareAndSwapCryptoMapping: async () => {events.push("map"); return "applied";},
  } as unknown as PostgresConversationProductStore;
  const runner = {transaction: (use: (tx: unknown, executor: unknown) => Promise<unknown>) => use({}, {})};
  const scan = {current: async () => claim, advance: async () => {events.push("advance"); return true;}};
  let mode = "shadow_encryption";
  const dependencies = {
    getPolicy: async () => ({mode, revision: 5, shadowBehavior: "strict"}),
    context: async () => ({canonicalRunner: runner, scan}), restricted: () => ({}),
    activeToolContext: async () => null,
    readCandidates: async () => [row], readSource: async () => {events.push("source"); return bytes.slice();},
    recover: async () => "absent",
    readManifest: async () => {events.push("manifest"); return manifest.slice();},
    scan: () => scan,
    completion: async () => ({complete: async () => {events.push("crypto"); return "created";},
      verify: async () => ({objectId: claim.cryptoObjectId, namespaceId: id(4), objectType: "nautilo-message-v2",
        payloadVersion: 2, keyClass})}),
    withAuthority: (input: {use: (...args: unknown[]) => Promise<unknown>}) => input.use(authority, product, {}, runner, {}),
  } as unknown as Dependencies;
  const composition = createProductionMessageBackfillComposition(dependencies);
  const ack = (overrides: Partial<Omit<MessageBackfillAckRequest, "signatureBase64url">> = {}) => {
    const unsigned = {claimId: claim.claimId, outcome: "reconciled" as const, claimDigestBase64url: b64(messageBackfillClaimDigest(claim)),
      sourceDigestBase64url: b64(crypto.hash(bytes)), manifestDigestBase64url: b64(crypto.hash(manifest)), ...overrides};
    return {...unsigned, signatureBase64url: b64(crypto.sign(signing.privateKey, messageBackfillAcknowledgementDigest(unsigned)))};
  };
  let snapshotForRecovery: ReturnType<typeof readPreparedConversationCryptoRevision>;
  const publication = () => {
    claim.action = "encrypt"; Object.assign(row, {cryptoObjectId: null, lifecycle: null});
    const prepare = keyClass === "ai" ? prepareHumanExistingMessageRepresentationCryptoRevision : prepareHumanPeerLiveShadowCryptoRevision;
    const prepared = prepare({crypto, objectId: claim.cryptoObjectId,
      payload: {role: "system", content: "canonical", sensitiveMetadata: {reason: "summary"}}, createdAt: now,
      namespace: {namespaceId: id(4), accessRevision: 6, keyGeneration: 7, aiKey: head, humanKey: head},
      device: {deviceId: "device-1", hostAuthorizationRevision: 4, signingPrivateKey: signing.privateKey}, resolveCurrentAuthorization: () => null});
    const snapshot = readPreparedConversationCryptoRevision(prepared);
    snapshotForRecovery = snapshot;
    const signed = prepareHumanExistingMessageRepresentationPublicationRequest(crypto, {
      subjectHumanId: humanId(id(5)), operationId: claim.operationId, sessionId: id(2), roomId: id(3), messageId: 42, revision: 0,
      createdAt: unixTimestamp(now), authorRole: "system", authorHumanTurnId: null, sessionAgentId: null,
      cryptoObjectId: objectId(claim.cryptoObjectId), namespaceId: namespaceId(id(4)), namespaceBindingHash: head,
      namespaceAccessRevision: 6, namespaceKeyGeneration: 7, bindingRevisionAtWrap: 6,
      ciphertextPayloadHash: crypto.hash(snapshot.object.payloadBytes.ciphertext), plaintextPayloadHash: crypto.hash(bytes),
      accessManifestHash: crypto.hash(snapshot.access.manifestBytes), envelopeHash: crypto.hash(snapshot.access.envelopeBytes[0]!),
      issuedAt: unixTimestamp(now), deadlineAt: unixTimestamp(claim.expiresAt), committerDeviceId: cryptoDeviceId("device-1"),
      hostAuthorizationRevision: authorizationRevision(4), committerSigningPublicKey: signing.publicKey, committerSigningPrivateKey: signing.privateKey});
    return {claimId: claim.claimId, requestBytesBase64url: b64(signed.bytes), payloadBytesBase64url: b64(snapshot.object.payloadBytes.ciphertext),
      manifestBytesBase64url: b64(snapshot.access.manifestBytes), envelopeBytesBase64url: b64(snapshot.access.envelopeBytes[0]!)};
  };
  return {composition, dependencies, subject, claim, row, authority, events, ack, publication, crypto, bytes, product, lifecycle, signing,
    snapshot: () => snapshotForRecovery,
    allocationDigest: () => allocationDigest, marked: () => marked, setMode(value: string) {mode = value;}};
}

test.each(["human", "ai"] as const)("server publishes %s with canonical source allocation and authenticated provenance", async keyClass => {
  const f = fixture(keyClass);
  expect(await f.composition.publish(f.subject, f.publication())).toEqual({status: "published"});
  expect(f.allocationDigest()).toEqual(f.crypto.hash(f.bytes));
  expect(f.marked()).toMatchObject({parityStatus: "client_authenticated", repairPublication: {publisherKind: "human_device", publisherHumanId: id(5)}});
  expect(f.events).toEqual(["source", "allocate", "reserve", "source", "allocate", "crypto", "mark", "map"]);
});

test("checks a pending reservation for recovery before allocation replay", async () => {
  const f = fixture("ai"), request = f.publication();
  Object.assign(f.row, {lifecycle: {...f.row.lifecycle,
    completion: "pending", disposition: "active", parityStatus: "pending"}});
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    recover: async () => {f.events.push("recover"); return "absent";},
  });

  expect(await composition.publish(f.subject, request)).toEqual({status: "published"});
  expect(f.events.slice(0, 3)).toEqual(["source", "recover", "allocate"]);
});

test.each(["human", "ai"] as const)("independent %s ack promotes exact signed source and manifest before advancing", async keyClass => {
  const f = fixture(keyClass);
  expect(await f.composition.ack(f.subject, f.ack())).toMatchObject({status: "more"});
  expect(f.events).toEqual(["source", "manifest", "parity", "advance"]);
});

test("rejects a Tool failure observed before a predecessor edit without quarantining the new generation", async () => {
  const f = fixture("ai");
  Object.assign(f.claim.coordinate, {role: "tool"});
  f.claim.sourceRevision = 7;
  Object.assign(f.row, {role: "tool", messageSourceRevision: 7});
  const request = f.ack({outcome: "parity_mismatch", sourceDigestBase64url: null, manifestDigestBase64url: null});
  const observedClaimDigest = messageBackfillClaimDigest(f.claim);
  Object.assign(f.row, {messageSourceRevision: 8});
  expect(matchesMessageBackfillAuthority(f.claim, f.authority)).toBe(false);
  expect(messageBackfillClaimDigest({...f.claim, sourceRevision: 8})).not.toEqual(observedClaimDigest);
  expect(await f.composition.ack(f.subject, request)).toMatchObject({status: "stale"});
  expect(f.events).toEqual([]);
});

test.each(["claim", "source", "manifest", "signature", "admission", "restored"])("rejects substituted ack %s without parity or progress writes", async change => {
  const f = fixture();
  const request = f.ack(change === "claim" ? {claimDigestBase64url: b64(new Uint8Array(32))}
    : change === "source" ? {sourceDigestBase64url: b64(new Uint8Array(32))}
    : change === "manifest" ? {manifestDigestBase64url: b64(new Uint8Array(32))} : {});
  if (change === "signature") request.signatureBase64url = b64(new Uint8Array(64));
  if (change === "admission") Object.assign(f.subject.admission, {headDigest: new Uint8Array(32)});
  if (change === "restored") Object.assign(f.row, {ordinaryRestorationAccepted: true});
  expect(await f.composition.ack(f.subject, request)).toMatchObject({status: "stale"});
  expect(f.events).not.toContain("parity"); expect(f.events).not.toContain("advance");
});

test.each([false, true])("null witness cannot turn authentication into parity (restoration %s)", async restored => {
  const f = fixture(); Object.assign(f.row, {ordinaryRestorationAccepted: restored});
  expect(await f.composition.ack(f.subject, f.ack({sourceDigestBase64url: null, manifestDigestBase64url: null})))
    .toMatchObject({status: restored ? "more" : "stale"});
  expect(f.events).not.toContain("parity");
});

test.each(["plaintext_only", "encrypted_only"])("%s blocks source, publication and ack before opening authority", async mode => {
  const f = fixture(); f.setMode(mode);
  expect(await f.composition.publish(f.subject, f.publication())).toEqual({status: "stale"});
  expect(await f.composition.source(f.subject, f.claim.claimId)).toMatchObject({status: "stale"});
  expect(await f.composition.ack(f.subject, f.ack())).toMatchObject({status: "stale"});
  expect(f.events).toEqual([]);
});

test("every signed current authority fence participates in claim admission", () => {
  const f = fixture(); expect(matchesMessageBackfillAuthority(f.claim, f.authority)).toBe(true);
  for (const key of ["subjectHumanId", "deviceId", "serverInstanceId", "deviceGeneration", "lineageGeneration", "membershipEpoch",
    "membershipSecurityRevision", "membershipHeadDigestBase64url", "hostAuthorizationRevision", "policyRevision", "keyClass",
    "namespaceAccessRevision", "namespaceKeyGeneration", "namespaceHeadDigestBase64url", "domainId", "domainGeneration",
    "domainAuthorizationRevision", "domainHeadDigestBase64url", "namespaceBundleRevision", "namespaceBundleDigestBase64url"] as const) {
    const original = f.claim[key];
    expect(matchesMessageBackfillAuthority({...f.claim, [key]: typeof original === "number" ? original + 1 : `${original}-other`}, f.authority)).toBe(false);
  }
});


test.each(["human", "ai"] as const)("recovers committed %s ciphertext after product rollback without current original publisher", async keyClass => {
  const f = fixture(keyClass); const publication = f.publication();
  const storage = new InMemoryLatticeStore(), snapshot = f.snapshot();
  Object.assign(f.lifecycle, {repairPublisherKind: "human_device", repairPublisherId: "device-1",
    repairPublisherHumanId: id(5), repairAttestationDigest: f.crypto.hash(snapshot.access.manifestBytes)});
  await storage.putObject(snapshot.object);
  expect(await persistPreparedObjectAccessManifestGenesis({crypto: f.crypto, storage, prepared: snapshot.access,
    resolveCurrentAuthorization: context => ({...context, sourceAuthorized: true, targetAuthorized: true,
      currentHostAuthorizationRevision: 4, committerSigningPublicKey: f.signing.publicKey})})).toBe("applied");
  const newDevice = f.crypto.generateSigningKeyPair();
  Object.assign(f.authority.device, {deviceId: "later-device", signingPublicKey: newDevice.publicKey});
  f.claim.deviceId = "later-device";
  let retainedRequests = 0;
  const options = {product: f.product, productExecutor: {} as never, restricted: {} as never, crypto: f.crypto,
    serverId: "server-1", authority: f.authority, claim: f.claim, sourceDigest: f.crypto.hash(f.bytes), storage,
    resolveHistoricalSigner: (context: Parameters<NonNullable<Parameters<typeof recoverReservedMessageBackfillPublication>[0]["resolveHistoricalSigner"]>>[0]) => {
      retainedRequests++; expect(context.committerDeviceId).toBe("device-1");
      return {...context, committerSigningPublicKey: f.signing.publicKey};
    }};
  expect(await recoverReservedMessageBackfillPublication(options)).toBe("replayed");
  expect(retainedRequests).toBe(1);
  expect(f.marked()).toMatchObject({parityStatus: "client_authenticated", repairPublication: {publisherId: "device-1", publisherHumanId: id(5)}});
  expect(b64((await storage.getObject(f.claim.cryptoObjectId))!.payloadBytes)).toBe(publication.payloadBytesBase64url);
  f.events.length = 0;
  Object.assign(f.lifecycle, {repairAttestationDigest: new Uint8Array(32)});
  expect(await recoverReservedMessageBackfillPublication(options)).toBe("conflict");
  expect(f.events).toEqual([]);
  Object.assign(f.lifecycle, {repairAttestationDigest: f.crypto.hash(snapshot.access.manifestBytes)});
  expect(await recoverReservedMessageBackfillPublication({...options, sourceDigest: new Uint8Array(32)})).toBe("conflict");
  expect(f.events).toEqual([]);
  expect(await recoverReservedMessageBackfillPublication({...options, resolveHistoricalSigner: () => null})).toBe("conflict");
  expect(f.events).toEqual([]);
});

test.each(["system", "tool"] as const)("pending Tool context permits unrelated %s candidates without replacing context", async role => {
  const f = fixture(); Object.assign(f.row, {role: "tool"});
  const other = {...f.row, messageId: 43, role, logicalMessageKey: "row:43"};
  const events: string[] = [];
  const scan = {select: async () => ({status: "candidate", candidate: other, action: "verify", cursor: 42, urgent: false}),
    install: async () => {events.push("claim"); return true;}, defer: async () => {events.push("defer");}};
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
    readCandidates: async (_executor, input) => [input.throughMessageId === 42 ? f.row : other],
    activeToolContext: async () => ({sessionId: f.row.sessionId, messageId: 42, revision: 0, failureMessageId: null}),
    prepareToolContext: async (_runner, input) => {events.push(`prepare:${input.messageId}`);
      return {status: "more", becameTerminal: false};},
    withAuthority: async input => input.use({...f.authority, candidate: input.candidate}, f.product, {} as never, {} as never, {} as never),
  });
  const result = await composition.next(f.subject);
  expect(result.status).toBe(role === "system" ? "claimed" : "more");
  expect(events).toEqual(["prepare:42", role === "system" ? "claim" : "defer"]);
});

test("a newly ready Tool context uses the existing urgent selection lane once", async () => {
  const f = fixture(); Object.assign(f.row, {role: "tool"});
  let urgent: number | undefined;
  const scan = {select: async (input: {urgentMessageId?: number}) => {
    urgent = input.urgentMessageId; return {status: "candidate", candidate: f.row, action: "verify", cursor: 99, urgent: true};
  }, install: async () => true};
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
    activeToolContext: async () => ({sessionId: f.row.sessionId, messageId: 42, revision: 0, failureMessageId: null}),
    prepareToolContext: async () => ({status: "ready", becameTerminal: true}),
  });
  expect((await composition.next(f.subject)).status).toBe("claimed");
  expect(urgent).toBe(42);
});

test.each([false, true])("a stable ready Tool context permits a different Tool candidate (explicit priority=%s)", async explicit => {
  const f = fixture(); Object.assign(f.row, {role: "tool"});
  const other = {...f.row, messageId: 43, logicalMessageKey: "row:43"};
  const events: string[] = [];
  let selectedUrgent: number | undefined;
  const scan = {select: async (input: {urgentMessageId?: number}) => {
    selectedUrgent = input.urgentMessageId;
    return {status: "candidate", candidate: other, action: "verify", cursor: 42, urgent: explicit};
  }, install: async (input: {claim: MessageBackfillClaim}) => {
    events.push(`claim:${input.claim.coordinate.messageId}`); return true;
  }};
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
    readCandidates: async (_executor, input) => [input.throughMessageId === 42 ? f.row : other],
    activeToolContext: async () => ({sessionId: f.row.sessionId, messageId: 42,
      revision: 0, failureMessageId: null}),
    prepareToolContext: async (_runner, input) => {
      events.push(`prepare:${input.messageId}`);
      return input.messageId === 42
        ? {status: "ready", becameTerminal: false}
        : {status: "ready", becameTerminal: true};
    },
    withAuthority: async input => input.use({...f.authority, candidate: input.candidate},
      f.product, {} as never, {} as never, {} as never),
  });
  const priority = {roomId: other.sourceRoomId, messageId: other.messageId,
    revision: other.revision};

  expect(await composition.next(f.subject, explicit ? priority : undefined)).toMatchObject({
    status: "claimed", claim: {coordinate: {messageId: 43}},
  });
  expect(selectedUrgent).toBe(explicit ? 43 : undefined);
  expect(events).toEqual(["prepare:42", "prepare:43", "claim:43"]);
});

test("stale prepared Tool source waits and cannot allocate or record integrity failure", async () => {
  const f = fixture(); const request = f.publication(); Object.assign(f.row, {role: "tool"});
  const composition = createProductionMessageBackfillComposition({...f.dependencies, readSource: async () => null});
  expect((await composition.source(f.subject, f.claim.claimId)).status).toBe("stale");
  // Keep the exact current claim role so this reaches the canonical source fence.
  f.claim.coordinate.role = "tool";
  f.claim.sourceRevision = 0;
  expect((await composition.source(f.subject, f.claim.claimId)).status).toBe("waiting_for_authority");
  expect((await composition.publish(f.subject, request)).status).toBe("stale");
  expect(f.events).not.toContain("allocate");
});

test("progress uses one database aggregate instead of enumerating candidates", async () => {
  const f = fixture();
  let aggregates = 0;
  const lastSweepAt = new Date(Date.now() - 1_000);
  const leaseExpiresAt = new Date(Date.now() + 10_000);
  const tx = {select: () => ({from: () => ({
    where: async () => [{lastSweepAt, leaseExpiresAt,
      leaseToken: f.claim.claimId, leaseDeviceId: f.claim.deviceId,
      claim: f.claim}],
  })})};
  const runner = {transaction: (
    use: (transaction: typeof tx, executor: object) => Promise<unknown>,
  ) => use(tx, {})};
  const composition = createProductionMessageBackfillComposition({
    ...f.dependencies,
    context: async () => ({canonicalRunner: runner, scan: {}}) as never,
    readCandidates: async () => {
      throw new Error("progress must not enumerate Message candidates");
    },
    readProgress: async (_executor, input) => {
      aggregates += 1;
      expect(input).toEqual({
        subjectHumanId: f.subject.humanActorId,
        policyRevision: 5,
        claimed: {action: "verify", sourceRevision: null, messageId: 42,
          sessionId: f.claim.coordinate.sessionId,
          revision: 0, sourceRoomId: f.claim.coordinate.roomId,
          namespaceId: f.claim.coordinate.namespaceId, role: "system",
          cryptoObjectId: f.claim.cryptoObjectId},
      });
      return {eligible: 20, pending: 12, alreadyAuthenticated: 4,
        independentlyParityVerified: 5, claimedRepairing: 1,
        repairedAndVerified: 2, unsupported: 1, failed: 3};
    },
  });

  const result = await composition.progress(f.subject);
  expect(aggregates).toBe(1);
  expect(result).toMatchObject({
    status: "failed",
    snapshotComplete: true,
    caughtUp: false,
    activeLease: true,
    counts: {eligible: 20, alreadyAuthenticated: 4,
      independentlyParityVerified: 5, claimedRepairing: 1,
      repairedAndVerified: 2, unsupported: 1, failed: 3},
    waiting: {authorizedDevice: null, authority: null},
    lastSweepAt: lastSweepAt.getTime(),
  });
});

test("a Tool-only Room with missing authority requests key preparation with backoff", async () => {
  const f = fixture(); Object.assign(f.row, {role: "tool"});
  let deferred = false;
  const scan = {select: async () => ({status: "candidate", candidate: f.row, action: "verify", cursor: 0, urgent: false}),
    defer: async () => {deferred = true;}};
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
    withAuthority: async () => null,
  });
  const before = Date.now();
  const result = await composition.next(f.subject);
  expect(result).toMatchObject({status: "prepare_authority", coordinate: {messageId: 42}, keyClass: f.row.lifecycle!.keyClass});
  if (result.status !== "prepare_authority") throw new Error("Expected key preparation");
  expect(result.resumeAt).toBeGreaterThan(before); expect(deferred).toBe(true);
});

test.each([false, true])("active Tool context losing authority avoids hot loops while ordinary candidate available=%s", async ordinaryAvailable => {
  const f = fixture(); Object.assign(f.row, {role: "tool"});
  const other = {...f.row, messageId: 43, role: "system" as const, logicalMessageKey: "row:43"};
  const scan = {select: async () => ordinaryAvailable
    ? {status: "candidate", candidate: other, action: "verify", cursor: 42, urgent: false}
    : {status: "waiting", resumeAt: Date.now() + 30_000}, install: async () => true};
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
    activeToolContext: async () => ({sessionId: f.row.sessionId, messageId: 42, revision: 0, failureMessageId: null}),
    discardToolContext: async () => true,
    withAuthority: async input => input.candidate.messageId === 42 ? null
      : input.use({...f.authority, candidate: input.candidate}, f.product, {} as never, {} as never, {} as never),
  });
  const before = Date.now();
  const result = await composition.next(f.subject);
  expect(result.status).toBe(ordinaryAvailable ? "claimed" : "prepare_authority");
  if (result.status === "prepare_authority") expect(result.resumeAt).toBeGreaterThan(before);
});

test("authority-blocked Tool cleanup releases the parser slot for another Tool and later recovery", async () => {
  const f = fixture(); Object.assign(f.row, {role: "tool"});
  const other = {...f.row, messageId: 43, sessionId: id(43), sourceRoomId: id(44), sessionRoomId: id(44),
    authorityRoomId: id(44), namespaceId: id(45), logicalMessageKey: "row:43"};
  let activation = 0, blockedAuthority = true, activeContext = true, discardActivations = 0;
  const events: string[] = [];
  const scan = {
    select: async () => ({status: "candidate", candidate: activation++ < 2 ? other : f.row,
      action: "verify", cursor: 42, urgent: false}),
    defer: async (input: {messageId: number}) => {events.push(`defer:${input.messageId}`);},
    install: async (input: {claim: MessageBackfillClaim}) => {events.push(`claim:${input.claim.coordinate.messageId}`); return true;},
  };
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
    readCandidates: async (_executor, input) => [input.throughMessageId === 42 ? f.row : other],
    activeToolContext: async () => activeContext
      ? {sessionId: f.row.sessionId, messageId: 42, revision: 0, failureMessageId: null} : null,
    discardToolContext: async () => {
      events.push("discard");
      discardActivations += 1;
      if (discardActivations < 2) return false;
      activeContext = false;
      return true;
    },
    prepareToolContext: async (_runner, input) => {events.push(`prepare:${input.messageId}`);
      return {status: "ready", becameTerminal: true};},
    withAuthority: async input => input.candidate.messageId === 42 && blockedAuthority ? null
      : input.use({...f.authority, candidate: input.candidate,
        namespace: {...f.authority.namespace, namespaceId: input.candidate.namespaceId}},
      f.product, {} as never, {} as never, {} as never),
  });

  expect(await composition.next(f.subject)).toMatchObject({status: "prepare_authority", coordinate: {messageId: 42}});
  expect(await composition.next(f.subject)).toMatchObject({status: "claimed", claim: {coordinate: {messageId: 43}}});
  blockedAuthority = false;
  expect(await composition.next(f.subject)).toMatchObject({status: "claimed", claim: {coordinate: {messageId: 42}}});
  expect(events).toEqual(["discard", "defer:43", "discard", "prepare:43", "claim:43", "prepare:42", "claim:42"]);
});


test.each(["resolved", "changed_revision", "changed_room", "changed_message", "inaccessible", "unsupported", "still_pending", "changed_during_fence", "no_explicit_priority"] as const)(
  "durable priority reports its own current authorized selection: %s", async scenario => {
    const f = fixture();
    Object.assign(f.row.lifecycle!, {parityStatus: "client_verified"});
    if (scenario === "still_pending") Object.assign(f.row.lifecycle!, {parityStatus: "client_authenticated"});
    if (scenario === "unsupported") Object.assign(f.row, {supportedTopology: false});
    const scan = {select: async (input: {urgentMessageId?: number}) => {
      if (["changed_revision", "changed_room", "changed_message", "no_explicit_priority"].includes(scenario)) {
        expect(input.urgentMessageId).toBeUndefined();
      }
      return {status: "priority_resolved", candidate: f.row};
    }};
    const composition = createProductionMessageBackfillComposition({...f.dependencies,
      context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
      ...(scenario === "inaccessible" ? {withAuthority: async () => null} : {}),
      ...(scenario === "changed_during_fence" ? {withAuthority: (async input => input.use({
        ...f.authority, candidate: {...f.row, revision: f.row.revision + 1},
      }, f.product, {} as never, {} as never, {} as never)) as NonNullable<Dependencies["withAuthority"]>} : {}),
    });
    const urgent = {roomId: scenario === "changed_room" ? id(99) : f.row.sourceRoomId,
      messageId: scenario === "changed_message" ? f.row.messageId + 1 : f.row.messageId, revision: scenario === "changed_revision" ? f.row.revision + 1 : f.row.revision};
    const result = await composition.next(f.subject, scenario === "no_explicit_priority" ? undefined : urgent);
    expect(result).toMatchObject({status: scenario === "inaccessible" ? "prepare_authority" : "more"});
    if (["resolved", "changed_revision", "changed_room", "changed_message", "no_explicit_priority"].includes(scenario)) {
      expect(result).toHaveProperty("resolvedSelection", {roomId: f.row.sourceRoomId,
        messageId: f.row.messageId, revision: f.row.revision});
    } else expect(result).not.toHaveProperty("resolvedSelection");
    expect(f.events).toEqual([]);
  });


test.each(["verify", "resolved"] as const)("parent history can prioritize its Subthread row: %s", async state => {
  const f = fixture();
  const parentRoomId = f.row.sessionRoomId, childRoomId = id(98);
  Object.assign(f.row, {sourceRoomId: childRoomId, subthreadRoomId: childRoomId});
  if (state === "resolved") Object.assign(f.row.lifecycle!, {parityStatus: "client_verified"});
  let installed: MessageBackfillClaim | null = null;
  const scan = {
    select: async (input: {urgentMessageId?: number}) => {
      expect(input.urgentMessageId).toBe(f.row.messageId);
      return state === "resolved" ? {status: "priority_resolved", candidate: f.row}
        : {status: "candidate", candidate: f.row, action: "verify", cursor: 0, urgent: true};
    },
    install: async (input: {claim: MessageBackfillClaim}) => {installed = input.claim; return true;},
  };
  const composition = createProductionMessageBackfillComposition({...f.dependencies,
    context: async subject => ({...await f.dependencies.context!(subject), scan}) as never,
  });
  const result = await composition.next(f.subject, {roomId: parentRoomId, messageId: f.row.messageId, revision: f.row.revision});
  if (state === "resolved") expect(result).toHaveProperty("resolvedSelection", {
    roomId: childRoomId, messageId: f.row.messageId, revision: f.row.revision});
  else {
    expect(result).toMatchObject({status: "claimed", claim: {coordinate: {roomId: childRoomId}}});
    expect(installed).toMatchObject({coordinate: {roomId: childRoomId}});
  }
  expect(f.events).toEqual([]);
});
