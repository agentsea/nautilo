import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import { insertPrivateRoomBundleTx } from "../../../../trust/src/queries";
import { insertAcceptanceInTransaction } from "../../../src/queries/work-acceptances";
import { persistJobInTransaction } from "../../../src/queries/jobs";
import { acquireExternalRoomExecutionClaimWith, releaseExternalRoomExecutionClaimWith } from "../../../src/queries/external-room-execution-claims";
import {
  createMagentOperatorConnectionWith, createFreshBolterBindingWith, acceptBolterInboundWith,
  getBolterExecutionInputForReceiptWith, linkBolterExecutionAcceptanceWith, startBolterExecutionWith, completeBolterExecutionWith,
  getMagentReceiptStatusWith, cancelMagentReceiptWith, claimBolterOutboxWith, loadBolterPublicationContentWith,
  settleBolterOutboxWith, withdrawMagentBindingWith, updateBolterBindingStateWith, type BolterBridgeDatabase, type BolterFactoryDatabase,
} from "../../../src/queries/bolter-bridge";
const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
/** Caller owns the disposable database. Never resolves a workspace instance or shared pool. */
export async function verifyMagentLifecycle(port: string) {
  if (!/^\d+$/u.test(port)) throw new Error("Invalid isolated fixture port");
  const client = (role: string) => postgres(`postgres://${role}@127.0.0.1:${port}/nautilo`, { max: 1, onnotice: () => {} });
  const adminClient = client("postgres"), productClient = client("nautilo");
  let agentClient = client("nautilo_agent");
  const admin = drizzle(adminClient, { schema }), product = drizzle(productClient, { schema }) as unknown as BolterFactoryDatabase;
  let agent = drizzle(agentClient, { schema }) as unknown as BolterBridgeDatabase;
  const userId = randomUUID(), genieId = randomUUID(), humanActorId = randomUUID(), genieActorId = randomUUID();
  const operatorBindingId = randomUUID(), connectorSessionId = randomUUID(), owner = { userId };
  try {
    await adminClient`ALTER ROLE nautilo_agent LOGIN`;
    await admin.insert(schema.users).values({ id: userId, name: "Synthetic external sponsor" });
    await admin.insert(schema.serverAdmission).values({ userId, admitted: true });
    await admin.insert(schema.agents).values({ id: genieId, handle: `synthetic-${genieId}` });
    await admin.insert(schema.actors).values([{ id: humanActorId, ownerId: userId, kind: "user", displayName: "Synthetic sponsor" },
      { id: genieActorId, ownerId: userId, agentId: genieId, kind: "agent", displayName: "Synthetic Genie" }]);
    const connectionInput = { operatorBindingId, origin: "http://127.0.0.1:8080", providerAgentId: "fixture-genie", identityFingerprint: "a".repeat(64) };
    const connection = await createMagentOperatorConnectionWith(agent, owner, connectionInput);
    expect(connection).toMatchObject({ provider: "magent", transportKind: "operator-unix", operatorBindingId, relayId: null, desktopSessionId: null, pairingGenerationRef: null, homeHandle: null });
    expect((await createMagentOperatorConnectionWith(agent, owner, connectionInput)).id).toBe(connection.id);
    await Promise.resolve(expect(createMagentOperatorConnectionWith(agent, owner, { ...connectionInput, identityFingerprint: "b".repeat(64) })).rejects.toThrow("conflicts"));
    const receiver = { ...owner, connectionId: connection.id, connectionGeneration: connection.generation, transportKind: "operator-unix" as const,
      operatorBindingId, relayId: null, desktopSessionId: null, pairingGenerationRef: null };
    const binding = await createFreshBolterBindingWith(product, receiver, async tx => {
      const roomId = randomUUID();
      const bundle = await insertPrivateRoomBundleTx(tx, { roomId, ownerUserId: userId, label: "Synthetic mAgent room", graphThreadId: `room:${roomId}`,
        humanActorIds: [humanActorId], createdByActorId: humanActorId, memberRows: [{ actorId: humanActorId, roomRole: "admin" },
          { actorId: genieActorId, roomRole: "member", agentResponseMode: "active" }], externalContext: true, discoverable: false });
      return { roomId, namespaceId: bundle.namespaceId, agentId: genieId, chatId: "fixture-chat", threadId: "", modelSponsorshipAccepted: true };
    });
    expect(binding.provider).toBe("magent");
    const ctx = { ...receiver, bindingId: binding.id, bindingRevision: binding.revision };
    async function assertNoConversationRows() {
      expect(await admin.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.roomId, binding.roomId))).toHaveLength(0);
      expect(await admin.select({ id: schema.sessionMessages.id }).from(schema.sessionMessages)
        .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionMessages.sessionId))
        .where(eq(schema.sessions.roomId, binding.roomId))).toHaveLength(0);
    }
    async function accept(messageId: string, content = "Synthetic remote input", sessionId = connectorSessionId) {
      const origin = { kind: "external_message", version: 1, provider: "magent", origin: connection.origin, connectionId: connection.id, bindingId: binding.id,
        providerAgentId: connection.providerAgentId, chatId: binding.chatId, threadRootId: null, messageId, senderId: "fixture-connector", senderType: "anima", senderLabel: "Synthetic agent", createdAt: "2026-01-01T00:00:00Z" } as const;
      const fingerprint = digest([origin.provider, origin.origin, origin.providerAgentId, origin.chatId, origin.threadRootId, origin.messageId, origin.senderId, origin.senderType, origin.createdAt, content]);
      return acceptBolterInboundWith(agent, ctx, { providerMessageId: messageId, fingerprint, externalSenderId: origin.senderId }, async (tx, locked, receiptId) => {
        const turnId = randomUUID(), acceptanceId = await insertAcceptanceInTransaction(tx, "foreground");
        const reference = { kind: "external_room_turn_v1", receiptId, acceptanceId, bindingId: locked.id, bindingRevision: locked.revision,
          connectionGeneration: ctx.connectionGeneration, roomId: locked.roomId, agentId: locked.agentId, turnId };
        const jobId = await persistJobInTransaction(tx, { ownerId: userId, requestorId: userId, roomId: locked.roomId, laneKey: `room:${locked.roomId}`, type: "foreground", input: reference });
        return { sessionMessageId: null, controlInput: { kind: "operator_control_v1", content, origin }, turnId, jobId };
      }, sessionId);
    }
    async function inputFor(receiptId: string) {
      const input = await getBolterExecutionInputForReceiptWith(agent, owner, receiptId);
      if (!input) throw new Error("Synthetic execution missing");
      return input;
    }
    const accepted = await accept("original");
    if (accepted.status !== "accepted") throw new Error("Synthetic intake rejected");
    expect(accepted.receipt).toMatchObject({ sessionMessageId: null,
      controlInput: { kind: "operator_control_v1", content: "Synthetic remote input", origin: { messageId: "original", provider: "magent" } } });
    await assertNoConversationRows();
    const duplicate = await accept("original");
    expect(duplicate.status).toBe("duplicate");
    if (duplicate.status === "duplicate") expect(duplicate.receipt.id).toBe(accepted.receipt.id);
    expect((await accept("rotated-session", "Synthetic remote input", randomUUID())).status).toBe("unavailable");
    await Promise.resolve(expect((async () => { await agentClient`UPDATE external_operator_sessions SET session_id = 'replacement'`; })()).rejects.toThrow());
    await Promise.resolve(expect((async () => { await productClient`UPDATE external_operator_sessions SET binding_id = ${binding.id} WHERE binding_id = ${binding.id}`; })()).rejects.toThrow());
    const input = await inputFor(accepted.receipt.id);
    async function finish(input: Awaited<ReturnType<typeof inputFor>>) {
    expect(await linkBolterExecutionAcceptanceWith(agent, owner, input)).toBe("linked");
    const executionClaim = await acquireExternalRoomExecutionClaimWith(product, owner, input.jobId);
    if (executionClaim.kind !== "claimed") throw new Error("Synthetic claim unavailable");
    let outbox;
    try {
      expect(await startBolterExecutionWith(agent, owner, { ...input, executionClaim })).toBe("started");
      outbox = await completeBolterExecutionWith(agent, owner, input, (_tx, execution) => {
        const content = "Synthetic final reply", fingerprint = digest(["external-room-final-v1", input.reference.receiptId, input.jobId, content]);
        expect(execution.receipt.sessionMessageId).toBeNull();
        expect(execution.sourceMessage).toEqual({ id: null, content: "Synthetic remote input" });
        expect(execution.session).toEqual({ id: null, threadId: `room:${binding.roomId}:operator:${input.reference.receiptId}` });
        return Promise.resolve({ sessionMessageId: null, controlResult: content, fingerprint });
      });
    } finally { await releaseExternalRoomExecutionClaimWith(product, owner, executionClaim); }
    if (!outbox) throw new Error("Synthetic publication missing");
    expect(outbox).toMatchObject({ sessionMessageId: null, controlResult: "Synthetic final reply" });
    await assertNoConversationRows();
    return outbox;
    }
    let outbox = await finish(input);
    let publicationReceiptId = accepted.receipt.id;
    let claimToken = randomUUID();
    expect((await claimBolterOutboxWith(agent, ctx, outbox.id, claimToken))?.claimToken).toBe(claimToken);
    await agentClient.end(); agentClient = client("nautilo_agent"); agent = drizzle(agentClient, { schema }) as unknown as BolterBridgeDatabase;
    expect((await admin.select().from(schema.bolterInboxReceipts).where(eq(schema.bolterInboxReceipts.id, accepted.receipt.id)))[0]?.controlInput)
      .toEqual(accepted.receipt.controlInput);
    expect((await admin.select().from(schema.bolterOutbox).where(eq(schema.bolterOutbox.id, outbox.id)))[0])
      .toMatchObject({ sessionMessageId: null, controlResult: "Synthetic final reply" });
    await assertNoConversationRows();
    expect((await getMagentReceiptStatusWith(agent, ctx, accepted.receipt.id))?.state).toBe("completed");
    expect((await claimBolterOutboxWith(agent, ctx, outbox.id, claimToken))?.claimToken).toBe(claimToken);
    expect(await claimBolterOutboxWith(agent, ctx, outbox.id, randomUUID())).toBeNull();
    expect((await loadBolterPublicationContentWith(agent, ctx, { outboxId: outbox.id, claimToken }))?.content).toBe("Synthetic final reply");
    const acknowledgement = { outboxId: outbox.id, claimToken, state: "published" as const, providerMessageId: "accepted-provider-message" };
    expect((await settleBolterOutboxWith(agent, ctx, acknowledgement))?.state).toBe("published");
    expect((await settleBolterOutboxWith(agent, ctx, acknowledgement))?.state).toBe("published");
    expect(await settleBolterOutboxWith(agent, ctx, { ...acknowledgement, providerMessageId: "conflicting-provider-message" })).toBeNull();
    expect(await loadBolterPublicationContentWith(agent, ctx, { outboxId: outbox.id, claimToken })).toBeNull();
    const publication = await accept("reply-before-pause");
    if (publication.status !== "accepted") throw new Error("Synthetic publication input missing");
    publicationReceiptId = publication.receipt.id;
    outbox = await finish(await inputFor(publication.receipt.id));
    claimToken = randomUUID();
    expect((await claimBolterOutboxWith(agent, ctx, outbox.id, claimToken))?.claimToken).toBe(claimToken);
    const cancellation = await accept("cancel-before-start");
    if (cancellation.status !== "accepted") throw new Error("Synthetic cancellation input missing");
    const cancelledInput = await inputFor(cancellation.receipt.id);
    expect(await cancelMagentReceiptWith(agent, ctx, cancellation.receipt.id)).toMatchObject({ jobId: cancelledInput.jobId });
    expect((await getMagentReceiptStatusWith(agent, ctx, cancellation.receipt.id))?.state).toBe("cancelled");
    expect(await startBolterExecutionWith(agent, owner, cancelledInput)).toBe("rejected");
    expect(await completeBolterExecutionWith(agent, owner, cancelledInput, () => Promise.reject(new Error("Late result must never persist")))).toBeNull();
    expect((await accept("conflicting-identity")).status).toBe("accepted");
    expect((await accept("conflicting-identity", "Different bytes")).status).toBe("quarantined");
    const waiting = await accept("queued-before-pause");
    if (waiting.status !== "accepted") throw new Error("Synthetic queued input missing");
    const waitingInput = await inputFor(waiting.receipt.id);
    expect(await linkBolterExecutionAcceptanceWith(agent, owner, waitingInput)).toBe("linked");
    const runningClaim = await acquireExternalRoomExecutionClaimWith(product, owner, waitingInput.jobId);
    if (runningClaim.kind !== "claimed") throw new Error("Synthetic running claim missing");
    expect(await startBolterExecutionWith(agent, owner, { ...waitingInput, executionClaim: runningClaim })).toBe("started");
    const paused = await withdrawMagentBindingWith(agent, owner, { bindingId: binding.id, expectedRevision: 0, state: "paused" });
    expect(paused?.binding.state).toBe("paused"); expect(paused?.cancelledJobIds).toContain(waitingInput.jobId);
    expect(await completeBolterExecutionWith(agent, owner, waitingInput, () => Promise.reject(new Error("Paused running output must never persist")))).toBeNull();
    await releaseExternalRoomExecutionClaimWith(product, owner, runningClaim);
    expect(await loadBolterPublicationContentWith(agent, ctx, { outboxId: outbox.id, claimToken })).toBeNull();
    expect((await getMagentReceiptStatusWith(agent, ctx, publicationReceiptId))?.publicationState).toBe("uncertain");
    expect(await settleBolterOutboxWith(agent, ctx, { outboxId: outbox.id, claimToken, state: "published", providerMessageId: "late-provider-id" })).toBeNull();
    expect((await accept("after-pause")).status).toBe("unavailable");
    const revoked = await updateBolterBindingStateWith(agent, owner, { bindingId: binding.id, expectedRevision: paused!.binding.revision, state: "revoked" });
    expect(revoked?.state).toBe("revoked");
    expect(await updateBolterBindingStateWith(agent, owner, { bindingId: binding.id, expectedRevision: revoked!.revision, state: "active" })).toBeNull();
    await assertNoConversationRows();
  } finally { await agentClient.end(); await productClient.end(); await adminClient.end(); }
}
