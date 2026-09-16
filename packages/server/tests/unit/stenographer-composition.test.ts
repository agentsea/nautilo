import {describe, expect, test} from "bun:test";
import {drizzle} from "drizzle-orm/postgres-js";
import type {Sql} from "postgres";
import {classifyDataOperationFailure} from "@nautilo/lattice-bridge";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {createHmacProtectedStenographerRecordCommitmentPort} from "@nautilo/reflection-bridge/server";
import {type DirectDatabase, type PostgresJsBridgeConnection, type PostgresJsBridgeRow} from "@nautilo/db";
import {createProductionProtectedStenographerComposition, prepareCancelledStenographerFallback, assertStenographerNamespaceWaitingReason, cancelObsoleteStenographerReconciliations, refreshCurrentStenographerPlan} from "../../src/background/stenographer-composition";

import {createHumanProductTransactionContext} from "../../src/routes/human-message-product-store";

import {
  PostgresProtectedStenographerWorkRepository, InMemoryBackgroundAuthorizationRepository, createBackgroundAuthorizationRequestV2, ProtectedStenographerBackgroundCoordinator,
  createCurrentProtectedStenographerAuthorizationRecord, cancelBackgroundAuthorizationRequest,
  fingerprintProtectedStenographerSourceBindings, type ProtectedStenographerRecoveredWork,
  type BackgroundAuthorizationRecord, BackgroundAuthorizationProcessorCredentialClaimPort,
} from "@nautilo/runtime";
import {
  createBackgroundAuthorizationResponseV2, decodeBackgroundProcessorWorkDescriptorV2,
  verifyBackgroundAuthorizationResponseV2,
} from "@nautilo/lattice-crypto/background";
import {objectId, namespaceId, namespaceGeneration, accessRevision, unixTimestamp, encryptObjectPayload, wrapObjectDekForNamespace} from "@nautilo/lattice-crypto";

const ROOM = "11111111-1111-4111-8111-111111111111";
const NAMESPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-10T00:00:00.000Z");

async function rejects(work: Promise<unknown>, message: string): Promise<void> {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message).toContain(message);
}

