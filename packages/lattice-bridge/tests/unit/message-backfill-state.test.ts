import { describe, expect, test } from "bun:test";

import {
  classifyMessageBackfillState,
  type MessageBackfillExactLifecycle,
  type MessageBackfillRole,
  type MessageBackfillStructuralCoordinate,
} from "../../src/message/message-backfill-state.ts";

const message = (
  overrides: Partial<MessageBackfillStructuralCoordinate> = {},
): MessageBackfillStructuralCoordinate => Object.freeze({
  messageId: 41,
  sessionId: "session-1",
  revision: 2,
  roomId: "room-1",
  namespaceId: "namespace-1",
  role: "assistant",
  ordinaryPresent: true,
  cryptoObjectId: null,
  ...overrides,
});

const lifecycle = (
  overrides: Partial<MessageBackfillExactLifecycle> = {},
): MessageBackfillExactLifecycle => Object.freeze({
  sessionId: "session-1",
  messageId: 41,
  revision: 2,
  cryptoObjectId: "message:v2:object-1",
  keyClass: "ai",
  completion: "complete",
  disposition: "mapped",
  parityStatus: "client_verified",
  repairIdentityPresent: false,
  ...overrides,
});

describe("Message backfill current-state classifier", () => {
  test("classifies every supported Message role from structural state", () => {
    for (const role of ["user", "assistant", "tool", "system"] satisfies MessageBackfillRole[]) {
      expect(classifyMessageBackfillState({
        message: message({ role }),
        supportedTopology: true,
      })).toEqual({ action: "encrypt", evidence: "none", reason: null });
    }
  });

  test("reuses an exact pending existing-repair lifecycle for encryption", () => {
    expect(classifyMessageBackfillState({
      message: message(),
      lifecycle: lifecycle({
        completion: "pending",
        disposition: "active",
        parityStatus: "pending",
        repairIdentityPresent: true,
      }),
      supportedTopology: true,
    })).toEqual({ action: "encrypt", evidence: "none", reason: null });
  });

  test("requires an exact current lifecycle coordinate", () => {
    for (const stale of [
      lifecycle({ sessionId: "session-older" }),
      lifecycle({ messageId: 40 }),
      lifecycle({ revision: 1 }),
    ]) {
      expect(classifyMessageBackfillState({
        message: message(), lifecycle: stale, supportedTopology: true,
      })).toEqual({
        action: "failed", evidence: "none", reason: "stale_mapping",
      });
    }
  });

  test("rejects absent, conflicting and incomplete mapped lifecycles", () => {
    const mapped = message({ cryptoObjectId: "message:v2:object-1" });
    for (const candidate of [
      null,
      lifecycle({ cryptoObjectId: "message:v2:other" }),
      lifecycle({ completion: "pending", disposition: "active", parityStatus: "pending" }),
      lifecycle({ disposition: "stale_mapping" }),
      lifecycle({ parityStatus: "pending" }),
    ]) {
      expect(classifyMessageBackfillState({
        message: mapped, lifecycle: candidate, supportedTopology: true,
      })).toEqual({
        action: "failed", evidence: "none", reason: "stale_mapping",
      });
    }
  });

  test("distinguishes independent parity from authenticated coverage", () => {
    const mapped = message({ cryptoObjectId: "message:v2:object-1" });
    for (const parityStatus of ["server_verified", "client_verified"] as const) {
      expect(classifyMessageBackfillState({
        message: mapped,
        lifecycle: lifecycle({ parityStatus }),
        supportedTopology: true,
      })).toEqual({
        action: "none", evidence: "independent_parity", reason: null,
      });
    }
    for (const parityStatus of ["server_authenticated", "client_authenticated"] as const) {
      expect(classifyMessageBackfillState({
        message: mapped,
        lifecycle: lifecycle({ parityStatus }),
        supportedTopology: true,
      })).toEqual({
        action: "verify", evidence: "authenticated", reason: null,
      });
    }
  });

  test("accepts a restored ordinary sibling without promoting its evidence", () => {
    for (const scenario of [
      { parityStatus: "server_authenticated", evidence: "authenticated" },
      { parityStatus: "client_authenticated", evidence: "authenticated" },
      { parityStatus: "server_verified", evidence: "independent_parity" },
      { parityStatus: "client_verified", evidence: "independent_parity" },
    ] as const) {
      expect(classifyMessageBackfillState({
        message: message({ cryptoObjectId: "message:v2:object-1" }),
        lifecycle: lifecycle({ parityStatus: scenario.parityStatus }),
        ordinaryRestorationAccepted: true,
        supportedTopology: true,
      })).toEqual({
        action: "none", evidence: scenario.evidence, reason: null,
      });
    }
  });

  test("does not let an ordinary restoration receipt rescue a stale mapping", () => {
    for (const stale of [
      lifecycle({ revision: 1, parityStatus: "client_authenticated" }),
      lifecycle({
        cryptoObjectId: "message:v2:other",
        parityStatus: "client_authenticated",
      }),
    ]) {
      expect(classifyMessageBackfillState({
        message: message({ cryptoObjectId: "message:v2:object-1" }),
        lifecycle: stale,
        ordinaryRestorationAccepted: true,
        supportedTopology: true,
      })).toEqual({
        action: "failed", evidence: "none", reason: "stale_mapping",
      });
    }
  });

  test("restores an ordinary sibling without overwriting accepted ciphertext", () => {
    for (const parityStatus of ["client_verified", "server_authenticated"] as const) {
      expect(classifyMessageBackfillState({
        message: message({
          ordinaryPresent: false,
          cryptoObjectId: "message:v2:object-1",
        }),
        lifecycle: lifecycle({ parityStatus }),
        supportedTopology: true,
      })).toEqual({
        action: "restore",
        evidence: parityStatus === "client_verified"
          ? "independent_parity"
          : "authenticated",
        reason: null,
      });
    }
  });

  test("reports neither-present rows as failed", () => {
    expect(classifyMessageBackfillState({
      message: message({ ordinaryPresent: false }),
      supportedTopology: true,
    })).toEqual({
      action: "failed", evidence: "none", reason: "neither_present",
    });
    expect(classifyMessageBackfillState({
      message: message({ ordinaryPresent: false }),
      lifecycle: lifecycle({
        completion: "pending",
        disposition: "active",
        parityStatus: "pending",
        repairIdentityPresent: true,
      }),
      supportedTopology: true,
    })).toEqual({
      action: "failed", evidence: "none", reason: "neither_present",
    });
  });

  test("reports inconsistent pending repair state instead of allocating over it", () => {
    for (const candidate of [
      lifecycle({ completion: "pending", disposition: "active", parityStatus: "pending" }),
      lifecycle({
        completion: "pending", disposition: "blocked",
        parityStatus: "pending", repairIdentityPresent: true,
      }),
      lifecycle({ repairIdentityPresent: true }),
    ]) {
      expect(classifyMessageBackfillState({
        message: message(), lifecycle: candidate, supportedTopology: true,
      })).toEqual({
        action: "failed", evidence: "none", reason: "stale_mapping",
      });
    }
  });

  test("unsupported topology wins regardless of available representations", () => {
    expect(classifyMessageBackfillState({
      message: message({ cryptoObjectId: "message:v2:object-1" }),
      lifecycle: lifecycle(),
      supportedTopology: false,
    })).toEqual({
      action: "unsupported", evidence: "none", reason: "unsupported_topology",
    });
    expect(classifyMessageBackfillState({
      message: message({ ordinaryPresent: false }),
      supportedTopology: false,
    })).toEqual({
      action: "unsupported", evidence: "none", reason: "unsupported_topology",
    });
  });
});
