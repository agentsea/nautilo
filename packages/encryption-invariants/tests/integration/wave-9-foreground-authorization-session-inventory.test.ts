import { resolve } from "node:path";

import {
  FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
  FOREGROUND_AUTHORIZATION_BINDING_FIELDS,
  FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS,
  FOREGROUND_AUTHORIZATION_IDLE_REFRESH_OUTCOMES,
  FOREGROUND_AUTHORIZATION_MAX_CHILD_VIEWS,
  FOREGROUND_AUTHORIZATION_MAX_SESSIONS,
  FOREGROUND_AUTHORIZATION_NON_REFRESH_OUTCOMES,
  FOREGROUND_AUTHORIZATION_REUSE_SEAMS,
  FOREGROUND_AUTHORIZATION_TERMINAL_REASONS,
  validateForegroundAuthorizationSessionInventory,
} from "../../src/node/foreground-authorization-session-inventory";
import { describe, expect, it } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 9 foreground authorization session contract", () => {
  it("locks the central absolute, idle, binding, and capacity policy", () => {
    expect(FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS).toBe(7_200_000);
    expect(FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS).toBe(1_800_000);
    expect(FOREGROUND_AUTHORIZATION_MAX_SESSIONS).toBe(256);
    expect(FOREGROUND_AUTHORIZATION_MAX_CHILD_VIEWS).toBe(16);
    expect(FOREGROUND_AUTHORIZATION_BINDING_FIELDS).toEqual([
      "humanId",
      "issuingDeviceId",
      "recipientAgentId",
    ]);
  });

  it("refreshes idle time only after a successful current-authorized operation", () => {
    expect(FOREGROUND_AUTHORIZATION_IDLE_REFRESH_OUTCOMES).toEqual([
      "executed",
    ]);
    expect(FOREGROUND_AUTHORIZATION_NON_REFRESH_OUTCOMES).toEqual([
      "lookup_only",
      "wrong_binding",
      "authorization_unavailable",
      "content_unavailable",
      "content_invalid",
      "execution_failed",
      "cancelled",
      "deadline_exceeded",
    ]);
  });

  it("locks every terminal teardown reason", () => {
    expect(FOREGROUND_AUTHORIZATION_TERMINAL_REASONS).toEqual([
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
    ]);
  });

  it("preserves the Wave 8 one-shot APIs and requires a separate reuse layer", () => {
    expect(
      FOREGROUND_AUTHORIZATION_REUSE_SEAMS.map((entry) => entry.id),
    ).toEqual([
      "bridge.capability",
      "runtime.lease",
      "runtime.handle",
    ]);
    expect(
      FOREGROUND_AUTHORIZATION_REUSE_SEAMS.every(
        (entry) =>
          entry.currentBehavior === "one_shot"
          && entry.requiredTreatment === "preserve_and_add_reusable_layer",
      ),
    ).toBeTrue();
    expect(
      validateForegroundAuthorizationSessionInventory(repositoryRoot),
    ).toEqual([]);
  });

  it("fails closed when a one-shot destruction anchor drifts", () => {
    expect(validateForegroundAuthorizationSessionInventory(repositoryRoot, [{
      id: "bridge.capability",
      sourcePath:
        "packages/lattice-bridge/src/invocation/protected-grant-invocation.ts",
      anchor: "missing M237 one-shot anchor",
      currentBehavior: "one_shot",
      requiredTreatment: "preserve_and_add_reusable_layer",
    }])).toEqual([
      "missing foreground authorization anchor: packages/lattice-bridge/src/invocation/protected-grant-invocation.ts#missing M237 one-shot anchor",
    ]);
  });
});
