import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assertTaskContentCoordinateV1, type TaskContentCoordinateV1 } from "./task-content-repository.ts";

const DOMAIN = "nautilo/task-historical-content-identity/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A historical source version has independent ciphertext identity; native revisions are unchanged. */
export function deriveTaskHistoricalContentCryptoObjectIdV1(input: Readonly<{
  coordinate: TaskContentCoordinateV1;
  sourceDigest: Uint8Array;
  namespaceId: string;
}>): string {
  assertTaskContentCoordinateV1(input.coordinate);
  if (input.coordinate.contentRevision !== 1 || !UUID.test(input.namespaceId)
    || !(input.sourceDigest instanceof Uint8Array) || input.sourceDigest.length !== 32) {
    throw new TypeError("Historical Task content identity is invalid");
  }
  const tuple = [DOMAIN, input.coordinate.kind, input.coordinate.taskId,
    input.coordinate.kind === "run_result" ? input.coordinate.taskRunId : null,
    bytesToHex(input.sourceDigest), input.namespaceId];
  return `task-historical:v1:${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(tuple))))}`;
}
