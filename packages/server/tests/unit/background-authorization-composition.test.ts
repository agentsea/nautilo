import {describe, expect, test} from "bun:test";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  domainForegroundNamespaceBindingSetDigest,
  humanId,
  mintDomainForegroundAuthorization,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {createBackgroundAuthorizationResponseV2, encodeBackgroundWorkDescriptorV2,
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  createTaskRuntimeSignerAuthorizationV1,
  createTaskRuntimeSignerAuthorizationV2,
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type BackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {parseDomainForegroundAuthorizationPlanV2,
  agentRuntimeObjectSignerKeyIdV1,
  serializeDomainForegroundAuthorizationV2} from "@nautilo/lattice-crypto/wire";
import {bytesToHex} from "@noble/hashes/utils.js";
import {createProductionBackgroundAuthorizationComposition} from "../../src/routes/background-authorization-composition";
import type {BackgroundAuthorizationDeviceSubject} from "../../src/routes/background-authorization";
import type {BackgroundAuthorizationRepository, BackgroundAuthorizationTaskRuntimeRecordV3} from "@nautilo/runtime";

type Dependencies = Required<NonNullable<Parameters<typeof createProductionBackgroundAuthorizationComposition>[0]>>;
async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const now = 1_700_000_000_000;
  const device = {userId: "user-1", humanActorId: "human-1", deviceId: "device-1", deviceGeneration: 2,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1", lineageGeneration: 3, epoch: 4,
    securityRevision: 5, headDigest: new Uint8Array(32).fill(8), signingPublicKey: signing.publicKey};
  const subject: BackgroundAuthorizationDeviceSubject = {...device, admission: {...device, expiresAt: now + 60_000}};
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {formatVersion: 2, requestId: "request-1", recipientGeneration: 0,
    workId: "work-1", workKind: "stenographer.extraction", anchorNamespaceId: "namespace-1", anchorDomainId: "domain-1",
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, operations: ["decrypt", "encrypt"],
    purpose: "journal.extract", authority: {serverId: "https://nautilo.example", roomId: "room-1", namespaceId: "namespace-1",
      namespaceAccessRevision: 2, namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32).fill(1),
      domainId: "domain-1", domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32).fill(2),
      bundleRevision: 5, bundleDigest: new Uint8Array(32).fill(3)}, policyRevision: 6,
    source: {kind: "stenographer_work", startSequence: 10, endSequence: 12, rebuildGeneration: 0, fingerprint: new Uint8Array(32).fill(4)},
    inputBindings: [{objectId: "message-10", namespaceId: "namespace-1"}],
    outputSlots: [{objectId: "record-1", objectType: "nautilo.reflection.record.v1", createdAt: now, namespaceIds: ["namespace-1"]}],
    maximumPlaintextBytes: 1_024, maximumCiphertextBytes: 4_096, recipientKeyId: "recipient-1", recipientPublicKey: recipient.publicKey,
    issuedAt: now, notBefore: now, expiresAt: now + 60_000, idempotencyId: "attempt-1"};
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {credentialId: "credential-1", descriptorBytes,
    issuer: {humanId: device.humanActorId, deviceId: device.deviceId, deviceGeneration: device.deviceGeneration,
      serverInstanceId: device.serverInstanceId, lineageGeneration: device.lineageGeneration, epoch: device.epoch,
      securityRevision: device.securityRevision, headDigest: device.headDigest, signingPublicKeyHash: crypto.hash(signing.publicKey)},
    issuerSigningPrivateKey: signing.privateKey, domainKey: crypto.randomBytes(32)});
  signing.privateKey.fill(0); recipient.privateKey.fill(0);
  const pages: unknown[] = [];
  const accepted: unknown[] = [];
  const routed: unknown[] = [];
  let allow = true;
  let live = true;
  let pageNumber = 0;
  const connection = {query: async () => []};
  const service = createProductionBackgroundAuthorizationComposition({crypto, now: () => now, serverScope: descriptor.authority.serverId,
    restricted: (() => connection) as unknown as Dependencies["restricted"],
    context: (async () => ({canonicalRunner: {}})) as unknown as Dependencies["context"],
    currentDevice: async () => live ? {...device, headDigest: device.headDigest.slice(), signingPublicKey: signing.publicKey.slice()} : null,
    withAuthority: (async (input: Parameters<NonNullable<Dependencies["withAuthority"]>>[0]) => {
      routed.push(input.descriptor.requestId);
      if (!allow) return null;
      return input.use({device} as Parameters<typeof input.use>[0], connection as unknown as Parameters<typeof input.use>[1],
        connection as unknown as Parameters<typeof input.use>[2]);
    }) as Dependencies["withAuthority"],
    repository: (async () => ({
      listAwaitingTaskRuntimeRecipientPage: async () => {throw new Error("binder absent");},
      listAwaitingDevicePage: async (input: unknown) => {
        pages.push(input);
        return {records: [{snapshot: {formatVersion: 2, credentialSubject: {kind: "processor"}}, descriptorBytes: descriptorBytes.slice()}],
          continuation: pageNumber++ === 0 ? {updatedAt: now - 1, requestId: "request-1"} : null};
      },
      acceptVerifiedResponse: async (input: unknown) => {accepted.push(structuredClone(input)); return {status: "accepted"};},
    })) as unknown as Dependencies["repository"],
  });
  return {service, subject, descriptorBytes, responseBytes, pages, accepted, routed,
    allow(value: boolean) {allow = value;}, live(value: boolean) {live = value;}};
}

