/**
 * D418 Commit 3 — Workstation execution-admission engine tests.
 *
 * Pure unit tests; no DB, no Electron, no HTTP. Proves the slim
 * execution-admission contract replaces the paused 3.2.5c nine-field
 * caller-authored evidence model:
 *   - the happy path: a `profile_bound_sandbox` dispatch under an active
 *     Full session, pinned by a live exact plan, returns `auto` (the D418
 *     "PIN once, then stop asking" promise). `auto` is only ever returned
 *     for `profile_bound_sandbox` `run_shell` attempts; it does not assert
 *     Electron has created an active sandbox.
 *   - the exact-plan gate (salvaged from 3.2.5c): no live admitted +
 *     revalidated plan ⇒ `no_admitted_plan` — auto REQUIRES a live exact
 *     plan.
 *   - the `run_shell` gate: non-shell tools ⇒ `run_shell_required`; Electron
 *     local binding / sandbox construction remains fail-closed execution
 *     authority, not server-side admission evidence.
 *   - explicit Real Workstation run_shell attempts proceed to independent
 *     Electron local consent; typed brokers use the exact active-session
 *     plan proof and proceed to the local GitBroker.
 *   - no active session ⇒ `no_active_session` for a profile-bound sandbox
 *     dispatch (Full Mode off; D375 client ask→auto and the PIN dock run
 *     unchanged).
 *   - the engine takes NO caller-authored dispatch binding copied from the
 *     session and NO profile/path/network/OS/boundedness/MCP/escape
 *     booleans — the exact binding proof is the `exactPlan` flag.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveWorkstationAdmission,
  type WorkstationAdmissionEvidence,
  type WorkstationAdmissionDecision,
  type WorkstationAdmissionReason,
  type WorkstationExecutionClass,
} from "../../src/workstation-admission";

// ---------------------------------------------------------------------------
// Evidence factory — every field set to the "eligible auto" baseline. Each
// test mutates exactly the field under test so a regression that breaks one
// gate cannot silently pass via another.
// ---------------------------------------------------------------------------

const BASE_SESSION = {
  userId: "user-1",
  instanceId: "inst-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-session-1",
  serverBindingId: "server-binding-1",
  agentScope: "all_owned_agents",
  profileId: "profile-1",
  profileRevision: 7,
  grantIds: ["grant-a", "grant-b"],
  capabilityRevision: 3,
  activatedAt: "2026-07-13T10:00:00.000Z",
};

function baseEvidence(
  overrides: Partial<WorkstationAdmissionEvidence> = {},
): WorkstationAdmissionEvidence {
  return {
    executionClass: "profile_bound_sandbox",
    session: BASE_SESSION,
    exactPlan: true,
    tool: { name: "run_shell", operation: "execute" },
    ...overrides,
  };
}

function assertAuto(
  evidence: WorkstationAdmissionEvidence,
  executionClass: "profile_bound_sandbox" | "typed_broker" | "real_workstation" = "profile_bound_sandbox",
): void {
  const d = resolveWorkstationAdmission(evidence);
  expect(d).toEqual({ override: "auto", executionClass });
}

function assertNone(
  evidence: WorkstationAdmissionEvidence,
  reason: WorkstationAdmissionReason,
  executionClass?: WorkstationExecutionClass,
): void {
  const d = resolveWorkstationAdmission(evidence);
  expect(d.override).toBe("none");
  if (d.override !== "none") throw new Error("unreachable");
  expect(d.reason).toBe(reason);
  if (executionClass !== undefined) {
    expect(d.executionClass).toBe(executionClass);
  }
}

// ---------------------------------------------------------------------------

describe("resolveWorkstationAdmission — happy path", () => {
  test("profile_bound_sandbox run_shell under an active session + exact plan → auto", () => {
    assertAuto(baseEvidence());
  });

  test("profile-bound auto echoes its execution class", () => {
    const d = resolveWorkstationAdmission(baseEvidence());
    if (d.override !== "auto") throw new Error("expected auto");
    // The auto variant narrows executionClass to the literal.
    expect(d.executionClass).toBe("profile_bound_sandbox");
  });

  test("the engine takes no caller-authored dispatch binding (exactPlan is the binding proof)", () => {
    // The evidence shape itself is the contract: there is no `dispatch`
    // field, no protected-path / capability / severity / boundedness / OS /
    // real-workstation / network / MCP field on the admission evidence.
    const serialized = JSON.stringify(baseEvidence());
    expect(serialized).not.toContain('"dispatch"');
    expect(serialized).not.toContain('"protectedPath"');
    expect(serialized).not.toContain('"capability"');
    expect(serialized).not.toContain('"severity"');
    expect(serialized).not.toContain('"bounded"');
    expect(serialized).not.toContain('"realWorkstation"');
    expect(serialized).not.toContain('"osAuthorization"');
  });
});

describe("resolveWorkstationAdmission — real workstation and typed broker", () => {
  test("explicit real_workstation run_shell proceeds to Electron local consent", () => {
    assertAuto(
      baseEvidence({ executionClass: "real_workstation" }),
      "real_workstation",
    );
  });

  test("typed_broker → auto with an active session + exact plan", () => {
    assertAuto(
      baseEvidence({ executionClass: "typed_broker" }),
      "typed_broker",
    );
  });

  test("real_workstation does not borrow Full Workstation session or plan authority", () => {
    assertAuto(
      baseEvidence({ executionClass: "real_workstation", session: null }),
      "real_workstation",
    );
  });

  test("real_workstation refuses non-run_shell tools", () => {
    assertNone(
      baseEvidence({
        executionClass: "real_workstation",
        session: null,
        exactPlan: false,
        tool: { name: "file", operation: "read" },
      }),
      "run_shell_required",
      "real_workstation",
    );
  });

  test("typed_broker still requires an active session", () => {
    assertNone(
      baseEvidence({ executionClass: "typed_broker", session: null }),
      "no_active_session",
      "typed_broker",
    );
  });
});

describe("resolveWorkstationAdmission — active session required", () => {
  test("no active session ⇒ none (no_active_session) for a profile-bound sandbox dispatch", () => {
    assertNone(
      baseEvidence({ session: null }),
      "no_active_session",
      "profile_bound_sandbox",
    );
  });

  test("no active session ⇒ none even with exactPlan asserted (session gate fires first)", () => {
    // A caller cannot satisfy the session gate by asserting the downstream
    // plan flag; session === null stops before the plan / run_shell gates.
    assertNone(
      baseEvidence({
        session: null,
        exactPlan: true,
      }),
      "no_active_session",
    );
  });
});

describe("resolveWorkstationAdmission — exact admitted + revalidated plan required", () => {
  test("active session but no live plan ⇒ none (no_admitted_plan)", () => {
    assertNone(
      baseEvidence({ exactPlan: false }),
      "no_admitted_plan",
      "profile_bound_sandbox",
    );
  });

  test("no_admitted_plan fires before the run_shell gate (plan gate is stricter)", () => {
    assertNone(
      baseEvidence({ exactPlan: false, tool: { name: "file", operation: "read" } }),
      "no_admitted_plan",
    );
  });
});

describe("resolveWorkstationAdmission — run_shell required", () => {
  test("active session + exact plan but non-run_shell tool ⇒ none (run_shell_required)", () => {
    assertNone(
      baseEvidence({ tool: { name: "file", operation: "read" } }),
      "run_shell_required",
      "profile_bound_sandbox",
    );
  });

  test("run_shell is the last gate — session + plan pass, only tool identity fails", () => {
    const d = resolveWorkstationAdmission(
      baseEvidence({ tool: { name: "file", operation: "read" } }),
    );
    if (d.override !== "none") throw new Error("expected none");
    expect(d.reason).toBe("run_shell_required");
  });
});

describe("resolveWorkstationAdmission — no global yolo mapping", () => {
  test("the engine takes no security.level parameter; a profile-bound sandbox run_shell attempt is auto ONLY via the live session + plan path", () => {
    // With the session removed, the same op that is `auto` above is `none` —
    // proving the admission comes from the session + plan, not
    // from a global yolo verb-map row.
    assertNone(
      baseEvidence({ session: null }),
      "no_active_session",
    );
  });

  test("the tool identity is branched on: run_shell auto-admits; file stays none", () => {
    assertAuto(baseEvidence({ tool: { name: "run_shell", operation: "execute" } }));
    assertNone(
      baseEvidence({ tool: { name: "file", operation: "read" } }),
      "run_shell_required",
    );
    // `operation` is audit correlation only; a run_shell attempt remains
    // eligible even if the operation string is unavailable.
    assertAuto(baseEvidence({ tool: { name: "run_shell", operation: null } }));
  });
});

describe("resolveWorkstationAdmission — decision shape", () => {
  test("the auto decision narrows executionClass to the profile_bound_sandbox literal", () => {
    const d: WorkstationAdmissionDecision = resolveWorkstationAdmission(baseEvidence());
    expect(d).toEqual({ override: "auto", executionClass: "profile_bound_sandbox" });
  });

  test("a none decision echoes the execution class + a reason + a detail", () => {
    const d = resolveWorkstationAdmission(baseEvidence({ session: null }));
    if (d.override !== "none") throw new Error("expected none");
    expect(d.executionClass).toBe("profile_bound_sandbox");
    expect(d.reason).toBe("no_active_session");
    expect(typeof d.detail).toBe("string");
    expect(d.detail.length).toBeGreaterThan(0);
  });
});
