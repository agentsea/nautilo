import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS =
  2 * 60 * 60 * 1_000;
export const FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS = 30 * 60 * 1_000;
export const FOREGROUND_AUTHORIZATION_MAX_SESSIONS = 256;
export const FOREGROUND_AUTHORIZATION_MAX_CHILD_VIEWS = 16;

export const FOREGROUND_AUTHORIZATION_BINDING_FIELDS = Object.freeze([
  "humanId",
  "issuingDeviceId",
  "recipientAgentId",
] as const);

export const FOREGROUND_AUTHORIZATION_IDLE_REFRESH_OUTCOMES = Object.freeze([
  "executed",
] as const);

export const FOREGROUND_AUTHORIZATION_NON_REFRESH_OUTCOMES = Object.freeze([
  "lookup_only",
  "wrong_binding",
  "authorization_unavailable",
  "content_unavailable",
  "content_invalid",
  "execution_failed",
  "cancelled",
  "deadline_exceeded",
] as const);

export const FOREGROUND_AUTHORIZATION_TERMINAL_REASONS = Object.freeze([
  "explicit_cancel",
  "absolute_expired",
  "grant_expired",
  "idle_expired",
  "recipient_lost",
  "process_lost",
  "device_revoked",
  "namespace_revision_changed",
  "domain_epoch_changed",
  "agent_policy_changed",
] as const);

export type ForegroundAuthorizationReuseSeam = Readonly<{
  id: string;
  sourcePath: string;
  anchor: string;
  currentBehavior: "one_shot";
  requiredTreatment: "preserve_and_add_reusable_layer";
}>;

/**
 * Wave 8 deliberately destroys all three custody layers after one operation.
 * Wave 9 preserves these entrypoints and adds a separate reusable recipient
 * session plus one-shot operation leases; weakening the existing paths would
 * turn single-use/background authority into reusable authority accidentally.
 */
export const FOREGROUND_AUTHORIZATION_REUSE_SEAMS = Object.freeze([
  {
    id: "bridge.capability",
    sourcePath:
      "packages/lattice-bridge/src/invocation/protected-grant-invocation.ts",
    anchor: "destroyProtectedInvocationCapability(input.capability);",
    currentBehavior: "one_shot",
    requiredTreatment: "preserve_and_add_reusable_layer",
  },
  {
    id: "runtime.lease",
    sourcePath: "packages/runtime/src/protected-execution/lease-registry.ts",
    anchor: "this.#remove(lease);",
    currentBehavior: "one_shot",
    requiredTreatment: "preserve_and_add_reusable_layer",
  },
  {
    id: "runtime.handle",
    sourcePath: "packages/runtime/src/protected-execution/broker.ts",
    anchor: "this.#handles.delete(handle);",
    currentBehavior: "one_shot",
    requiredTreatment: "preserve_and_add_reusable_layer",
  },
] satisfies readonly ForegroundAuthorizationReuseSeam[]);

export function validateForegroundAuthorizationSessionInventory(
  repositoryRoot: string,
  seams: readonly ForegroundAuthorizationReuseSeam[] =
    FOREGROUND_AUTHORIZATION_REUSE_SEAMS,
): string[] {
  const violations: string[] = [];
  const ids = new Set<string>();

  for (const seam of seams) {
    if (ids.has(seam.id)) {
      violations.push(`duplicate foreground authorization seam: ${seam.id}`);
    }
    ids.add(seam.id);
    const path = resolve(repositoryRoot, seam.sourcePath);
    if (!existsSync(path)) {
      violations.push(
        `missing foreground authorization source: ${seam.sourcePath}`,
      );
      continue;
    }
    if (!readFileSync(path, "utf8").includes(seam.anchor)) {
      violations.push(
        `missing foreground authorization anchor: ${seam.sourcePath}#${seam.anchor}`,
      );
    }
  }

  return violations.sort();
}