async function fixture(options: {room?: boolean; queue?: boolean; queuePages?: boolean; duplicate?: boolean; rebuildTarget?: number; activeRequestId?: string; productWork?: boolean; terminalWork?: boolean; repairPages?: boolean} = {},
  dependencies: Parameters<typeof createProductionProtectedStenographerComposition>[1] = {},
  authorizationRequested?: NonNullable<Parameters<typeof createProductionProtectedStenographerComposition>[0]["authorizationRequested"]>) {
  const calls: {role: string; sql: string; parameters: readonly unknown[]}[] = [];
  const query = (role: string, sql: string, parameters: readonly unknown[] = []): readonly PostgresJsBridgeRow[] => {
    calls.push({role, sql, parameters});
    if (sql.includes("current_user::text")) return [{current_user: role, session_user: role}];
    if (sql.includes("set_config(")) return [];
    if (options.productWork) {
      if (options.terminalWork && sql.includes("SELECT extraction_failure_count")) return [{extraction_failure_count: 0}];
      if (options.terminalWork && sql.startsWith('update "room_journal_state"') && sql.includes("returning")) return [{room_id: ROOM}];
      if (options.terminalWork && (sql.startsWith('insert into "room_journal_batches"') || sql.startsWith('update "room_journal_batches"') && sql.includes("returning"))) return [{id: "44444444-4444-4444-8444-444444444444", attempt_count: 7, created_at: NOW.toISOString()}];
      if (sql.includes('"namespace_domain_key_heads"')) return [{namespace_id: NAMESPACE, namespace_access_revision: 2,
        namespace_current_generation: 1, domain_id: "domain-1", domain_key_generation: 3, domain_authorization_revision: 4,
        domain_head_digest: new Uint8Array(32).fill(3), bundle_revision: 5, retained_generation_count: 2,
        retained_authority_set_digest: new Uint8Array(32).fill(2), binding_digest: new Uint8Array(32).fill(4)}];
      if (sql.includes('from "room_journal_batches"')) return sql.startsWith('select "id" from')
        ? [{id: "44444444-4444-4444-8444-444444444444"}] : [{id: "44444444-4444-4444-8444-444444444444", room_id: ROOM,
          from_message_id_exclusive: 0, through_message_id_inclusive: 1, extractor_version: "m241-v1", lane: "live", status: "running",
          attempt_count: 1, created_at: NOW.toISOString()}];
      if (sql.includes('AS upper_bound_message_id')) return [{room_id: ROOM, namespace_id: NAMESPACE, owner_id: OWNER,
        room_kind: "private", suspended_at: null, has_agent: true, last_processed_message_id: 0,
        historical_backfill_status: "not_needed", historical_backfill_cursor_message_id: null, historical_backfill_target_message_id: null,
        lease_token: "66666666-6666-4666-8666-666666666666", lease_expires_at: options.terminalWork ? NOW : new Date(NOW.getTime() + 120_000),
        extraction_retry_after: null, extraction_failure_count: 0, rebuild_generation: 0, rebuild_requested_at: null,
        rebuild_target_message_id: null, upper_bound_message_id: 1, retry_fixed_range: true, prior_context_floor_message_id: 0,
        prior_context_limit: 0, compaction_due_at: null, compaction_lease_token: null, compaction_lease_expires_at: null,
        compaction_retry_after: null, compaction_failure_count: 0}];
      if (sql.includes('FROM sessions AS s') && sql.includes('ORDER BY sm.id')) return [{message_id: 1, edit_revision: 0,
        created_at: new Date(NOW.getTime() - 120_000), role: "user", fingerprint: null, transcript_origin: "main",
        originated_by: null, excluded_from_evidence: false, key_class: "ai", crypto_object_id: "input-1", crypto_completion: "complete",
        participant_id: "55555555-5555-4555-8555-555555555555"}];
    }
    if (options.repairPages && sql.includes('from "room_journal_batches"') && sql.includes('"completed_at"')) {
      const after = parameters.some(value => value instanceof Date || typeof value === "string" && value.includes("2026-09-10"));
      return after ? [] : Array.from({length: 257}, (_, index) => ({id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
        room_id: ROOM, namespace_id: NAMESPACE, ordinary_fallback_rebuild_generation: 4, completed_at: NOW.toISOString()}));
    }
    if (sql.includes("background_crypto_authorization_requests")) {
      if (options.repairPages && sql.includes('select "request_id"') && parameters.includes("stenographer.output_repair")) {
        return parameters.includes("repair-page-255") ? [] : Array.from({length: 256}, (_, index) => ({request_id: `repair-page-${String(index).padStart(3, "0")}`}));
      }
      if (sql.includes('select "request_id"') && parameters.includes("stenographer.publication_reconcile")) return [];
      if (sql.includes('select "request_id"')) return options.duplicate ? [{request_id: "one"}, {request_id: "two"}] : options.activeRequestId === undefined ? [] : [{request_id: options.activeRequestId}];
      if (options.queuePages) {
        const after = parameters.find((value) => typeof value === "string" && value.startsWith("request-page-"));
        return after === undefined
          ? Array.from({length: 256}, (_, index) => ({namespace_id: NAMESPACE, request_id: `request-page-${String(index).padStart(3, "0")}`}))
          : [{namespace_id: "later-namespace", request_id: "request-ready-later"}];
      }
      return options.queue ? [{namespace_id: NAMESPACE, request_id: "request-1"}] : [];
    }
    return [];
  };
  const unsafe = (sql: string, parameters: readonly unknown[] = []) => {
    const result = query("nautilo", sql, parameters);
    return Object.assign(Promise.resolve(result), {values: () => {
      if (options.productWork && sql.includes('from "encryption_transition_policy"')) {
        const row: Record<string, unknown> = {id: "server", mode: "shadow_encryption", shadow_behavior: "fallback", revision: 6,
          shadow_encryption_started_at: NOW.toISOString(), updated_at: NOW.toISOString(),
          observation_bounds_revision: 1, observation_bucket_width_ms: 3_600_000, observation_retention_ms: 2_592_000_000,
          observation_storage_limit_rows: 10_000, observation_latency_upper_bounds_ms: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
          observation_bounds_configured_at: NOW.toISOString(), created_at: NOW.toISOString()};
        const columns = sql.slice(0, sql.indexOf(' from ')).match(/"[^"]+"/g) ?? [];
        return Promise.resolve([columns.map(column => row[column.slice(1, -1)] ?? null)]);
      }
      if (sql.startsWith('select "id", "namespace_id", "owner_id" from "rooms"')) {
        return Promise.resolve(options.room ? [[ROOM, NAMESPACE, OWNER]] : []);
      }
      if (sql.startsWith('select "id" from "rooms"')) return Promise.resolve(options.queuePages ? [[ROOM], ["later-room"]] : options.queue ? [[ROOM]] : []);
      if (sql.startsWith('select "room_id", "rebuild_generation", "rebuild_target_message_id"')) {
        return Promise.resolve(options.rebuildTarget === undefined ? [] : [[ROOM, 3, options.rebuildTarget]]);
      }
      return Promise.resolve([]);
    }});
  };
  const transaction = Object.assign(() => undefined, {unsafe});
  const client = Object.assign(() => undefined, {unsafe, options: {parsers: {}, serializers: {}},
    begin: (callback: string | ((tx: typeof transaction) => Promise<unknown>), use?: (tx: typeof transaction) => Promise<unknown>) =>
      typeof callback === "function" ? callback(transaction) : use!(transaction)});
  const db = drizzle(client as unknown as Sql) as unknown as DirectDatabase;
  const executor: Pick<PostgresJsBridgeConnection, "query"> = {
    query: <Row extends PostgresJsBridgeRow>(sql: string, parameters: readonly unknown[] = []) =>
      Promise.resolve(query("nautilo_crypto", sql, parameters) as readonly Row[]),
  };
  const restricted: PostgresJsBridgeConnection = {...executor, transaction: (use) => use(executor), transactionOnce: (use) => use(executor)};
  const composition = await createProductionProtectedStenographerComposition({db, restricted, crypto: new LatticeCrypto(),
    serverScope: "server-scope", recordCommitment: createHmacProtectedStenographerRecordCommitmentPort(new Uint8Array(32).fill(7)),
    resolveModelId: () => "model-1", now: () => NOW,
    ...(authorizationRequested === undefined ? {} : {authorizationRequested})}, dependencies);
  return {composition, calls, db};
}

