import { createHash } from "node:crypto";

import type { FileStateMeta, FileStateSnapshot } from "./types.ts";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function snapshotFromBytes(bytes: Uint8Array): FileStateSnapshot {
  return {
    kind: "bytes",
    bytes,
    sha256: sha256Hex(bytes),
    size: bytes.length,
  };
}

export function metaFromSnapshot(state: FileStateSnapshot): FileStateMeta {
  if (state.kind === "missing") return { kind: "missing" };
  return { kind: "bytes", sha256: state.sha256, size: state.size };
}

export function payloadByteCount(state: FileStateSnapshot): number {
  return state.kind === "missing" ? 0 : state.size;
}

export function statesMetaEqual(a: FileStateMeta, b: FileStateMeta): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "missing" && b.kind === "missing") return true;
  if (a.kind === "bytes" && b.kind === "bytes") {
    return a.sha256 === b.sha256 && a.size === b.size;
  }
  return false;
}
