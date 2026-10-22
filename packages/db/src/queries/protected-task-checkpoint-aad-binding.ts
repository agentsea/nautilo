/**
 * Retained public AEAD metadata inside the exact sealed park receipt. This is
 * not current Namespace, policy, device, or execution authority.
 */
export type ProtectedTaskCheckpointAadBinding = Readonly<{
  version: 1;
  namespaceId: string;
  domainId: string;
  namespaceAccessRevision: number;
  policyRevision: number;
}>;

export function parseProtectedTaskCheckpointAadBinding(
  value: unknown,
): ProtectedTaskCheckpointAadBinding | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Readonly<Record<string, unknown>>;
  if (Object.keys(row).sort().join(",")
      !== "domainId,namespaceAccessRevision,namespaceId,policyRevision,version"
    || row["version"] !== 1
    || typeof row["namespaceId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(row["namespaceId"])
    || typeof row["domainId"] !== "string" || row["domainId"].length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(row["domainId"])
    || typeof row["namespaceAccessRevision"] !== "number" || !Number.isSafeInteger(row["namespaceAccessRevision"]) || row["namespaceAccessRevision"] < 0
    || typeof row["policyRevision"] !== "number" || !Number.isSafeInteger(row["policyRevision"]) || row["policyRevision"] < 1) return null;
  return Object.freeze({ version: 1, namespaceId: row["namespaceId"], domainId: row["domainId"],
    namespaceAccessRevision: row["namespaceAccessRevision"], policyRevision: row["policyRevision"] });
}

export function sameProtectedTaskCheckpointAadBinding(
  left: ProtectedTaskCheckpointAadBinding | undefined,
  right: ProtectedTaskCheckpointAadBinding | undefined,
): boolean {
  return left === undefined || right === undefined ? left === right
    : left.version === right.version && left.namespaceId === right.namespaceId
      && left.domainId === right.domainId && left.namespaceAccessRevision === right.namespaceAccessRevision
      && left.policyRevision === right.policyRevision;
}