describe("production protected Stenographer composition boundaries", () => {
  test("an exact superseded execution remains terminal and records product failure without ordinary fallback or a fresh grant", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    let preparations = 0; let runs = 0;
    const f = await fixture({room: true, productWork: true, terminalWork: true}, {repository,
      coordinator: () => ({prepareRecipient: () => {preparations++; throw new Error("No new recipient");},
        run: () => {runs++; throw new Error("No replay");}})});
    try {
      const product = await createHumanProductTransactionContext(OWNER, f.db);
      const work = await new PostgresProtectedStenographerWorkRepository(product.handle).recoverExtraction({
        workId: "44444444-4444-4444-8444-444444444444", now: NOW});
      if (work.status !== "claimed") throw new Error(`Expected claimed fixture: ${work.status}`);
      const initial = createCurrentProtectedStenographerAuthorizationRecord({requestId: "terminal-request", work: {claim: work.claim, compactionModelId: null},
        now: NOW.getTime(), authority: {policyRevision: 6, namespace: {serverId: "server-scope", roomId: ROOM, namespaceId: NAMESPACE,
          namespaceAccessRevision: 2, namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32).fill(2), domainId: "domain-1",
          domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32).fill(3), bundleRevision: 5,
          bundleDigest: new Uint8Array(32).fill(4)}}});
      const terminal = {...initial, snapshot: cancelBackgroundAuthorizationRequest(initial.snapshot, "superseded", NOW.getTime()), finishedAt: NOW.getTime()};
      await repository.create(terminal);
      const prepared = await f.composition.adapter.prepareExtraction({roomId: ROOM, lane: "live", modelId: "model-1", now: NOW,
        signal: new AbortController().signal});
      expect(await prepared.publish({revalidationToken: 1})).toEqual({status: "failed", processed: true});
      expect(preparations).toBe(0); expect(runs).toBe(0);
      expect(await repository.get(terminal.snapshot.requestId)).toEqual(terminal);
      expect(f.calls.some(call => call.sql.startsWith('update "room_journal_batches"') && call.parameters.includes("failed"))).toBe(true);
      expect(f.calls.some(call => call.sql.startsWith('update "room_journal_state"') && call.sql.includes('"extraction_retry_after"'))).toBe(true);
    } finally {await f.composition.dispose();}
  });
  test("output repair is Dual-only, lazy, and bounded across queue and metadata pages", async () => {
    const f = await fixture({repairPages: true}, {repository: new InMemoryBackgroundAuthorizationRepository()});
    try {
      expect(f.composition.adapter.prepareNextOutputRepair).toBeUndefined();
      const repair = f.composition.dualAdapter.prepareNextOutputRepair!;
      for (let poll = 0; poll < 2; poll++) {
        const operation = await repair({now: NOW, signal: new AbortController().signal});
        expect(await operation.publish({revalidationToken: 1})).toEqual({status: "unavailable", processed: false});
      }
      const queue = f.calls.filter(call => call.role === "nautilo_crypto" && call.parameters.includes("stenographer.output_repair"));
      expect(queue).toHaveLength(2);
      expect(queue[1]!.parameters).toContain("repair-page-255");
      const discovery = f.calls.filter(call => call.sql.includes('from "room_journal_batches"') && call.sql.includes('"completed_at"'));
      expect(discovery).toHaveLength(2);
      expect(discovery[1]!.parameters).toContain("44444444-4444-4444-8444-000000000255");
      expect(f.calls.some(call => /insert|update|delete/i.test(call.sql))).toBe(false);
      expect(discovery.every(call => !call.sql.includes('"body"') && !call.sql.includes('"plaintext"'))).toBe(true);
      await f.composition.dispose();
      expect(() => repair({now: NOW, signal: new AbortController().signal})).toThrow("disposed");
    } finally {await f.composition.dispose();}
  });
  test("grant queue Rooms remain candidates when ordinary scans exclude their live product leases", async () => {
    const f = await fixture({queue: true});
    try {
      expect(await f.composition.candidates.extraction({lane: "live", now: NOW})).toEqual([ROOM]);
      expect(await f.composition.candidates.extraction({lane: "historical", now: NOW})).toEqual([ROOM]);
      expect(await f.composition.candidates.compaction({now: NOW})).toEqual([ROOM]);
      const queue = f.calls.filter((call) => call.sql.includes("background_crypto_authorization_requests"));
      expect(queue).toHaveLength(3);
      for (const call of queue) {
        expect(call.role).toBe("nautilo_crypto");
        expect(call.parameters).toContain("awaiting_device"); expect(call.parameters).toContain("grant_ready");
        expect(call.sql).not.toContain("descriptor_bytes"); expect(call.sql).not.toContain("accepted_response_bytes");
      }
    } finally {await f.composition.dispose();}
  });
  test("waiting requests cannot hide a later ready Room beyond the first queue page", async () => {
    const f = await fixture({queuePages: true});
    try {
      expect(await f.composition.candidates.extraction({lane: "live", now: NOW})).toEqual([ROOM, "later-room"]);
      const pages = f.calls.filter((call) => call.role === "nautilo_crypto" && call.sql.includes("background_crypto_authorization_requests"));
      expect(pages).toHaveLength(2);
      expect(pages[1]!.parameters).toContain("request-page-255");
      expect(pages.every((page) => page.sql.includes('"created_at" <=') && page.sql.includes('order by "background_crypto_authorization_requests"."request_id" asc'))).toBe(true);
    } finally {await f.composition.dispose();}
  });
  test("missing Rooms are unavailable without claiming a source or invoking a model", async () => {
    const f = await fixture();
    try {
      const prepared = await f.composition.adapter.prepareExtraction({roomId: ROOM, lane: "live", modelId: "model-1", now: NOW,
        signal: new AbortController().signal});
      expect(await prepared.publish({revalidationToken: 1})).toEqual({status: "unavailable", processed: false});
      expect(f.calls.some((call) => /insert|update|room_journal_batches/i.test(call.sql))).toBe(false);
    } finally {await f.composition.dispose();}
  });
  test("durable request discovery precedes product lease allocation and fails closed on duplicate work", async () => {
    const f = await fixture({room: true, duplicate: true});
    try {
      await rejects(f.composition.adapter.prepareExtraction({roomId: ROOM, lane: "live", modelId: "model-1", now: NOW,
        signal: new AbortController().signal}), "Multiple active");
      expect(f.calls.some((call) => call.sql.includes("background_crypto_authorization_requests"))).toBe(true);
      expect(f.calls.some((call) => /insert|update|room_journal_batches/i.test(call.sql))).toBe(false);
      expect(f.calls.some((call) => call.role === "nautilo" && call.sql.includes("set_config("))).toBe(true);
    } finally {await f.composition.dispose();}
  });
  test("a prepared rebuild target is returned without repeating cleanup or resetting the cursor", async () => {
    const f = await fixture({rebuildTarget: 123});
    try {
      const prepared = await f.composition.adapter.prepareNextRebuild({now: NOW, signal: new AbortController().signal});
      expect(await prepared.publish({revalidationToken: 1})).toEqual({status: "prepared_rebuild", processed: true, roomId: ROOM});
      expect(f.calls.some((call) => /insert|update|delete/i.test(call.sql))).toBe(false);
    } finally {await f.composition.dispose();}
  });
  test("the unmounted protected legacy authority reports no processed work and cannot starve compaction", async () => {
    const f = await fixture();
    const prepared = await f.composition.adapter.prepareLegacyConversion({now: NOW, signal: new AbortController().signal});
    expect(await prepared.publish({revalidationToken: 1})).toEqual({status: "unavailable", processed: false});
    await f.composition.dispose();
    expect(() => f.composition.adapter.prepareLegacyConversion({now: NOW, signal: new AbortController().signal})).toThrow("disposed");
  });
  test("an already cancelled attempt never loads metadata or allocates a lease", async () => {
    const f = await fixture(); const before = f.calls.length;
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await rejects(f.composition.adapter.prepareExtraction({roomId: ROOM, lane: "live", modelId: "model-1", now: NOW,
      signal: controller.signal}), "cancelled");
    expect(f.calls).toHaveLength(before);
    await f.composition.dispose();
  });
});


