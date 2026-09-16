import {and, eq, encryptionTransitionPolicy, roomJournalState, sql} from "@nautilo/db";
import type {ProcessorTransformInput} from "@nautilo/lattice-crypto";
import {ProcessorOutputRepairIntegrityErrorV2, stenographerOrdinaryOutputFingerprint} from "@nautilo/lattice-crypto/background";
import {encodeStenographerOutputRepairPlan, type StenographerOutputRepairPlan} from "../../journal/stenographer-output-repair-plan.ts";
import {ForegroundProductChangedError} from "../foreground-product-changed.ts";
import {conversationProductTypedDb, executeTypedConversationProductQuery, type ConversationProductPostgresTransaction} from "../message/postgres-conversation-product-store.ts";
import {selectPostgresStenographerFallbackInTransaction} from "./postgres-stenographer-fallback-selection.ts";
import {attachPostgresForegroundJournalRepairWithinTransaction, loadPostgresForegroundJournalRepairSourcesWithinTransaction,
  type ForegroundJournalRepairSource} from "./postgres-foreground-journal-repair.ts";

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Before restricted authority locks: freeze the existing Room Journal generation and exact metadata inventory. */
export async function validatePostgresStenographerOutputRepairPlan(input: Readonly<{
  transaction: ConversationProductPostgresTransaction; plan: StenographerOutputRepairPlan;
}>): Promise<boolean> {
  const {transaction, plan} = input;
  // The enclosing current-authority owner holds the policy consumption fence.
  // A fresh reconciliation grant must not reopen ordinary siblings in Full.
  const policy = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.select({mode: encryptionTransitionPolicy.mode})
    .from(encryptionTransitionPolicy).where(eq(encryptionTransitionPolicy.id, "server")));
  if (policy.length !== 1 || policy[0]!.mode !== "shadow_encryption") return false;
  const state = await executeTypedConversationProductQuery(transaction, conversationProductTypedDb.select({roomId: roomJournalState.roomId})
    .from(roomJournalState).where(and(eq(roomJournalState.roomId, plan.binding.receipt.roomId),
      eq(roomJournalState.rebuildGeneration, plan.binding.receipt.rebuildGeneration))).for("update"));
  if (state.length !== 1) return false;
  const current = await selectPostgresStenographerFallbackInTransaction({transaction, receipt: plan.binding.receipt});
  if (current.status !== "ready") return false;
  if (current.outputCreatedAt.length !== plan.binding.outputs.length
    || current.outputCreatedAt.some((createdAt, i) => createdAt !== plan.binding.outputs[i]!.createdAt)) return false;
  const expected = encodeStenographerOutputRepairPlan(plan);
  let observed: Uint8Array | undefined;
  let completedExpected: Uint8Array | undefined;
  try {
    if (!same(current.receipt.ordinaryOutputFingerprint, plan.binding.receipt.ordinaryOutputFingerprint)
      || current.receipt.fallbackReason !== plan.binding.receipt.fallbackReason) return false;
    // The codec also rejects changed mapping dispositions and generation identities.
    // The crypto gate rechecks authority after the attachment transaction commits;
    // at that point only this exact complete new mapping inventory is admissible.
    try {
      observed = encodeStenographerOutputRepairPlan({...plan, snapshot: current.snapshot});
      if (same(expected, observed)) return true;
    } catch (cause) {
      if (!(cause instanceof TypeError || cause instanceof RangeError)) throw cause;
    }
    observed?.fill(0);
    const completedBinding = {...plan.binding, outputs: plan.binding.outputs.map(output => ({...output, disposition: "existing" as const}))};
    const byLogicalId = new Map(completedBinding.outputs.map(output => [output.logicalId, output]));
    const completedSnapshot = {...plan.snapshot,
      rollup: plan.snapshot.rollup === null ? null : {...plan.snapshot.rollup,
        protectedMapping: {status: "mapped" as const, cryptoObjectId: completedBinding.outputs[0]!.objectId}},
      events: plan.snapshot.events.map(event => {
        if (event.payload.kind !== "reflection_record") throw new TypeError("Repair requires native Records");
        const output = byLogicalId.get(event.payload.recordId)!;
        return {...event, payload: {...event.payload, protectedMapping: {status: "mapped" as const,
          cryptoObjectId: output.objectId, representationGeneration: output.representationGeneration}}};
      })};
    completedExpected = encodeStenographerOutputRepairPlan({...plan, binding: completedBinding, snapshot: completedSnapshot});
    observed = encodeStenographerOutputRepairPlan({...plan, binding: completedBinding, snapshot: current.snapshot});
    return same(completedExpected, observed);
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof RangeError) return false;
    throw cause;
  } finally {expected.fill(0); observed?.fill(0); completedExpected?.fill(0); current.receipt.ordinaryOutputFingerprint.fill(0);}
}

