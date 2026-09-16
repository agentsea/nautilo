import { sha256 } from "@noble/hashes/sha2.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DOMAIN = "nautilo/artifact-required-namespaces/v1";
const encoder = new TextEncoder();

export type HumanArtifactExactAccessAuthority = Readonly<{
  userId: string;
  subjectHumanId: string;
  actorId: string;
  agentId: null;
  readableNamespaceIds: readonly string[];
  mutableNamespaceIds: readonly string[];
  writableNamespaceIds: readonly string[];
}>;

export type HumanArtifactExactAccessChange = Readonly<{
  status: "changed" | "unchanged";
  currentNamespaceIds: readonly string[];
  targetNamespaceIds: readonly string[];
  addedNamespaceIds: readonly string[];
  removedNamespaceIds: readonly string[];
}>;

function canonicalHumanArtifactNamespaceIds(
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

/** Artifact Namespace fingerprint including the terminal empty audience. */
export function fingerprintHumanArtifactExactAccessTarget(
  namespaceIds: readonly string[],
): Uint8Array {
  const ids = canonicalHumanArtifactNamespaceIds(
    "Human Artifact exact access target",
    namespaceIds,
  );
  return sha256(encoder.encode(
    `${DOMAIN}\n${ids.length}\n${
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

export function deriveHumanArtifactExactAccessChange(input: Readonly<{
  authority: HumanArtifactExactAccessAuthority;
  currentNamespaceIds: readonly string[];
  proposedTargetNamespaceIds: readonly string[];
}>): HumanArtifactExactAccessChange {
  if (input.authority.agentId !== null) {
    throw new TypeError("Human Artifact exact access rejects Agent authority");
  }
  const currentNamespaceIds = canonicalHumanArtifactNamespaceIds(
    "Current Human Artifact Namespace set",
    input.currentNamespaceIds,
  );
  const targetNamespaceIds = canonicalHumanArtifactNamespaceIds(
    "Target Human Artifact Namespace set",
    input.proposedTargetNamespaceIds,
  );
  const readable = new Set(canonicalHumanArtifactNamespaceIds(
    "Readable Human Artifact Namespace set",
    input.authority.readableNamespaceIds,
  ));
  const mutable = new Set(canonicalHumanArtifactNamespaceIds(
    "Mutable Human Artifact Namespace set",
    input.authority.mutableNamespaceIds,
  ));
  const writable = new Set(canonicalHumanArtifactNamespaceIds(
    "Writable Human Artifact Namespace set",
    input.authority.writableNamespaceIds,
  ));
  if (!currentNamespaceIds.some((id) => readable.has(id))) {
    throw new TypeError("Human Artifact access read authority is incomplete");
  }
  const current = new Set(currentNamespaceIds);
  const target = new Set(targetNamespaceIds);
  const addedNamespaceIds = difference(targetNamespaceIds, current);
  const removedNamespaceIds = difference(currentNamespaceIds, target);
  if (addedNamespaceIds.some((id) => !writable.has(id))) {
    throw new TypeError("Human Artifact access add authority is incomplete");
  }
  if (removedNamespaceIds.some((id) => !mutable.has(id))) {
    throw new TypeError("Human Artifact access remove authority is incomplete");
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

export function targetAfterHumanArtifactAuthorizedViewDeletion(input: Readonly<{
  currentNamespaceIds: readonly string[];
  readableNamespaceIds: readonly string[];
}>): readonly string[] {
  const current = canonicalHumanArtifactNamespaceIds(
    "Current Human Artifact Namespace set",
    input.currentNamespaceIds,
  );
  const readable = new Set(canonicalHumanArtifactNamespaceIds(
    "Readable Human Artifact Namespace set",
    input.readableNamespaceIds,
  ));
  return Object.freeze(current.filter((id) => !readable.has(id)));
}