async function lifecycleFixture(blockModel = false) {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const namespaceKey = crypto.randomBytes(32);
  const repository = new InMemoryBackgroundAuthorizationRepository();
  let modelCalls = 0; let wakeCalls = 0; let published = 0; let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {markStarted = resolve;});
  const encrypted = encryptObjectPayload(crypto, {objectId: objectId("input-1"), objectType: "message", keyClass: "ai", createdAt: unixTimestamp(NOW.getTime())}, new Uint8Array([1]));
  const envelope = wrapObjectDekForNamespace(crypto, namespaceKey, {objectId: objectId("input-1"), namespaceId: namespaceId(NAMESPACE), keyClass: "ai",
    keyGeneration: namespaceGeneration(1), bindingRevisionAtWrap: accessRevision(2)}, encrypted.dek);
  encrypted.dek.fill(0);
  const f = await fixture({room: true, activeRequestId: "request-1", productWork: true}, {repository, coordinator: (options) =>
    new ProtectedStenographerBackgroundCoordinator({...options,
      transformMaterial: {loadAccepted: () => Promise.resolve({status: "loaded", material: {formatVersion: 2,
        claims: new BackgroundAuthorizationProcessorCredentialClaimPort(repository), resolveCurrentIssuer: () => device.publicKey,
        objects: {openInput: () => Promise.resolve({payload: encrypted.payload, envelope}),
          openPublishedOutput: () => Promise.reject(new Error("Empty output publication has no objects")),
          withNamespaceKey: (_request, use) => Promise.resolve(use(namespaceKey)),
          publishOutputs: async (request) => {await request.authorizeCommit(); published++;}},
      }})},
      execution: {reconcilePublication: () => Promise.resolve("completed"), executeWork: async ({record: running, capability}) => {
        expect(running.snapshot.state).toBe("running");
        await capability.openInputs(); modelCalls++; markStarted!();
        if (blockModel) await new Promise<never>(() => {});
        await capability.publishOutputs([]);
        return {status: "completed", outputCount: 0};
      }},
    })}, async (wake) => {
      const durable = await repository.get(wake.snapshot.requestId);
      expect(durable?.snapshot.state).toBe("awaiting_device");
      expect(durable?.descriptorBytes).toEqual(wake.descriptorBytes);
      expect(durable?.snapshot.descriptorDigest).toBe(wake.snapshot.descriptorDigest);
      wakeCalls++;
    });
  const product = await createHumanProductTransactionContext(OWNER, f.db);
  const recovered = await new PostgresProtectedStenographerWorkRepository(product.handle).recoverExtraction({
    workId: "44444444-4444-4444-8444-444444444444", now: NOW});
  if (recovered.status !== "claimed") throw new Error(`Fixture work recovery failed: ${JSON.stringify(recovered)}; ${JSON.stringify(f.calls.slice(-8))}`);
  const record = createCurrentProtectedStenographerAuthorizationRecord({requestId: "request-1", work: {claim: recovered.claim, compactionModelId: null},
    now: NOW.getTime(), authority: {policyRevision: 6, namespace: {serverId: "server-scope", roomId: ROOM, namespaceId: NAMESPACE,
      namespaceAccessRevision: 2, namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32).fill(2), domainId: "domain-1",
      domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32).fill(3), bundleRevision: 5,
      bundleDigest: new Uint8Array(32).fill(4)}}});
  await repository.create(record);
  const prepare = () => f.composition.adapter.prepareExtraction({roomId: ROOM, lane: "live", modelId: "model-1", now: NOW, signal: new AbortController().signal});
  const approve = async () => {
    const current = await repository.get("request-1");
    const descriptor = decodeBackgroundProcessorWorkDescriptorV2(current!.descriptorBytes!);
    const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {credentialId: "credential-1", descriptorBytes: current!.descriptorBytes!,
      issuer: {humanId: "human-1", deviceId: "device-1", deviceGeneration: 1, serverInstanceId: "instance-1", lineageGeneration: 1,
        epoch: 1, securityRevision: 1, headDigest: new Uint8Array(32).fill(7), signingPublicKeyHash: crypto.hash(device.publicKey)},
      issuerSigningPrivateKey: device.privateKey, domainKey: crypto.randomBytes(32)});
    const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {responseBytes, now: descriptor.issuedAt, resolveCurrentIssuer: () => device.publicKey});
    expect((await repository.acceptVerifiedResponse({response: {...verified, formatVersion: 2, kind: "processor"}, acceptedAt: NOW.getTime()})).status).toBe("accepted");
  };
  return {...f, repository, prepare, approve, started, counts: () => ({modelCalls, wakeCalls, published})};
}

