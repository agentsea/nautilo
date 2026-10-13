import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  bindConversationProductCanonicalTransactionRunner,
  PostgresConversationProductStore,
  verifyConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  createProtectedTaskTerminalMessageProductGuard,
  type ProtectedTaskTerminalMessageDestination,
  type ProtectedTaskTerminalMessageIntent,
} from "./protected-task-terminal-message-product";

/** Borrow the canonical destination owner; never open a second product transaction. */
export async function withProtectedTaskTerminalMessageProductStore<Value>(input: Readonly<{
  product: PostgresJsBridgeConnection;
  transaction: CanonicalTranscriptTx;
  intent: ProtectedTaskTerminalMessageIntent;
  destination: ProtectedTaskTerminalMessageDestination;
  publicationPolicyRevision: number;
  use(store: PostgresConversationProductStore): Promise<Value>;
}>): Promise<Value> {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error("Terminal Message product authority is closed");
  };
  const handle = await verifyConversationProductPostgresHandle(input.product);
  const runner = bindConversationProductCanonicalTransactionRunner(handle, {
    transaction: async callback => {
      assertActive();
      const result = await callback(input.transaction, input.product);
      assertActive();
      return result;
    },
  });
  try {
    return await input.use(new PostgresConversationProductStore(handle, runner,
      createProtectedTaskTerminalMessageProductGuard({ ...input, isActive: () => active })));
  } finally { active = false; }
}
