import { createHash } from "node:crypto";
import { HANDLE_RE } from "@nautilo/types";
import { SERVER_ROLE_RANK, type ServerRoleSlug } from "@nautilo/trust";

const ROLE_SLUGS = ["admin", "superuser", "member", "contributor", "guest"] as const;
const SECRET_KEY = /(?:password|passphrase|pin|token|secret|recovery.?codes?)/iu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_ROLLOUT_MEMBERS = 100;

export interface RolloutManifestMember {
  handle: string;
  displayName: string;
  email?: string | undefined;
  roleSlug: (typeof ROLE_SLUGS)[number];
}

export type RolloutPlanResult =
  | {
      ok: true;
      schemaVersion: 1;
      fingerprint: string;
      serverInstanceId: string;
      operations: Array<RolloutManifestMember & { index: number; idempotencyKey: string }>;
      warnings: string[];
      bounds: { maxMembers: number; requestedMembers: number };
    }
  | { ok: false; status: number; code: string; index?: number | undefined };

function hasSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, nested]) => SECRET_KEY.test(key) || hasSecretKey(nested));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function buildRolloutPlan(input: {
  manifest: unknown;
  serverInstanceId: string;
  policyRevision: string;
  callerRank: number;
  existingHandleKeys: ReadonlySet<string>;
  identityCollision(member: RolloutManifestMember): Promise<boolean>;
}): Promise<RolloutPlanResult> {
  if (hasSecretKey(input.manifest)) return { ok: false, status: 400, code: "secret_field_forbidden" };
  if (input.manifest === null || typeof input.manifest !== "object" || Array.isArray(input.manifest)) {
    return { ok: false, status: 400, code: "invalid_manifest" };
  }
  const manifest = input.manifest as Record<string, unknown>;
  if (
    Object.keys(manifest).some((key) => !new Set(["schemaVersion", "members"]).has(key))
    || manifest["schemaVersion"] !== 1
    || !Array.isArray(manifest["members"])
    || manifest["members"].length < 1
    || manifest["members"].length > MAX_ROLLOUT_MEMBERS
  ) return { ok: false, status: 400, code: "invalid_manifest" };

  const normalized: RolloutManifestMember[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of manifest["members"].entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, status: 400, code: "invalid_member", index };
    }
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some((key) => !new Set(["handle", "displayName", "email", "roleSlug"]).has(key))) {
      return { ok: false, status: 400, code: "invalid_member", index };
    }
    const handle = typeof row["handle"] === "string" ? row["handle"].trim().toLowerCase() : "";
    const displayName = typeof row["displayName"] === "string" ? row["displayName"].trim() : "";
    const email = typeof row["email"] === "string" ? row["email"].trim().toLowerCase() : undefined;
    const roleSlug = typeof row["roleSlug"] === "string" ? row["roleSlug"] : "";
    if (
      !HANDLE_RE.test(handle)
      || displayName.length < 1
      || displayName.length > 200
      || (email !== undefined && (email.length > 254 || !EMAIL.test(email)))
      || !ROLE_SLUGS.includes(roleSlug as RolloutManifestMember["roleSlug"])
    ) return { ok: false, status: 400, code: "invalid_member", index };
    const typedRole = roleSlug as RolloutManifestMember["roleSlug"];
    if (SERVER_ROLE_RANK[typedRole as ServerRoleSlug] < input.callerRank) {
      return { ok: false, status: 403, code: "delegation_ceiling", index };
    }
    const key = handle.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(key)) return { ok: false, status: 409, code: "duplicate_handle", index };
    if (input.existingHandleKeys.has(key)) return { ok: false, status: 409, code: "handle_taken", index };
    seen.add(key);
    const member = { handle, displayName, ...(email ? { email } : {}), roleSlug: typedRole };
    if (await input.identityCollision(member)) {
      return { ok: false, status: 409, code: "identity_collision", index };
    }
    normalized.push(member);
  }

  const canonical = { schemaVersion: 1 as const, members: normalized };
  const fingerprint = digest(stableJson({
    serverInstanceId: input.serverInstanceId,
    policyRevision: input.policyRevision,
    canonical,
  }));
  return {
    ok: true,
    schemaVersion: 1,
    fingerprint,
    serverInstanceId: input.serverInstanceId,
    operations: normalized.map((member, index) => ({
      index,
      ...member,
      idempotencyKey: `rollout:${fingerprint}:${index}`,
    })),
    warnings: [],
    bounds: { maxMembers: MAX_ROLLOUT_MEMBERS, requestedMembers: normalized.length },
  };
}