describe("current grant factory lifecycle", () => {
  test("durable wake occurs once, accepted work stays lazy until publish, and a live recipient survives another poll", async () => {
    const f = await lifecycleFixture();
    try {
      await rejects(f.prepare(), "device");
      const first = await f.repository.get("request-1");
      await rejects(f.prepare(), "device");
      expect((await f.repository.get("request-1"))?.snapshot.recipientGeneration).toBe(first?.snapshot.recipientGeneration);
      expect((await f.repository.get("request-1"))?.descriptorBytes).toEqual(first?.descriptorBytes);
      expect(f.counts()).toEqual({wakeCalls: 1, modelCalls: 0, published: 0});
      await f.approve();
      const prepared = await f.prepare();
      expect(f.counts().modelCalls).toBe(0);
      expect(await prepared.publish({revalidationToken: 1})).toEqual({status: "completed", processed: true});
      expect(f.counts()).toEqual({wakeCalls: 1, modelCalls: 1, published: 1});
      expect((await f.repository.get("request-1"))?.snapshot.state).toBe("completed");
    } finally {await f.composition.dispose();}
  });
  test("dispose aborts and drains a started grant even if the model callback never settles", async () => {
    const f = await lifecycleFixture(true);
    await rejects(f.prepare(), "device"); await f.approve();
    const prepared = await f.prepare();
    const running = prepared.publish({revalidationToken: 1}).catch((error: unknown) => error);
    await f.started;
    await f.composition.dispose();
    await running;
    expect(f.counts().published).toBe(0);
  });
});


function patchRecoveredClaim(work: ProtectedStenographerRecoveredWork,
  patch: Partial<Pick<ProtectedStenographerRecoveredWork["claim"], "attemptCount" | "leaseToken" | "leaseExpiresAt" | "createdAt">>): ProtectedStenographerRecoveredWork {
  return work.compactionModelId === null
    ? {compactionModelId: null, claim: {...work.claim, ...patch}}
    : {compactionModelId: work.compactionModelId, claim: {...work.claim, ...patch}};
}

async function cancelledFallbackFixture(compaction = false) {
  const batch = "44444444-4444-4444-8444-444444444444";
  const participant = "55555555-5555-4555-8555-555555555555";
  const bindings = [{kind: "message" as const, objectId: "message/1", source: "current" as const,
    messageId: 1, editRevision: 0, createdAt: NOW, participantId: participant,
    role: "user" as const, conversationalBoundary: true}];
  let work: ProtectedStenographerRecoveredWork = {compactionModelId: null, claim: {
    kind: "extraction", workKind: "stenographer.extraction", workId: batch, sourceBatchId: batch,
    roomId: ROOM, namespaceId: NAMESPACE, ownerId: OWNER, rebuildGeneration: 0, lane: "live",
    leaseToken: "66666666-6666-4666-8666-666666666666", leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    attemptCount: 1, fromMessageIdExclusive: 0, throughMessageIdInclusive: 1, trigger: "count", requiresContentRecheck: false,
    bindings, inputObjectIds: ["message/1"], coveredRangeFingerprint: new Uint8Array(32).fill(7),
    sourceBindingFingerprint: fingerprintProtectedStenographerSourceBindings(bindings), participantIds: [participant],
    outputSlots: Array.from({length: 5}, (_, index) => ({eventId: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      objectId: `journal/event/${batch}/slot-${String(index).padStart(3, "0")}`})),
    extractorVersion: "m241-v1", createdAt: NOW.toISOString(),
  }};
  if (compaction) {
    const events = [{kind: "event" as const, objectId: "event/1", status: "active" as const, binding: {
      eventId: "80000000-0000-4000-8000-000000000001", roomId: ROOM, namespaceId: NAMESPACE, sequence: 1,
      kind: "fact" as const, supersedesEventId: null, resolvesEventId: null, sourceMessageIds: [1], sourceBatchId: batch,
      batchLocalOrdinal: 0, extractorVersion: "m241-v1", createdAt: NOW.toISOString(),
    }}];
    work = {compactionModelId: "original-model", claim: {kind: "compaction", workKind: "stenographer.compaction",
      workId: `stenographer-compaction/${ROOM}/0/1`, roomId: ROOM, namespaceId: NAMESPACE, ownerId: OWNER,
      rebuildGeneration: 0, leaseToken: work.claim.leaseToken, leaseExpiresAt: work.claim.leaseExpiresAt, attemptCount: 1,
      bindings: events, inputObjectIds: ["event/1"], sourceBindingFingerprint: fingerprintProtectedStenographerSourceBindings(events),
      activeEventCount: 1, selectedEventCount: 1, hasDeferredMiddle: false,
      outputSlot: {rollupId: "90000000-0000-4000-8000-000000000001", objectId: "rollup/1"},
      compactorVersion: "m241-v1", createdAt: NOW.toISOString()}};
  }
  const initial = createCurrentProtectedStenographerAuthorizationRecord({requestId: "cancelled-request",
    work, now: NOW.getTime(), authority: {policyRevision: 6, namespace: {
      serverId: "server-scope", roomId: ROOM, namespaceId: NAMESPACE, namespaceAccessRevision: 2,
      namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32), domainId: "domain-1", domainKeyGeneration: 3,
      domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32), bundleRevision: 5, bundleDigest: new Uint8Array(32)}}});
  const cancelled = {...initial, snapshot: cancelBackgroundAuthorizationRequest(initial.snapshot, "cancelled", NOW.getTime() + 1), finishedAt: NOW.getTime() + 1};
  const repository = new InMemoryBackgroundAuthorizationRepository(); await repository.create(cancelled);
  let checks = 0; let released = 0; let failCommit = false; let recoveryCalls = 0;
  const seenClaims: ProtectedStenographerRecoveredWork["claim"][] = [];
  const prepare = (nextWork = work) => prepareCancelledStenographerFallback({
    repository: {
      getByIdempotencyKey: (key) => repository.getByIdempotencyKey(key),
      cancelUnconsumedProcessorRequest: async ({expected}) => {
        checks++;
        expect((await repository.get(expected.snapshot.requestId))?.snapshot.state).toBe("cancelled");
        return true;
      },
    },
    idempotencyKey: cancelled.idempotencyKey, work: nextWork, signal: new AbortController().signal, now: () => NOW.getTime() + 2,
    recovery: {recoverExact: ({record, descriptor}) => {
      recoveryCalls++; expect(descriptor).toBeNull(); expect(record.snapshot.state).toBe("cancelled");
      return Promise.resolve({status: "recovered", work: patchRecoveredClaim(nextWork, {createdAt: new Date(record.snapshot.createdAt).toISOString()})});
    }},
    release: async (claim, cancel) => {
      seenClaims.push(claim);
      const allowed = await cancel();
      if (failCommit) throw new Error("product commit failed");
      return allowed;
    },
    released: () => {released++;},
  });
  return {repository, cancelled, work, prepare, seenClaims, failCommit: (value: boolean) => {failCommit = value;},
    checks: () => checks, released: () => released, recoveryCalls: () => recoveryCalls};
}

