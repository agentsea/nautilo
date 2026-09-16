import { sha256 } from "@noble/hashes/sha2.js";

import { encodeMemoryPayloadV1, type MemoryPayloadV1 } from "./memory-payload-v1.ts";

const DOMAIN = new TextEncoder().encode("nautilo.memory.mutation-commitment.v1\n");
const encoder = new TextEncoder();

export type MemoryMutationCommitmentInput =
  | Readonly<{ kind: "save"; payload: MemoryPayloadV1 }>
  | Readonly<{ kind: "replace"; content: string }>;

/** Content-free binding for one exact authored Memory mutation request. */
export function commitMemoryMutationV1(input: MemoryMutationCommitmentInput): Uint8Array {
  let canonical: Uint8Array;
  if (input.kind === "save") {
    canonical = encodeMemoryPayloadV1(input.payload);
  } else {
    const checked = encodeMemoryPayloadV1({
      formatVersion: 1,
      type: "replacement",
      content: input.content,
    });
    checked.fill(0);
    canonical = encoder.encode(JSON.stringify({ kind: "replace", content: input.content }));
  }
  const tagged = new Uint8Array(DOMAIN.length + canonical.length);
  tagged.set(DOMAIN);
  tagged.set(canonical, DOMAIN.length);
  canonical.fill(0);
  try {
    return sha256(tagged);
  } finally {
    tagged.fill(0);
  }
}
