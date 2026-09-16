/**
 * Exact, scope-bound draft payload for host-owned recovery storage.
 *
 * This module deliberately does not choose a storage key or persistence
 * mechanism. The host supplies an opaque document scope and stores the record
 * through its existing state authority. Records from any other scope are
 * rejected rather than offered as a cross-document fallback.
 */

export const DESIGN_DRAFT_RECOVERY_VERSION = 1;

export type DesignDraftBase = {
  sha256: string | null;
  revision: number | null;
};

export type DesignDraftRecoveryRecord = {
  version: typeof DESIGN_DRAFT_RECOVERY_VERSION;
  scope: string;
  content: string;
  /** False means content is the last serializable snapshot, not the complete in-memory edit. */
  exact: boolean;
  base: DesignDraftBase;
};

export type DesignDraftRecoveryAdapter = {
  write(record: DesignDraftRecoveryRecord | null): Promise<void>;
};

export type DesignDraftRecoveryStateBridge = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableRevision(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

export function createDesignDraftRecoveryRecord(
  scope: string,
  content: string,
  base: DesignDraftBase,
  exact = true,
): DesignDraftRecoveryRecord {
  if (scope.length === 0) throw new Error("Draft recovery requires a document scope.");
  return {
    version: DESIGN_DRAFT_RECOVERY_VERSION,
    scope,
    content,
    exact,
    base: { ...base },
  };
}

/** Parse only a record belonging to the exact host-supplied document scope. */
export function parseDesignDraftRecoveryRecord(
  value: unknown,
  expectedScope: string,
): DesignDraftRecoveryRecord | null {
  if (
    expectedScope.length === 0 ||
    !isPlainRecord(value) ||
    value["version"] !== DESIGN_DRAFT_RECOVERY_VERSION ||
    value["scope"] !== expectedScope ||
    typeof value["content"] !== "string" ||
    typeof value["exact"] !== "boolean" ||
    !isPlainRecord(value["base"]) ||
    !isNullableString(value["base"]["sha256"]) ||
    !isNullableRevision(value["base"]["revision"])
  ) {
    return null;
  }
  return {
    version: DESIGN_DRAFT_RECOVERY_VERSION,
    scope: expectedScope,
    content: value["content"],
    exact: value["exact"],
    base: {
      sha256: value["base"]["sha256"],
      revision: value["base"]["revision"],
    },
  };
}

export function draftRecoveryBaseMatches(
  record: DesignDraftRecoveryRecord,
  currentBase: DesignDraftBase,
): boolean {
  return (
    record.base.sha256 === currentBase.sha256 &&
    record.base.revision === currentBase.revision
  );
}

/**
 * Adapt the host's existing document state authority. The caller owns the key
 * and scope choices; this helper only preserves the exact record or clears it.
 */
export function designDraftRecoveryStateAdapter(
  state: DesignDraftRecoveryStateBridge,
  key: string,
): DesignDraftRecoveryAdapter {
  if (key.length === 0) throw new Error("Draft recovery requires a host state key.");
  return {
    write: async (record) => state.set(key, record),
  };
}

export async function readDesignDraftRecoveryState(
  state: DesignDraftRecoveryStateBridge,
  key: string,
  expectedScope: string,
): Promise<DesignDraftRecoveryRecord | null> {
  if (key.length === 0) throw new Error("Draft recovery requires a host state key.");
  return parseDesignDraftRecoveryRecord(await state.get(key), expectedScope);
}