describe("cancelled Stenographer fallback handoff", () => {
  test("retries after a restricted cancellation outlives the failed product release", async () => {
    const f = await cancelledFallbackFixture();
    f.failCommit(true);
    const first = await f.prepare();
    expect(f.checks()).toBe(0); // Preparation never cancels outside the release owner.
    await rejects(first!.prepareFallback!(), "product commit failed");
    expect(f.released()).toBe(0);
    f.failCommit(false);
    const reacquired = patchRecoveredClaim(f.work, {attemptCount: 2,
      leaseToken: "66666666-6666-4666-8666-666666666699", leaseExpiresAt: new Date(NOW.getTime() + 300_000)});
    const retry = await f.prepare(reacquired);
    expect(await retry!.prepareFallback!()).toBe(true);
    expect(f.seenClaims[1]).toBe(reacquired.claim);
    expect(f.released()).toBe(1);
    expect((await f.repository.get(f.cancelled.snapshot.requestId))?.snapshot.state).toBe("cancelled");
  });
  test("same-work ordinary retry reuses its terminal row instead of attempting a conflicting create", async () => {
    const f = await cancelledFallbackFixture(); let ordinaryAttempts = 0;
    for (let attempt = 2; attempt <= 3; attempt++) {
      const nextWork = patchRecoveredClaim(f.work, {attemptCount: attempt,
        leaseToken: `66666666-6666-4666-8666-66666666666${attempt}`});
      const waiting = await f.prepare(nextWork);
      if (await waiting!.prepareFallback!()) ordinaryAttempts++;
    }
    expect(ordinaryAttempts).toBe(2); expect(f.checks()).toBe(2);
    expect(await f.repository.getByIdempotencyKey(f.cancelled.idempotencyKey)).toEqual(f.cancelled);
    expect(f.cancelled.descriptorBytes).toBeNull(); expect(f.cancelled.snapshot.recipient).toBeNull();
  });
  test("compaction reuses the request creation time through metadata recovery", async () => {
    const f = await cancelledFallbackFixture(true);
    const freshClaim = patchRecoveredClaim(f.work, {attemptCount: 2,
      createdAt: new Date(NOW.getTime() + 300_000).toISOString()});
    const waiting = await f.prepare(freshClaim);
    expect(f.recoveryCalls()).toBe(1);
    expect(await waiting!.prepareFallback!()).toBe(true);
    expect(f.seenClaims[0]?.createdAt).toBe(NOW.toISOString());
    expect(f.seenClaims[0]?.attemptCount).toBe(2);
  });
  test("cancelled compaction release reselects current product work after a model change", async () => {
    const f = await cancelledFallbackFixture(true);
    if (f.work.compactionModelId === null) throw new Error("Compaction fixture required");
    const waiting = await f.prepare({...f.work, compactionModelId: "replacement-model"});
    expect(await waiting!.prepareFallback!()).toBe(true);
    expect(f.checks()).toBe(1); expect(f.seenClaims).toHaveLength(1);
    expect((await f.repository.get(f.cancelled.snapshot.requestId))?.snapshot.state).toBe("cancelled");
  });
  test("changed content identity cannot borrow the cancelled release callback", async () => {
    const f = await cancelledFallbackFixture();
    await rejects(f.prepare(patchRecoveredClaim(f.work, {createdAt: new Date(NOW.getTime() + 1).toISOString()})), "durable identity");
    expect(f.checks()).toBe(0); expect(f.seenClaims).toHaveLength(0);
  });
});


