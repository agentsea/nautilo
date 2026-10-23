import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  bindConversationProductCanonicalTransactionRunner,
  PostgresConversationProductStore, verifyConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  assertProtectedTaskRunResultMessageAuthorization,
  createProtectedTaskRunResultMessageProductGuard,
  protectedTaskRunResultMessageAppendInput,
  type ProtectedTaskRunResultMessageProductInput,
} from "./protected-task-run-result-message-product";
import { lockExactProtectedTaskRunResultMessageAllocation } from
  "./protected-task-run-result-message-allocation";

type Store = PostgresConversationProductStore;
export type ProtectedTaskRunResultMessageProductStore = Readonly<{
  appendAllocated(): ReturnType<Store["appendAllocated"]>;
  markCryptoComplete: Store["markCryptoComplete"];
  compareAndSwapCryptoMapping: Store["compareAndSwapCryptoMapping"];
}>;

/** The exact borrowed transaction is the lifetime of this deliberately narrow store. */
export async function withProtectedTaskRunResultMessageProductStore<Value>(input:
  ProtectedTaskRunResultMessageProductInput & Readonly<{
    product: PostgresJsBridgeConnection;
    use(store: ProtectedTaskRunResultMessageProductStore): Promise<Value>;
  }>,
): Promise<Value> {
  let active = true;
  const assertActive = () => {
    if (!active) throw new TypeError("Task result Message product authority is closed");
    assertProtectedTaskRunResultMessageAuthorization(input);
  };
  assertActive();
  const handle = await verifyConversationProductPostgresHandle(input.product);
  const runner = bindConversationProductCanonicalTransactionRunner(handle, {
    transaction: async callback => {
      assertActive();
      const value = await callback(input.transaction, input.product);
      assertActive();
      return value;
    },
  });
  const store = new PostgresConversationProductStore(handle, runner,
    createProtectedTaskRunResultMessageProductGuard({ ...input, isActive: () => active }));
  const publicationPolicy = Object.freeze({ expectedRevision: input.intent.expectedPolicyRevision,
    representation: input.intent.representation === "protected"
      ? "protected_only" as const : "ordinary_and_protected" as const });
  const assertMapping = (operation: Parameters<Store["markCryptoComplete"]>[0]
    | Parameters<Store["compareAndSwapCryptoMapping"]>[0]) => {
    assertActive();
    const a = input.authorization;
    if (a.kind !== "staged" || operation.sessionId !== a.proof.intent.sessionId
      || operation.messageId !== a.proof.intent.messageId || operation.revision !== 0
      || operation.cryptoObjectId !== a.proof.intent.objectId || operation.leaseToken !== null
      || operation.publicationPolicy?.expectedRevision !== publicationPolicy.expectedRevision
      || operation.publicationPolicy.representation !== publicationPolicy.representation
      || "repairPublication" in operation && operation.repairPublication !== undefined) {
      throw new TypeError("Task result Message mapping coordinate changed");
    }
  };
  try {
    const result = await input.use(Object.freeze<ProtectedTaskRunResultMessageProductStore>({
      async appendAllocated() {
        assertActive();
        if (input.authorization.kind !== "source") throw new TypeError("Staged Message cannot allocate a new sibling");
        const { source } = input.authorization;
        const allocated = await store.appendAllocated(protectedTaskRunResultMessageAppendInput(input));
        assertActive();
        if (allocated.status === "conflict") return allocated;
        if (input.intent.representation === "protected"
          && allocated.lifecycle.publicationPolicyRevision !== input.publicationPolicyRevision) {
          throw new TypeError("Task result Message allocation requires current publication policy");
        }
        const exact = await lockExactProtectedTaskRunResultMessageAllocation({
          transaction: input.transaction, intent: input.intent,
          destinationNamespaceId: input.destinationNamespaceId,
          expectedPayloadDigest: source.payloadDigest, phase: "pristine",
        });
        if (exact === null) throw new TypeError("Task result Message allocation disappeared");
        assertActive();
        return allocated;
      },
      async markCryptoComplete(operation) {
        assertMapping(operation);
        if (operation.parityStatus !== (input.intent.representation === "protected"
          ? "server_authenticated" : "server_verified")) throw new TypeError("Task result Message parity changed");
        return store.markCryptoComplete({ sessionId: operation.sessionId, messageId: operation.messageId,
          revision: 0, cryptoObjectId: operation.cryptoObjectId, leaseToken: null,
          parityStatus: operation.parityStatus, publicationPolicy });
      },
      async compareAndSwapCryptoMapping(operation) {
        assertMapping(operation);
        if (operation.expectedNamespaceId !== input.destinationNamespaceId) throw new TypeError("Task result Message Namespace changed");
        return store.compareAndSwapCryptoMapping({ sessionId: operation.sessionId, messageId: operation.messageId,
          revision: 0, cryptoObjectId: operation.cryptoObjectId, leaseToken: null,
          expectedNamespaceId: input.destinationNamespaceId, publicationPolicy });
      },
    }));
    assertActive();
    return result;
  } finally { active = false; }
}