/** Called only inside a claimed current grant. Reuse the foreground Journal loader and its canonical payload bytes. */
export async function withPostgresStenographerOutputRepairSources<Value>(input: Readonly<{
  transaction: ConversationProductPostgresTransaction; plan: StenographerOutputRepairPlan; signal: AbortSignal;
  use(sources: readonly (ForegroundJournalRepairSource & {readonly fingerprintCreatedAt: number})[]): Promise<Value>;
}>): Promise<Value> {
  input.signal.throwIfAborted();
  const sources = await loadPostgresForegroundJournalRepairSourcesWithinTransaction(input.transaction,
    {snapshot: input.plan.snapshot, representationMode: "ordinary-and-protected"});
  try {
    input.signal.throwIfAborted();
    const binding = input.plan.binding;
    if (sources.length !== binding.outputs.length || sources.some((source, i) => {
      const expected = binding.outputs[i]!;
      return source.plaintextBytes === null || source.logicalId !== expected.logicalId
        || source.objectType !== expected.objectType || source.createdAt !== expected.createdAt
        || source.representationGeneration !== expected.representationGeneration
        || source.ordinaryRepresentationGeneration !== expected.ordinaryRepresentationGeneration
        || source.existingObjectId !== (expected.disposition === "existing" ? expected.objectId : null);
    })) throw new ForegroundProductChangedError("Fallback repair source inventory changed");
    const receipt = binding.receipt;
    const ordinary = sources.map((source, i) => ({...source,
      fingerprintCreatedAt: receipt.kind === "extraction" ? Date.parse(input.plan.snapshot.events[i]!.binding.createdAt) : source.createdAt}));
    const fingerprint = stenographerOrdinaryOutputFingerprint({kind: receipt.kind, receiptId: receipt.id,
      roomId: receipt.roomId, namespaceId: receipt.namespaceId, rebuildGeneration: receipt.rebuildGeneration,
      fallbackReason: receipt.fallbackReason, outputs: ordinary.map((source, i) => ({logicalId: source.logicalId,
        objectType: binding.outputs[i]!.objectType,
        // The immutable ordinary receipt hashes event observation coordinates,
        // while the signed crypto output binds its own payload timestamp.
        createdAt: source.fingerprintCreatedAt,
        payloadBytes: source.plaintextBytes!}))});
    try {
      if (!same(fingerprint, receipt.ordinaryOutputFingerprint)) throw new ProcessorOutputRepairIntegrityErrorV2("Fallback ordinary result no longer matches its receipt");
    } finally {fingerprint.fill(0);}
    const result = await input.use(ordinary);
    input.signal.throwIfAborted();
    return result;
  } finally {sources.forEach(source => source.plaintextBytes?.fill(0));}
}

/** Complete inventory parity precedes any product mapping; all new mappings share this transaction. */
export async function attachPostgresStenographerOutputRepair(input: Readonly<{
  transaction: ConversationProductPostgresTransaction; plan: StenographerOutputRepairPlan;
  outputs: readonly ProcessorTransformInput[]; publicationId: string; requestCommitment: Uint8Array;
  publicationBindingRef: string; signal: AbortSignal;
}>): Promise<void> {
  return withPostgresStenographerOutputRepairSources({...input, use: async sources => {
    if (input.outputs.length !== sources.length || input.outputs.some((output, i) => output.objectId !== input.plan.binding.outputs[i]!.objectId
      || !same(output.plaintext, sources[i]!.plaintextBytes!))) {
      throw new ProcessorOutputRepairIntegrityErrorV2("Fallback protected result differs from the complete ordinary result");
    }
    for (const [i, source] of sources.entries()) {
      const slot = input.plan.binding.outputs[i]!;
      if (slot.disposition === "existing") continue;
      const result = await attachPostgresForegroundJournalRepairWithinTransaction(input.transaction, {source, objectId: slot.objectId,
        publicationId: `${input.publicationId}:${i}`, requestCommitment: input.requestCommitment, publicationBindingRef: input.publicationBindingRef});
      if (result === "conflict") throw new ForegroundProductChangedError("Fallback repair lost its mapping attachment");
    }
    // Reuse the existing scheduling timestamp, not a second repair queue/cursor.
    await executeTypedConversationProductQuery(input.transaction, conversationProductTypedDb.update(roomJournalState)
      .set({updatedAt: sql`CURRENT_TIMESTAMP`}).where(eq(roomJournalState.roomId, input.plan.binding.receipt.roomId)));
  }});
}