describe("Stenographer Namespace availability classification", () => {
  test("only missing Namespace custody can become key waiting", () => {
    expect(() => assertStenographerNamespaceWaitingReason("namespace_bundle_unavailable")).not.toThrow();
  });
  test.each([["authority_inconsistent", "integrity"], ["unexpected_owner_reason", "authority"]] as const)(
    "%s cannot enter ordinary fallback", (reason, expected) => {
      let failure: unknown;
      try {assertStenographerNamespaceWaitingReason(reason);} catch (error) {failure = error;}
      expect(classifyDataOperationFailure(failure)).toBe(expected);
    },
  );
});


describe("current reconciliation request cleanup", () => {
  async function cleanupFixture() {
    const f = await lifecycleFixture();
    await rejects(f.prepare(), "device"); await f.approve();
    const operation = await f.prepare(); await operation.publish({revalidationToken: 1});
    const original = (await f.repository.get("request-1"))!;
    expect(original.snapshot.state).toBe("completed");
    const repair = (id: string): BackgroundAuthorizationRecord => ({...original,
      snapshot: createBackgroundAuthorizationRequestV2({requestId: id, workId: `reconcile:${original.snapshot.requestId}`,
        namespaceId: NAMESPACE, credentialSubject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, now: NOW.getTime()}),
      workKind: "stenographer.publication_reconcile", purpose: "journal.reconcile", idempotencyKey: id,
      workIdentityHash: new LatticeCrypto().hash(new TextEncoder().encode(id)),
      descriptorBytes: null, acceptedMaterial: null, finishedAt: null});
    const old = repair("old-authority"); const current = repair("current-authority");
    await f.repository.create(old); await f.repository.create(current);
    const discarded: string[] = [];
    return {...f, original, old, current, discarded,
      cancel: (keepIdempotencyKey?: string) => cancelObsoleteStenographerReconciliations({original,
        records: [old, current], repository: f.repository, now: NOW.getTime(),
        ...(keepIdempotencyKey === undefined ? {} : {keepIdempotencyKey}), discardRecipient: id => {discarded.push(id);}})};
  }
  test("completed original cancels its active orphan without completing an unopened grant or rerunning the model", async () => {
    const f = await cleanupFixture();
    try {
      expect(await f.cancel()).toBe(true);
      expect((await f.repository.get(f.old.snapshot.requestId))?.snapshot.state).toBe("cancelled");
      expect((await f.repository.get(f.current.snapshot.requestId))?.snapshot.state).toBe("cancelled");
      expect(f.counts().modelCalls).toBe(1);
      expect(f.discarded).toEqual(["old-authority", "current-authority"]);
      // The existing metadata poll includes fresh requests even after the original completed.
      await f.composition.candidates.extraction({lane: "live", now: NOW});
      expect(f.calls.some(call => call.sql.includes('select "namespace_id", "request_id"')
        && call.parameters.includes("stenographer.publication_reconcile"))).toBe(true);
    } finally {await f.composition.dispose();}
  });
  test("authority supersession cancels only the obsolete exact identity", async () => {
    const f = await cleanupFixture();
    try {
      expect(await f.cancel(f.current.idempotencyKey)).toBe(true);
      expect((await f.repository.get(f.old.snapshot.requestId))?.snapshot.terminalReason).toBe("superseded");
      expect((await f.repository.get(f.current.snapshot.requestId))?.snapshot.state).toBe("awaiting_recipient");
      expect(f.counts().modelCalls).toBe(1);
    } finally {await f.composition.dispose();}
  });
  test("a concurrent grant revision keeps cleanup pending, and another work cannot borrow cancellation", async () => {
    const f = await cleanupFixture();
    try {
      expect(await cancelObsoleteStenographerReconciliations({original: f.original, records: [f.old],
        repository: {compareAndSwap: () => Promise.resolve({status: "stale", current: f.old})}, now: NOW.getTime(),
        discardRecipient: () => {throw new Error("Uncommitted cancellation cannot discard recipient");}})).toBe(false);
      await rejects(cancelObsoleteStenographerReconciliations({original: f.original,
        records: [{...f.old, snapshot: {...f.old.snapshot, workId: "reconcile:another-original"}}],
        repository: f.repository, now: NOW.getTime(), discardRecipient: () => {}}), "identity changed");
      expect((await f.repository.get(f.old.snapshot.requestId))?.snapshot.state).toBe("awaiting_recipient");
    } finally {await f.composition.dispose();}
  });
});


