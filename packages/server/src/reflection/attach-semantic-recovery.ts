import {eq, reflectionRecordSemanticWork} from "@nautilo/db";
import {
  PostgresRecordProductStore, PostgresSemanticWorkStore, ProtectedRecordPublicationReconciler, recoverVerifiedRecordPublication,
  createHmacRecordRequestCommitmentPort, createHmacRecordSemanticCommitmentPort,
  executeTypedRecordProductQuery, recordProductTypedDb, verifyRecordProductPostgresHandle,
  type ClaimedProtectedRecordPublication, type ProtectedRecordPublicationPort, type RecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";
import type {ReflectionSemanticReconciliationBindingV2} from "@nautilo/lattice-crypto/background";
import {ClassifiedDataOperationError} from "@nautilo/lattice-bridge";
import type {CurrentProcessorHeldAuthority} from "@nautilo/lattice-bridge/server";

import {attachReflectionShadowSibling} from "./attach-shadow-sibling";

/** Consumes a verified, freshly granted saved output inside the same product transaction. */
export async function attachReflectionSemanticRecovery(input: Readonly<{
  held: CurrentProcessorHeldAuthority; item: ClaimedProtectedRecordPublication;
  binding: ReflectionSemanticReconciliationBindingV2; plaintext: Uint8Array;
  commitmentKey: Uint8Array; authorizeCommit(): Promise<number>; signal: AbortSignal;
}>): Promise<"completed" | "quarantined"> {
  input.signal.throwIfAborted();
  const connection = input.held.product;
  if (connection === undefined) throw new Error("Reflection recovery requires held product authority");
  const handle = await verifyRecordProductPostgresHandle({query: connection.query.bind(connection), transaction: use => use(connection)});
  await assertReflectionSemanticRecoverySource({handle, binding: input.binding, lock: true});
  const work = new PostgresSemanticWorkStore({handle, commitments: createHmacRecordSemanticCommitmentPort(input.commitmentKey)});
  const product = new PostgresRecordProductStore(handle, work);
  const exact = (objectId: string, recordId: string, generation: number) => objectId === input.binding.objectId
    && recordId === input.item.recordId && recordId === input.binding.recordRef && generation === 1;
  // The enclosing named gate already authenticated this exact object and lent
  // its bytes. These adapters cannot read another object or escape that gate.
  const opened: ProtectedRecordPublicationPort = {
    publish: () => Promise.reject(new Error("Saved publication recovery cannot create output")),
    retire: () => Promise.reject(new Error("Saved publication attachment cannot retire output")),
    verify: request => Promise.resolve(exact(request.objectId, request.recordId, request.representationGeneration) ? "complete" : "mismatch"),
    open: request => {
      input.signal.throwIfAborted();
      return Promise.resolve(exact(request.objectId, request.recordId, request.representationGeneration)
        && request.readBindingRef === input.item.replay?.publicationBindingRef
        ? {status: "available" as const, payloadBytes: Uint8Array.from(input.plaintext)}
        : {status: "unavailable" as const, reason: "unauthorized" as const});
    },
  };
  await input.authorizeCommit();
  const outcome = await new ProtectedRecordPublicationReconciler(product, opened,
    createHmacRecordRequestCommitmentPort(input.commitmentKey)).reconcileClaim(input.item);
  input.signal.throwIfAborted();
  if (outcome !== "completed" && outcome !== "quarantined") throw new Error("Reflection saved publication did not attach");
  if (outcome === "completed" && input.held.ordinarySiblingAllowed === true) {
    const publication = recoverVerifiedRecordPublication(input.item, input.plaintext, createHmacRecordRequestCommitmentPort(input.commitmentKey));
    if (publication === null || input.item.replay === undefined) throw new Error("Reflection saved sibling commitment mismatch");
    await attachReflectionShadowSibling({product, publication, plaintext: input.plaintext,
      protectedRequestCommitment: input.item.replay.requestCommitment, commitmentKey: input.commitmentKey});
  }
  if (outcome === "completed") await work.completeVerifiedGeneration({
    recordRef: input.binding.sourceRecordRef, generation: input.binding.claimGeneration,
  });
  return outcome;
}

/** Reject obsolete work before requesting a grant, and fence it again at attachment. */
export async function assertReflectionSemanticRecoverySource(input: Readonly<{
  handle: RecordProductPostgresHandle; binding: Pick<ReflectionSemanticReconciliationBindingV2, "sourceRecordRef" | "claimGeneration">; lock?: boolean;
}>): Promise<void> {
  const workTable = reflectionRecordSemanticWork;
  const query = recordProductTypedDb.select({
    generation: workTable.generation, completedGeneration: workTable.completedGeneration, state: workTable.state,
  }).from(workTable).where(eq(workTable.recordId, input.binding.sourceRecordRef));
  const rows = await executeTypedRecordProductQuery(input.handle, input.lock === true ? query.for("update") : query);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.generation !== input.binding.claimGeneration
    || row.completed_generation >= input.binding.claimGeneration || row.state === "complete" || row.state === "quarantined") {
    throw new ClassifiedDataOperationError("stale", "Reflection saved publication source generation is no longer current");
  }
 }