describe("production background authorization composition", () => {
  test("filters with current Lattice authority and advances through an empty eligible page", async () => {
    const f = await fixture(); f.allow(false);
    const first = await f.service.list(f.subject, {});
    expect(first.requests).toEqual([]); expect(first.continuation).toBeString();
    f.allow(true);
    const second = await f.service.list(f.subject, {continuation: first.continuation!});
    expect(second.requests[0]?.requestBytes).toEqual(f.descriptorBytes);
    expect(second.continuation).toBeUndefined();
    expect(f.pages[1]).toMatchObject({after: {updatedAt: 1_699_999_999_999, requestId: "request-1"}, throughUpdatedAt: 1_700_000_000_000});
    expect(f.routed).toEqual(["request-1", "request-1"]);
  });
  test("rejects revoked admission and forged continuation before disclosure", async () => {
    const f = await fixture(); f.live(false);
    expect(f.service.list(f.subject, {})).rejects.toMatchObject({status: "unauthorized"});
    expect(f.pages).toHaveLength(0);
    f.live(true);
    for (const cursor of ["=", Buffer.from(JSON.stringify({v: 1, through: 1, updated: 1, id: "request-1", extra: true})).toString("base64url")]) {
      expect(f.service.list(f.subject, {continuation: cursor})).rejects.toMatchObject({status: "malformed"});
    }
    expect(f.pages).toHaveLength(0);
  });
  test("verifies real signed response under current authority before durable acceptance", async () => {
    const f = await fixture();
    expect(await f.service.respond(f.subject, {responseBytes: f.responseBytes})).toEqual({status: "accepted"});
    expect(f.accepted[0]).toMatchObject({response: {formatVersion: 2, kind: "processor", descriptor: {requestId: "request-1"}}});
    expect(f.responseBytes.some(byte => byte !== 0)).toBe(true);
    f.allow(false);
    expect(await f.service.respond(f.subject, {responseBytes: f.responseBytes})).toEqual({status: "stale"});
    expect(f.accepted).toHaveLength(1);
  });
  test("rejects another Human and signature tampering without acceptance", async () => {
    const f = await fixture();
    expect(f.service.respond({...f.subject, humanActorId: "other"}, {responseBytes: f.responseBytes}))
      .rejects.toMatchObject({status: "unauthorized"});
    const changed = f.responseBytes.slice(); changed[changed.length - 1]! ^= 1;
    expect(f.service.respond(f.subject, {responseBytes: changed})).rejects.toMatchObject({status: "malformed"});
    expect(f.accepted).toHaveLength(0);
  });
});