describe("current Stenographer execution plan refresh", () => {
  async function planFixture(compaction = false) {
    const source = await cancelledFallbackFixture(compaction);
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial: BackgroundAuthorizationRecord = {...source.cancelled,
      snapshot: {...createBackgroundAuthorizationRequestV2({requestId: "plan-original", workId: source.work.claim.workId,
        namespaceId: NAMESPACE, credentialSubject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, now: NOW.getTime()}),
        retryCount: 2, lastRetryReason: "provider_transient_failure", nextAttemptAt: NOW.getTime()}, finishedAt: null};
    await repository.create(initial);
    const authority = {policyRevision: 7, namespace: {serverId: "server-scope", roomId: ROOM, namespaceId: NAMESPACE,
      namespaceAccessRevision: 3, namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32), domainId: "domain-1",
      domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32), bundleRevision: 5,
      bundleDigest: new Uint8Array(32)}};
    let discarded = 0; let claims = 0;
    const input: Parameters<typeof refreshCurrentStenographerPlan>[0] = {record: initial, repository,
      recovery: {recoverExact: () => Promise.resolve({status: "recovered", work: source.work})},
      resolveAuthority: () => Promise.resolve(structuredClone(authority)), hasPublication: () => Promise.resolve(false),
      fallback: () => Promise.resolve(false), retire: () => Promise.resolve(false),
      supersede: async (work, revision, commit) => {
        expect(work.claim.leaseToken).toBe(source.work.claim.leaseToken);
        expect(work.claim.attemptCount).toBe(source.work.claim.attemptCount);
        expect(revision).toBe(7); claims++; return commit();
      }, discardRecipient: () => {discarded++;}, now: () => NOW.getTime() + 10, signal: new AbortController().signal};
    return {initial, repository, source, authority, input, counts: () => ({discarded, claims})};
  }
  test.each([false, true])("authority drift replans extraction/compaction while preserving creation and execution budget (%s)", async compaction => {
    const f = await planFixture(compaction);
    const work = compaction ? {...f.source.work, compactionModelId: "replacement-model"} as ProtectedStenographerRecoveredWork : f.source.work;
    const next = await refreshCurrentStenographerPlan({...f.input,
      recovery: {recoverExact: () => Promise.resolve({status: "recovered", work})}});
    expect(next?.snapshot.requestId).not.toBe(f.initial.snapshot.requestId);
    expect(next?.snapshot.workId).toBe(f.initial.snapshot.workId);
    expect(next?.snapshot.createdAt).toBe(f.initial.snapshot.createdAt);
    expect(next?.snapshot.retryCount).toBe(2);
    expect(next?.snapshot.lastRetryReason).toBe("provider_transient_failure");
    expect(next?.snapshot.nextAttemptAt).toBe(NOW.getTime() + 10);
    expect(next?.expectedNamespaceAccessRevision).toBe(3); expect(next?.expectedPolicyRevision).toBe(7);
    expect((await f.repository.get(f.initial.snapshot.requestId))?.snapshot.terminalReason).toBe("superseded");
    expect(f.counts()).toEqual({discarded: 1, claims: 1});
    expect(await refreshCurrentStenographerPlan({...f.input, record: next!,
      recovery: {recoverExact: () => Promise.resolve({status: "recovered", work})}})).toEqual(next);
    expect(f.counts().claims).toBe(1);
  });
  test("duplicate concurrent planners share one successor and a competing plan cannot create another", async () => {
    const f = await planFixture();
    const [first, duplicate] = await Promise.all([refreshCurrentStenographerPlan(f.input), refreshCurrentStenographerPlan(f.input)]);
    expect(first?.snapshot.requestId).toBe(duplicate?.snapshot.requestId);
    expect(await refreshCurrentStenographerPlan({...f.input,
      resolveAuthority: () => Promise.resolve({...structuredClone(f.authority), namespace: {...structuredClone(f.authority.namespace), namespaceAccessRevision: 4}})})).toBeNull();
    expect((await f.repository.get(f.initial.snapshot.requestId))?.snapshot.terminalReason).toBe("superseded");
  });
  test("uncertain publication and completed work never enter source recovery or create a new execution", async () => {
    const f = await planFixture();
    const forbidden = () => Promise.reject(new Error("Execution replanning must not run"));
    expect(await refreshCurrentStenographerPlan({...f.input, hasPublication: () => Promise.resolve(true),
      recovery: {recoverExact: forbidden}, resolveAuthority: forbidden})).toEqual(f.initial);
    // State is inspected before any repository/authority/source work; the real
    // persisted state shapes are exercised by the coordinator lifecycle above.
    for (const state of ["running", "publication_reconciliation", "completed"] as const) {
      const record = {...f.initial, snapshot: {...f.initial.snapshot, state}};
      expect(await refreshCurrentStenographerPlan({...f.input, record, hasPublication: forbidden,
        recovery: {recoverExact: forbidden}, resolveAuthority: forbidden})).toEqual(record);
    }
    expect(f.counts()).toEqual({discarded: 0, claims: 0});
  });
  test("missing authority and stale sources fail closed without ordinary fallback or queue mutation", async () => {
    const f = await planFixture();
    for (const input of [{...f.input, resolveAuthority: () => Promise.resolve(null)},
      {...f.input, recovery: {recoverExact: () => Promise.resolve({status: "leased" as const})}}]) {
      const error = await refreshCurrentStenographerPlan(input).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(await (error as {prepareFallback(): Promise<boolean>}).prepareFallback()).toBe(false);
    }
    let retired = 0;
    expect(await refreshCurrentStenographerPlan({...f.input, recovery: {recoverExact: () => Promise.resolve({status: "stale"})},
      retire: () => {retired++; return Promise.resolve(true);}})).toBeNull();
    expect(retired).toBe(1);
    let fallback = 0;
    const missingAuthority = await refreshCurrentStenographerPlan({...f.input, resolveAuthority: () => Promise.resolve(null),
      fallback: () => {fallback++; return Promise.resolve(true);}}).catch((cause: unknown) => cause);
    expect(fallback).toBe(0);
    expect(await (missingAuthority as {prepareFallback(): Promise<boolean>}).prepareFallback()).toBe(true);
    expect(fallback).toBe(1);
    expect(await refreshCurrentStenographerPlan({...f.input, supersede: () => Promise.resolve(false)})).toBeNull();
    expect(await f.repository.get(f.initial.snapshot.requestId)).toEqual(f.initial);
    expect(f.counts()).toEqual({discarded: 0, claims: 0});
  });
  test("the repository rejects a successor that resets execution retry history", async () => {
    const f = await planFixture();
    const successor = createCurrentProtectedStenographerAuthorizationRecord({requestId: "bad-budget", work: f.source.work,
      authority: f.authority, now: NOW.getTime()});
    await rejects(f.repository.supersedeUnstartedProcessorRequest({expected: f.initial, successor, now: NOW.getTime() + 10}), "fresh current plan");
    expect(await f.repository.get(f.initial.snapshot.requestId)).toEqual(f.initial);
  });
});
