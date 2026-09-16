import {createHash} from "node:crypto";
import type {DurableRecordPublication} from "@nautilo/reflection/durable";
import {createHmacRecordRequestCommitmentPort, type PostgresRecordProductStore} from "@nautilo/reflection-bridge/server";

/** Uses only the verified bytes lent by the current Lattice attachment gate. */
export async function attachReflectionShadowSibling(input: Readonly<{
  product: Pick<PostgresRecordProductStore, "attachOrdinarySibling">;
  publication: DurableRecordPublication;
  protectedRequestCommitment: Uint8Array;
  plaintext: Uint8Array;
  commitmentKey: Uint8Array;
}>): Promise<void> {
  const publication = {...input.publication, idempotencyKey: `reflection-shadow:${createHash("sha256").update(input.publication.idempotencyKey).digest("hex")}`};
  const commitment = createHmacRecordRequestCommitmentPort(input.commitmentKey).commit(input.plaintext, publication);
  try {
    const outcome = await input.product.attachOrdinarySibling({
      protectedPublicationId: input.publication.idempotencyKey,
      protectedRequestCommitment: input.protectedRequestCommitment,
      ordinaryPublication: publication, ordinaryPayloadBytes: input.plaintext, ordinaryRequestCommitment: commitment,
    });
    if (outcome !== "attached" && outcome !== "replayed") throw new Error("Reflection ordinary sibling did not attach");
  } finally {commitment.fill(0);}
}