function taskRecord(requestId: string, updatedAt: number, descriptorBytes: Uint8Array | null):
BackgroundAuthorizationTaskRuntimeRecordV3 {
  return {
    snapshot: {formatVersion: 3, credentialSubject: {kind: "runtime", runtimeKind: "task", runtimeVersion: 1},
      requestId, updatedAt, recipientGeneration: 1, workId: `work:${requestId}`,
      recipient: descriptorBytes === null ? null : {recipientKeyId: `key:${requestId}`,
        recipientPublicKey: "public-key", expiresAt: updatedAt + 60_000}},
    descriptorBytes, workKind: "task.execute", purpose: "task.execute",
    expectedPolicyRevision: 1, expectedDomainEpoch: 1,
    authoritySet: {namespaceRequirements: [], domainRequirements: []},
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
}

test("only the authenticated device that wins Task recipient binding receives the request", async () => {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const now = 1_900_000_000_000;
  const base = {humanActorId: "human:requestor", deviceGeneration: 1,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1", lineageGeneration: 1,
    epoch: 1, securityRevision: 1, headDigest: new Uint8Array(32), signingPublicKey: signing.publicKey};
  const subject = (userId: string, deviceId: string): BackgroundAuthorizationDeviceSubject => ({
    userId, humanActorId: base.humanActorId, deviceId,
    admission: {...base, deviceId, expiresAt: now + 60_000},
  });
  const unbound = taskRecord("request:unbound", now - 10, null);
  const requestBytes = new Uint8Array([1, 2, 3]);
  let winner: string | null = null;
  const boundSubjects: string[] = [];
  const connection = {query: async () => []};
  const service = createProductionBackgroundAuthorizationComposition({
    crypto, now: () => now,
    context: (async () => ({canonicalRunner: {}})) as unknown as Dependencies["context"],
    restricted: (() => connection) as unknown as Dependencies["restricted"],
    currentDevice: async (_restricted, current) => ({...base, userId: current.userId,
      humanActorId: current.humanActorId, deviceId: current.deviceId}),
    repository: (async () => ({
      listAwaitingDevicePage: async () => ({records: [], continuation: null}),
      listAwaitingTaskRuntimeRecipientPage: async () => ({records: [unbound], continuation: null}),
    })) as unknown as Dependencies["repository"],
    bindTaskRecipient: async input => {
      boundSubjects.push(`${input.subject.userId}/${input.device.deviceId}`);
      if (input.subject.userId !== "user:requestor" || winner !== null) return null;
      winner = input.device.deviceId;
      return {record: taskRecord(unbound.snapshot.requestId, unbound.snapshot.updatedAt, requestBytes.slice()),
        requestBytes: requestBytes.slice()};
    },
    withTaskAuthority: (async input => input.record.snapshot.recipient === null ? null : input.use(
      {} as never, {} as never, [] as never, {} as never, connection as never,
    )) as Dependencies["withTaskAuthority"],
  });
  const [first, second] = await Promise.all([
    service.list(subject("user:requestor", "device:first"), {}),
    service.list(subject("user:requestor", "device:second"), {}),
  ]);
  const outsider = await service.list(subject("user:other", "device:other"), {});
  expect(first.requests.length + second.requests.length).toBe(1);
  expect([...first.requests, ...second.requests]).toEqual([{requestBytes}]);
  expect(outsider.requests).toEqual([]);
  expect(["device:first", "device:second"]).toContain(String(winner));
  expect(boundSubjects.sort()).toEqual([
    "user:other/device:other", "user:requestor/device:first", "user:requestor/device:second",
  ]);
  signing.privateKey.fill(0);
});

test("mixed Task discovery advances only through the earliest source and never skips byte-deferred rows", async () => {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const now = 2_000_000_000_000;
  const device = {userId: "user:paging", humanActorId: "human:paging", deviceId: "device:paging", deviceGeneration: 1,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1", lineageGeneration: 1, epoch: 1,
    securityRevision: 1, headDigest: new Uint8Array(32), signingPublicKey: signing.publicKey};
  const subject: BackgroundAuthorizationDeviceSubject = {...device, admission: {...device, expiresAt: now + 60_000}};
  const connection = {query: async () => []};
  let largeBytes = new Uint8Array();
  const deviceRows = [taskRecord("request:20", now - 80, new Uint8Array()),
    taskRecord("request:40", now - 60, new Uint8Array())];
  const recipientRows = [taskRecord("request:10", now - 90, null), taskRecord("request:30", now - 70, null)];
  const bytesFor = (requestId: string) => {
    const bytes = largeBytes.slice();
    bytes[0] = Number(requestId.slice(requestId.lastIndexOf(":") + 1));
    return bytes;
  };
  const nextPage = (rows: readonly BackgroundAuthorizationTaskRuntimeRecordV3[], after?: Readonly<{updatedAt: number; requestId: string}>) => {
    const remaining = rows.filter(row => after === undefined
      || row.snapshot.updatedAt > after.updatedAt
      || (row.snapshot.updatedAt === after.updatedAt && row.snapshot.requestId > after.requestId));
    const record = remaining[0];
    return {records: record === undefined ? [] : [record],
      continuation: remaining.length > 1 && record !== undefined
        ? {updatedAt: record.snapshot.updatedAt, requestId: record.snapshot.requestId} : null};
  };
  const service = createProductionBackgroundAuthorizationComposition({
    crypto, now: () => now,
    context: (async () => ({canonicalRunner: {}})) as unknown as Dependencies["context"],
    restricted: (() => connection) as unknown as Dependencies["restricted"],
    currentDevice: async () => ({...device, signingPublicKey: signing.publicKey.slice()}),
    repository: (async () => ({
      listAwaitingDevicePage: async (input: Parameters<BackgroundAuthorizationRepository["listAwaitingDevicePage"]>[0]) => {
        const page = nextPage(deviceRows, input.after);
        return {records: page.records.map(record => ({...record, descriptorBytes: bytesFor(record.snapshot.requestId)})),
          continuation: page.continuation};
      },
      listAwaitingTaskRuntimeRecipientPage: async (input: Parameters<NonNullable<
        BackgroundAuthorizationRepository["listAwaitingTaskRuntimeRecipientPage"]>>[0]) => nextPage(recipientRows, input.after),
    })) as unknown as Dependencies["repository"],
    bindTaskRecipient: async input => ({
      record: {...input.record, descriptorBytes: bytesFor(input.record.snapshot.requestId),
        snapshot: {...input.record.snapshot, recipient: {recipientKeyId: `key:${input.record.snapshot.requestId}`,
          recipientPublicKey: "public-key", expiresAt: now + 60_000}}},
      requestBytes: bytesFor(input.record.snapshot.requestId),
    }),
    withTaskAuthority: (async input => input.use(
      {} as never, {} as never, [] as never, {} as never, connection as never,
    )) as Dependencies["withTaskAuthority"],
  });
  largeBytes = new Uint8Array(Math.floor(service.limits.requestPageBytes * 0.6)).fill(7);
  const returned: number[] = [];
  let continuation: string | undefined;
  for (let index = 0; index < 4; index++) {
    const page = await service.list(subject, continuation === undefined ? {} : {continuation});
    expect(page.requests).toHaveLength(1);
    returned.push(page.requests[0]!.requestBytes[0]!);
    continuation = page.continuation;
  }
  expect(returned).toEqual([10, 20, 30, 40]);
  expect(continuation).toBeUndefined();
  signing.privateKey.fill(0);
});

test.each(["task.dispatch", "task.cancel_result", "task.deliver_message"] as const)("accepts exact signed %s response and wakes awaiting work", async workKind => {
  const operations = ["task.cancel_result", "task.deliver_message"].includes(workKind)
    ? ["encrypt"] as const : ["decrypt", "encrypt"] as const;
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const now = 1_800_000_000_000;
  const domain: DomainForegroundAuthorityEntry = {
    domainId: "domain:task", sourceNamespaceId: "namespace:task",
    participantDigest: new Uint8Array(32).fill(1), participantCount: 1,
    keyClass: "ai", domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(4),
    headDigest: new Uint8Array(32).fill(2),
    activeNamespaceBindingSetDigest: domainForegroundNamespaceBindingSetDigest(
      crypto, [{namespaceId: "namespace:task", bindingDigest: new Uint8Array(32).fill(3)}],
    ),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "request:task", policyRevision: 8,
    sessionId: "episode:task", roomId: "room:task",
    subjectHumanId: humanId("human:task"),
    committerDeviceId: cryptoDeviceId("device:task"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1, recipientKeyId: "recipient:task",
    operations, issuedAt: now,
    deadlineAt: now + 60_000, maximumSecretBytes: 4_096,
    domains: [domain],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId, workId: "run:task",
    workKind, workPurpose: workKind,
    recipientGeneration: 1, episodeId: plan.sessionId,
    sourceRoomId: plan.roomId, recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey, authorizationPlan: plan,
    issuedAt: plan.issuedAt, deadlineAt: plan.deadlineAt,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  const expectedRequestBytes = Uint8Array.from(requestBytes);
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan,
    domains: [{...domain, domainKey: new Uint8Array(32).fill(7)}],
    committerDeviceSigningPrivateKey: signing.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const responseBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const device = {userId: "user:task", humanActorId: plan.subjectHumanId,
    deviceId: plan.committerDeviceId, deviceGeneration: 2,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1",
    lineageGeneration: 3, epoch: 4, securityRevision: 5,
    headDigest: new Uint8Array(32).fill(8), signingPublicKey: signing.publicKey};
  const subject: BackgroundAuthorizationDeviceSubject = {
    userId: device.userId, humanActorId: device.humanActorId,
    deviceId: device.deviceId, admission: {...device, expiresAt: now + 60_000},
  };
  const record = {
    snapshot: {formatVersion: 3, credentialSubject: {kind: "runtime", runtimeKind: "task", runtimeVersion: 1},
      requestId: request.requestId, updatedAt: now, recipientGeneration: 1,
      workId: request.workId, recipient: {recipientKeyId: request.recipientKeyId,
        recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
        expiresAt: request.deadlineAt}},
    descriptorBytes: requestBytes, workKind: request.workKind,
    purpose: request.workPurpose, expectedPolicyRevision: plan.policyRevision,
    authoritySet: {namespaceRequirements: [{ordinal: 0,
      namespaceId: "namespace:task", domainId: domain.domainId,
      operations, expectedAccessRevision: 1,
      expectedPolicyRevision: plan.policyRevision}],
      domainRequirements: [{ordinal: 0, domainId: domain.domainId,
        expectedEpoch: domain.domainKeyGeneration,
        expectedAuthorizationRevision: domain.authorizationRevision}]},
  };
  let wakes = 0;
  const accepted: unknown[] = [];
  const connection = {query: async () => []};
  const service = createProductionBackgroundAuthorizationComposition({
    crypto, now: () => now,
    context: (async () => ({canonicalRunner: {}})) as unknown as Dependencies["context"],
    restricted: (() => connection) as unknown as Dependencies["restricted"],
    currentDevice: async () => ({...device, signingPublicKey: signing.publicKey.slice()}),
    repository: (async () => ({
      get: async () => structuredClone(record),
      listAwaitingDevicePage: async () => ({records: [structuredClone(record)], continuation: null}),
      acceptVerifiedResponse: async (input: unknown) => {accepted.push(structuredClone(input)); return {status: "accepted"};},
    })) as unknown as Dependencies["repository"],
    withTaskAuthority: (async input => {
      const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV1(record.descriptorBytes);
      const currentPlan = parseDomainForegroundAuthorizationPlanV2(decoded!.authorizationPlanBytes);
      return input.use(decoded!, currentPlan!, currentPlan!.domains,
        device, connection as unknown as Parameters<typeof input.use>[4]);
    }) as Dependencies["withTaskAuthority"],
    wakeProtectedTask: () => {wakes++;},
  });
  expect((await service.list(subject, {})).requests[0]?.requestBytes).toEqual(expectedRequestBytes);
  expect(await service.respond(subject, {responseBytes})).toEqual({status: "accepted"});
  expect(accepted[0]).toMatchObject({response: {kind: "runtime", formatVersion: 3,
    requestId: request.requestId, workId: request.workId}});
  expect(wakes).toBe(1);
  const tampered = Uint8Array.from(responseBytes);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  expect(service.respond(subject, {responseBytes: tampered}))
    .rejects.toMatchObject({status: "malformed"});
  expect(accepted).toHaveLength(1);
});

test.each([
  ["task.execute", 1],
  ["task.approval_resume", 2],
  ["task.await_reply_resume", 3],
] as const)(
  "accepts a certified %s Task response and rejects substituted signed facts",
  async (workKind, executionSegment) => {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const now = 1_800_000_000_000;
  const taskId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const domain: DomainForegroundAuthorityEntry = {
    domainId: "domain:task", sourceNamespaceId: "namespace:task",
    participantDigest: new Uint8Array(32).fill(1), participantCount: 1,
    keyClass: "ai", domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(4),
    headDigest: new Uint8Array(32).fill(2),
    activeNamespaceBindingSetDigest: domainForegroundNamespaceBindingSetDigest(
      crypto,
      [{namespaceId: "namespace:task", bindingDigest: new Uint8Array(32).fill(3)}],
    ),
    activeNamespaceBindingCount: 1,
  };
  const device = {userId: "user:task", humanActorId: "human:task",
    deviceId: "device:task", deviceGeneration: 2,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1",
    lineageGeneration: 3, epoch: 4, securityRevision: 5,
    headDigest: new Uint8Array(32).fill(8), signingPublicKey: signing.publicKey};
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "request:task-v2", policyRevision: 8,
    sessionId: `task-run:${runId}`, roomId: "room:task",
    subjectHumanId: humanId(device.humanActorId),
    committerDeviceId: cryptoDeviceId(device.deviceId),
    committerDeviceSigningGeneration: device.deviceGeneration,
    hostAuthorizationRevision: authorizationRevision(device.securityRevision),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0, recipientKeyId: "recipient:task-v2",
    operations: ["decrypt", "encrypt"], issuedAt: now,
    deadlineAt: now + 60_000, maximumSecretBytes: 4_096,
    domains: [domain],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId, workId: runId,
    workKind, workPurpose: workKind,
    recipientGeneration: 0, episodeId: plan.sessionId,
    sourceRoomId: plan.roomId, recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey, authorizationPlan: plan,
    issuedAt: plan.issuedAt, deadlineAt: plan.deadlineAt,
  });
  const resultDigest = crypto.hash(new TextEncoder().encode(
    `nautilo/task-run-result-crypto-object/v1\n${taskId}\n${runId}\n1`,
  ));
  const workIdentityHash = new Uint8Array(32).fill(9);
  const request = createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
    baseRequest,
    work: {taskId, taskRunId: runId,
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: `task-run-result:v1:${bytesToHex(resultDigest)}`,
      executionSegment, workIdentityHash},
    signer: {agentId: "agent:task", runtimeGeneration: 0,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
      signerPublicKey: signer.publicKey},
    deviceGroupHead: {serverInstanceId: device.serverInstanceId,
      lineageGeneration: device.lineageGeneration, epoch: device.epoch,
      headDigest: device.headDigest,
      signingPublicKeyHash: crypto.hash(device.signingPublicKey)},
    namespaceRequirements: [{ordinal: 0, namespaceId: "namespace:task",
      domainId: domain.domainId, operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 1, expectedPolicyRevision: plan.policyRevision}],
  });
  resultDigest.fill(0);
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
    crypto,
    request,
  );
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan, domains: [{...domain, domainKey: new Uint8Array(32).fill(7)}],
    committerDeviceSigningPrivateKey: signing.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const authorizationHash = crypto.hash(authorizationBytes);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV1(crypto, {
    requestBytes, authorizationBytes,
    expectedAuthorizationPlanBytes: baseRequest.authorizationPlanBytes,
    expectedAuthorizationHash: authorizationHash,
    issuerSigningPrivateKey: signing.privateKey,
  });
  const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
    authorizationBytes,
    certificateBytes,
  });
  const subject: BackgroundAuthorizationDeviceSubject = {
    userId: device.userId, humanActorId: device.humanActorId,
    deviceId: device.deviceId, admission: {...device, expiresAt: now + 60_000},
  };
  const record = {
    snapshot: {formatVersion: 3, credentialSubject: {kind: "runtime", runtimeKind: "task", runtimeVersion: 1},
      requestId: baseRequest.requestId, updatedAt: now, recipientGeneration: 0,
      workId: runId, recipient: {recipientKeyId: baseRequest.recipientKeyId,
        recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
        expiresAt: baseRequest.deadlineAt}},
    descriptorBytes: requestBytes, workIdentityHash,
    workKind, purpose: workKind,
    expectedPolicyRevision: plan.policyRevision,
    authoritySet: {namespaceRequirements: request.namespaceRequirements,
      domainRequirements: [{ordinal: 0, domainId: domain.domainId,
        expectedEpoch: domain.domainKeyGeneration,
        expectedAuthorizationRevision: domain.authorizationRevision}]},
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  let currentHead = device.headDigest.slice();
  let currentRecord = structuredClone(record);
  const accepted: unknown[] = [];
  const connection = {query: async () => []};
  const service = createProductionBackgroundAuthorizationComposition({
    crypto, now: () => now,
    context: (async () => ({canonicalRunner: {}})) as unknown as Dependencies["context"],
    restricted: (() => connection) as unknown as Dependencies["restricted"],
    repository: (async () => ({get: async () => structuredClone(currentRecord),
      listAwaitingDevicePage: async () => ({records: [], continuation: null}),
      acceptVerifiedResponse: async (input: unknown) => {
        accepted.push(structuredClone(input));
        return {status: "accepted"};
      }})) as unknown as Dependencies["repository"],
    withTaskAuthority: (async input => {
      const base = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
        crypto,
        input.record.descriptorBytes!,
      )!;
      if (input.record.workKind !== base.workKind
        || input.record.purpose !== base.workPurpose) return null;
      const currentPlan = parseDomainForegroundAuthorizationPlanV2(
        base.authorizationPlanBytes,
      )!;
      return input.use(base, currentPlan, currentPlan.domains,
        {...device, headDigest: currentHead},
        connection as unknown as Parameters<typeof input.use>[4]);
    }) as Dependencies["withTaskAuthority"],
    wakeProtectedTask: () => undefined,
  });
  expect(await service.respond(subject, {responseBytes}))
    .toEqual({status: "accepted"});
  expect(accepted[0]).toMatchObject({response: {kind: "runtime",
    formatVersion: 4, responseBytes, authorizationBytes, certificateBytes,
    authorizationHash}});

  currentRecord = {...structuredClone(record),
    workKind: "task.execute", purpose: "task.execute"};
  if (workKind === "task.execute") {
    currentRecord = {...structuredClone(record),
      workKind: "task.approval_resume", purpose: "task.approval_resume"};
  }
  expect(await service.respond(subject, {responseBytes}))
    .toEqual({status: "stale"});

  currentRecord = {...structuredClone(record), workIdentityHash: new Uint8Array(32).fill(10)};
  await Promise.resolve(expect(service.respond(subject, {responseBytes}))
    .rejects.toMatchObject({status: "malformed"}));

  const substitutedWorkIdentityHash = new Uint8Array(32).fill(10);
  const substitutedRequest = createTaskRuntimeBackgroundAuthorizationRequestV2(
    crypto,
    {
      baseRequest: request.baseRequest,
      work: {...request.work, workIdentityHash: substitutedWorkIdentityHash},
      signer: request.signer,
      deviceGroupHead: request.deviceGroupHead,
      namespaceRequirements: request.namespaceRequirements,
    },
  );
  const substitutedRequestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
    crypto,
    substitutedRequest,
  );
  currentRecord = {...structuredClone(record),
    descriptorBytes: substitutedRequestBytes,
    workIdentityHash: substitutedWorkIdentityHash};
  await Promise.resolve(expect(service.respond(subject, {responseBytes}))
    .rejects.toMatchObject({status: "malformed"}));
  substitutedRequestBytes.fill(0);
  substitutedWorkIdentityHash.fill(0);
  destroyTaskRuntimeBackgroundAuthorizationRequestV2(substitutedRequest);

  currentRecord = structuredClone(record);
  currentHead = new Uint8Array(32).fill(10);
  await Promise.resolve(expect(service.respond(subject, {responseBytes}))
    .rejects.toMatchObject({status: "malformed"}));
  expect(accepted).toHaveLength(1);
});

