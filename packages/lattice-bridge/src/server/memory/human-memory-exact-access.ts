import { sha256 } from "@noble/hashes/sha2.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Exact ordinary-product authority used by the dormant protected Human Memory
 * access path. The product sets are expectations re-read for every operation;
 * they are never inferred from key possession.
 */
export type HumanMemoryExactAccessAuthority = Readonly<{
  userId: string;
  subjectHumanId: string;
  actorId: string | null;
  agentId: null;
  readableNamespaceIds: readonly string[];
  mutableNamespaceIds: readonly string[];
  writableNamespaceIds: readonly string[];
}>;

export type HumanMemoryExactAccessChange = Readonly<{
  status: "changed" | "unchanged";
  currentNamespaceIds: readonly string[];
  targetNamespaceIds: readonly string[];
  addedNamespaceIds: readonly string[];
  removedNamespaceIds: readonly string[];
}>;

function canonicalNamespaceIds(
  label: string,
  namespaceIds: readonly string[],
): readonly string[] {
  if (!Array.isArray(namespaceIds) || namespaceIds.length > 256) {
    throw new TypeError(`${label} is not bounded`);
  }
  const result = Array.from(namespaceIds, (id: string) => id).sort();
  if (result.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new TypeError(`${label} must contain canonical UUIDs`);
  }
  if (result.some((id, index) => index > 0 && result[index - 1] === id)) {
    throw new TypeError(`${label} contains a duplicate Namespace`);
  }
  return Object.freeze(result);
}

function canonicalAuthorityNamespaceIds(
  label: string,
  namespaceIds: readonly string[],
): readonly string[] {
  if (!Array.isArray(namespaceIds)) throw new TypeError(`${label} is invalid`);
  const result = Array.from(namespaceIds, (id: string) => id).sort();
  if (result.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new TypeError(`${label} must contain canonical UUIDs`);
  }
  if (result.some((id, index) => index > 0 && result[index - 1] === id)) {
    throw new TypeError(`${label} contains a duplicate Namespace`);
  }
  return Object.freeze(result);
}

const encoder = new TextEncoder();

/** Product fingerprint for an exact access target, including the empty set. */
export function fingerprintHumanMemoryExactAccessTarget(
  namespaceIds: readonly string[],
): Uint8Array {
  const ids = canonicalNamespaceIds(
    "Human Memory exact access target",
    namespaceIds,
  );
  return sha256(encoder.encode(
    `nautilo/memory-required-namespaces/v1\n${ids.length}\n${
      ids.map((id) => `${encoder.encode(id).length}:${id}`).join("\n")
    }`,
  ));
}

function difference(
  left: readonly string[],
  right: ReadonlySet<string>,
): readonly string[] {
  return Object.freeze(left.filter((id) => !right.has(id)));
}

/**
 * Derive one complete canonical replacement. Only changed edges require
 * authority: retained inaccessible edges are deliberately preserved, while
 * additions require existing-Memory mutation or placement authority, while
 * removals require mutation authority. Ordinary sharing is not restricted to
 * the current Room's default placement for newly created Memories.
 */
export function deriveHumanMemoryExactAccessChange(input: Readonly<{
  authority: HumanMemoryExactAccessAuthority;
  currentNamespaceIds: readonly string[];
  proposedTargetNamespaceIds: readonly string[];
}>): HumanMemoryExactAccessChange {
  if (input.authority.agentId !== null) {
    throw new TypeError("Human Memory exact access rejects Agent authority");
  }
  const currentNamespaceIds = canonicalNamespaceIds(
    "Current Human Memory Namespace set",
    input.currentNamespaceIds,
  );
  const targetNamespaceIds = canonicalNamespaceIds(
    "Target Human Memory Namespace set",
    input.proposedTargetNamespaceIds,
  );
  const mutable = new Set(canonicalAuthorityNamespaceIds(
    "Mutable Human Memory Namespace set",
    input.authority.mutableNamespaceIds,
  ));
  const writable = new Set(canonicalAuthorityNamespaceIds(
    "Writable Human Memory Namespace set",
    input.authority.writableNamespaceIds,
  ));
  const readable = new Set(canonicalAuthorityNamespaceIds(
    "Readable Human Memory Namespace set",
    input.authority.readableNamespaceIds,
  ));
  if (!currentNamespaceIds.some((id) => readable.has(id))) {
    throw new TypeError("Human Memory access read authority is incomplete");
  }
  const current = new Set(currentNamespaceIds);
  const target = new Set(targetNamespaceIds);
  const addedNamespaceIds = difference(targetNamespaceIds, current);
  const removedNamespaceIds = difference(currentNamespaceIds, target);
  if (addedNamespaceIds.some((id) => !mutable.has(id) && !writable.has(id))) {
    throw new TypeError("Human Memory access add authority is incomplete");
  }
  if (removedNamespaceIds.some((id) => !mutable.has(id))) {
    throw new TypeError("Human Memory access remove authority is incomplete");
  }
  return Object.freeze({
    status: addedNamespaceIds.length === 0 && removedNamespaceIds.length === 0
      ? "unchanged"
      : "changed",
    currentNamespaceIds,
    targetNamespaceIds,
    addedNamespaceIds,
    removedNamespaceIds,
  });
}

/** Exact target for "delete what I can currently see". */
export function targetAfterAuthorizedViewDeletion(input: Readonly<{
  currentNamespaceIds: readonly string[];
  readableNamespaceIds: readonly string[];
}>): readonly string[] {
  const current = canonicalNamespaceIds(
    "Current Human Memory Namespace set",
    input.currentNamespaceIds,
  );
  const readable = new Set(canonicalNamespaceIds(
    "Readable Human Memory Namespace set",
    input.readableNamespaceIds,
  ));
  return Object.freeze(current.filter((id) => !readable.has(id)));
}
