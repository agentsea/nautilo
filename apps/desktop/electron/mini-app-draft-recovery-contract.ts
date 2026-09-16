/**
 * Renderer-safe contract for the Desktop-owned mini-app draft journal.
 *
 * The Workbench supplies a candidate target only when it opens the handle.
 * Electron main resolves that candidate to a canonical identity and returns an
 * opaque handle. Sandboxed mini-apps never receive the handle, target, Human,
 * app, or storage key.
 */

export const MINI_APP_RECOVERY_VERSION = 1 as const;
export const MINI_APP_RECOVERY_APP_IDS = ["nautilo-presentation", "nautilo-board"] as const;

export type MiniAppRecoveryAppId = (typeof MINI_APP_RECOVERY_APP_IDS)[number];

export type MiniAppRecoveryDraft = Readonly<{
  version: typeof MINI_APP_RECOVERY_VERSION;
  content: string;
  exact: boolean;
  baseSha256: string | null;
  baseRevision: number | null;
}>;

export type MiniAppRecoveryTargetCandidate =
  | Readonly<{
      kind: "workspace_artifact";
      artifactInternalId: string;
    }>
  | Readonly<{
      kind: "local_file";
      relayId: string;
      candidatePath: string;
    }>;

export type MiniAppRecoveryTargetIdentity =
  | Readonly<{
      kind: "workspace_artifact";
      artifactInternalId: string;
    }>
  | Readonly<{
      kind: "local_file";
      relayId: string;
      canonicalPath: string;
    }>;

/** Stable owner identity. Volatile connection revisions are not persisted. */
export type MiniAppRecoveryOwner = Readonly<{
  humanId: string;
  canonicalOrigin: string;
  serverFingerprint: string;
}>;

export type MiniAppRecoveryBinding = Readonly<{
  owner: MiniAppRecoveryOwner;
  appId: MiniAppRecoveryAppId;
  target: MiniAppRecoveryTargetIdentity;
}>;

export type MiniAppRecoveryOpenInput = Readonly<{
  expectedViewerId: string;
  appId: MiniAppRecoveryAppId;
  target: MiniAppRecoveryTargetCandidate;
}>;

export type MiniAppRecoveryReadResult = Readonly<{
  revision: string | null;
  draft: MiniAppRecoveryDraft | null;
}>;

export type MiniAppRecoveryWriteInput = Readonly<{
  expectedRevision: string | null;
  draft: MiniAppRecoveryDraft | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseMiniAppRecoveryAppId(value: unknown): MiniAppRecoveryAppId | null {
  return MINI_APP_RECOVERY_APP_IDS.find(appId => appId === value) ?? null;
}

export function parseMiniAppRecoveryBinding(value: unknown): MiniAppRecoveryBinding | null {
  if (!isRecord(value) || !hasExactKeys(value, ["owner", "appId", "target"])) return null;
  const owner = value["owner"];
  const target = value["target"];
  const appId = parseMiniAppRecoveryAppId(value["appId"]);
  if (
    !appId ||
    !isRecord(owner) ||
    !hasExactKeys(owner, ["humanId", "canonicalOrigin", "serverFingerprint"]) ||
    !isNonEmptyString(owner["humanId"]) ||
    !isNonEmptyString(owner["canonicalOrigin"]) ||
    !isNonEmptyString(owner["serverFingerprint"]) ||
    !isRecord(target)
  ) return null;
  const parsedOwner: MiniAppRecoveryOwner = {
    humanId: owner["humanId"],
    canonicalOrigin: owner["canonicalOrigin"],
    serverFingerprint: owner["serverFingerprint"],
  };
  if (target["kind"] === "workspace_artifact") {
    if (
      !hasExactKeys(target, ["kind", "artifactInternalId"]) ||
      typeof target["artifactInternalId"] !== "string" ||
      !UUID.test(target["artifactInternalId"])
    ) return null;
    return {
      owner: parsedOwner,
      appId,
      target: {
        kind: "workspace_artifact",
        artifactInternalId: target["artifactInternalId"],
      },
    };
  }
  if (
    target["kind"] !== "local_file" ||
    !hasExactKeys(target, ["kind", "relayId", "canonicalPath"]) ||
    !isNonEmptyString(target["relayId"]) ||
    !isNonEmptyString(target["canonicalPath"])
  ) return null;
  return {
    owner: parsedOwner,
    appId,
    target: {
      kind: "local_file",
      relayId: target["relayId"],
      canonicalPath: target["canonicalPath"],
    },
  };
}

export function parseMiniAppRecoveryDraft(value: unknown): MiniAppRecoveryDraft | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "content", "exact", "baseSha256", "baseRevision",
  ])) return null;
  const baseSha256 = value["baseSha256"];
  const baseRevision = value["baseRevision"];
  if (
    value["version"] !== MINI_APP_RECOVERY_VERSION ||
    typeof value["content"] !== "string" ||
    typeof value["exact"] !== "boolean" ||
    !(baseSha256 === null || (typeof baseSha256 === "string" && SHA256.test(baseSha256))) ||
    !(baseRevision === null || (
      typeof baseRevision === "number" &&
      Number.isSafeInteger(baseRevision) &&
      baseRevision >= 0
    ))
  ) return null;
  return {
    version: MINI_APP_RECOVERY_VERSION,
    content: value["content"],
    exact: value["exact"],
    baseSha256,
    baseRevision,
  };
}

export function parseMiniAppRecoveryOpenInput(value: unknown): MiniAppRecoveryOpenInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ["expectedViewerId", "appId", "target"])) {
    return null;
  }
  const appId = parseMiniAppRecoveryAppId(value["appId"]);
  const target = value["target"];
  if (!isNonEmptyString(value["expectedViewerId"]) || !appId || !isRecord(target)) return null;
  if (target["kind"] === "workspace_artifact") {
    if (
      !hasExactKeys(target, ["kind", "artifactInternalId"]) ||
      typeof target["artifactInternalId"] !== "string" ||
      !UUID.test(target["artifactInternalId"])
    ) return null;
    return {
      expectedViewerId: value["expectedViewerId"],
      appId,
      target: {
        kind: "workspace_artifact",
        artifactInternalId: target["artifactInternalId"],
      },
    };
  }
  if (target["kind"] === "local_file") {
    if (
      !hasExactKeys(target, ["kind", "relayId", "candidatePath"]) ||
      !isNonEmptyString(target["relayId"]) ||
      !isNonEmptyString(target["candidatePath"])
    ) return null;
    return {
      expectedViewerId: value["expectedViewerId"],
      appId,
      target: {
        kind: "local_file",
        relayId: target["relayId"],
        candidatePath: target["candidatePath"],
      },
    };
  }
  return null;
}

export function parseMiniAppRecoveryWriteInput(value: unknown): MiniAppRecoveryWriteInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ["expectedRevision", "draft"])) return null;
  const expectedRevision = value["expectedRevision"];
  if (!(expectedRevision === null || isNonEmptyString(expectedRevision))) return null;
  if (value["draft"] === null) return { expectedRevision, draft: null };
  const draft = parseMiniAppRecoveryDraft(value["draft"]);
  return draft ? { expectedRevision, draft } : null;
}