test("accepts an exact certified publication response and rejects a changed work binding", async () => {
  const crypto = new LatticeCrypto();
  const deviceSigning = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const now = 1_800_100_000_000;
  const taskId = "31111111-1111-4111-8111-111111111111";
  const runId = "32222222-2222-4222-8222-222222222222";
  const domain: DomainForegroundAuthorityEntry = {
    domainId: "domain:publication", sourceNamespaceId: "namespace:publication",
    participantDigest: new Uint8Array(32).fill(1), participantCount: 1,
    keyClass: "ai", domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(4),
    headDigest: new Uint8Array(32).fill(2),
    activeNamespaceBindingSetDigest: domainForegroundNamespaceBindingSetDigest(
      crypto,
      [{namespaceId: "namespace:publication", bindingDigest: new Uint8Array(32).fill(3)}],
    ),
    activeNamespaceBindingCount: 1,
  };
  const device = {userId: "user:publication", humanActorId: "human:publication",
    deviceId: "device:publication", deviceGeneration: 2,
    serverInstanceId: "38c858cc-f359-48ad-8de6-341f61fb92a1",
    lineageGeneration: 3, epoch: 4, securityRevision: 5,
    headDigest: new Uint8Array(32).fill(8),
    signingPublicKey: deviceSigning.publicKey};
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "request:publication", policyRevision: 8,
    sessionId: `task-run:${runId}`, roomId: "room:publication",
    subjectHumanId: humanId(device.humanActorId),
    committerDeviceId: cryptoDeviceId(device.deviceId),
    committerDeviceSigningGeneration: device.deviceGeneration,
    hostAuthorizationRevision: authorizationRevision(device.securityRevision),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0, recipientKeyId: "recipient:publication",
    operations: ["encrypt"], issuedAt: now, deadlineAt: now + 60_000,
    maximumSecretBytes: 4_096, domains: [domain],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId, workId: runId,
    workKind: "task.cancel_result", workPurpose: "task.cancel_result",
    recipientGeneration: 0, episodeId: plan.sessionId,
    sourceRoomId: plan.roomId, recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey, authorizationPlan: plan,
    issuedAt: plan.issuedAt, deadlineAt: plan.deadlineAt,
  });
  const workIdentityHash = new Uint8Array(32).fill(9);
  const namespaceRequirements = [{ordinal: 0,
    namespaceId: "namespace:publication", domainId: domain.domainId,
    operations: ["encrypt"] as const, expectedAccessRevision: 1,
    expectedPolicyRevision: plan.policyRevision}];
  const request = createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
    baseRequest,
    work: {kind: "task.cancel_result", taskId, taskRunId: runId,
      contentRevision: 2, workIdentityHash},
    signer: {agentId: "agent:publication", runtimeGeneration: 0,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
      signerPublicKey: signer.publicKey},
    deviceGroupHead: {serverInstanceId: device.serverInstanceId,
      lineageGeneration: device.lineageGeneration, epoch: device.epoch,
      headDigest: device.headDigest,
      signingPublicKeyHash: crypto.hash(device.signingPublicKey)},
    namespaceRequirements,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request);
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan, domains: [{...domain, domainKey: new Uint8Array(32).fill(7)}],
    committerDeviceSigningPrivateKey: deviceSigning.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const authorizationHash = crypto.hash(authorizationBytes);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV2(crypto, {
    requestBytes, authorizationBytes,
    expectedAuthorizationPlanBytes: baseRequest.authorizationPlanBytes,
    expectedAuthorizationHash: authorizationHash,
    issuerSigningPrivateKey: deviceSigning.privateKey,
  });
  const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
    authorizationBytes, certificateBytes,
  });
  const record = {
    snapshot: {formatVersion: 3,
      credentialSubject: {kind: "runtime", runtimeKind: "task", runtimeVersion: 1},
      requestId: baseRequest.requestId, updatedAt: now, recipientGeneration: 0,
      workId: runId, recipient: {recipientKeyId: baseRequest.recipientKeyId,
        recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
        expiresAt: baseRequest.deadlineAt}},
    descriptorBytes: requestBytes, workIdentityHash,
    workKind: "task.cancel_result", purpose: "task.cancel_result",
    expectedPolicyRevision: plan.policyRevision,
    authoritySet: {namespaceRequirements,
      domainRequirements: [{ordinal: 0, domainId: domain.domainId,
        expectedEpoch: domain.domainKeyGeneration,
        expectedAuthorizationRevision: domain.authorizationRevision}]},
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  let currentRecord = structuredClone(record);
  const accepted: unknown[] = [];
  const connection = {query: async () => []};
  const service = createProductionBackgroundAuthorizationComposition({
    crypto, now: () => now,
    context: (async () => ({canonicalRunner: {}})) as unknown as Dependencies["context"],
    restricted: (() => connection) as unknown as Dependencies["restricted"],
    repository: (async () => ({get: async () => structuredClone(currentRecord),
      listAwaitingDevicePage: async () => ({records: [], continuation: null}),
      acceptVerifiedResponse: async (input: unknown) => {
        accepted.push(structuredClone(input)); return {status: "accepted"};
      }})) as unknown as Dependencies["repository"],
    withTaskAuthority: (async input => {
      const base = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
        crypto, input.record.descriptorBytes!,
      )!;
      const currentPlan = parseDomainForegroundAuthorizationPlanV2(
        base.authorizationPlanBytes,
      )!;
      return input.use(base, currentPlan, currentPlan.domains,
        device, connection as unknown as Parameters<typeof input.use>[4]);
    }) as Dependencies["withTaskAuthority"],
  });
  const subject: BackgroundAuthorizationDeviceSubject = {
    userId: device.userId, humanActorId: device.humanActorId,
    deviceId: device.deviceId, admission: {...device, expiresAt: now + 60_000},
  };
  expect(await service.respond(subject, {responseBytes})).toEqual({status: "accepted"});
  expect(accepted[0]).toMatchObject({response: {formatVersion: 4,
    workKind: "task.cancel_result", authorizationBytes, certificateBytes}});
  currentRecord = {...structuredClone(record),
    workIdentityHash: new Uint8Array(32).fill(10)};
  await Promise.resolve(expect(service.respond(subject, {responseBytes}))
    .rejects.toMatchObject({status: "malformed"}));
  expect(accepted).toHaveLength(1);
});
