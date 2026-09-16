import { describe, expect, it } from "bun:test";
import {
  FULL_WORKSTATION_AGENT_SCOPE,
  InMemoryWorkstationSessionRegistry,
  type FullWorkstationBinding,
  type WorkstationAccessAuditEvent,
} from "../../src/workstation-session-registry";

const FIXED_TS = "2026-07-13T12:00:00.000Z";
const clock = () => new Date(FIXED_TS);

function binding(overrides: Partial<FullWorkstationBinding> = {}): FullWorkstationBinding {
  return {
    userId: "user-1",
    instanceId: "instance-1",
    relayId: "relay-1",
    desktopSessionId: "desktop-session-1",
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-1",
    agentScope: FULL_WORKSTATION_AGENT_SCOPE,
    profileId: "profile-1",
    profileRevision: 1,
    grantIds: ["grant-1", "grant-2"],
    capabilityRevision: 10,
    ...overrides,
  };
}

describe("InMemoryWorkstationSessionRegistry — activate (D418)", () => {
  it("activates an eligible session matching the authoritative binding", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding();
    const result = registry.activate(s, s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("activated");
    expect(result.session).not.toBeNull();
    expect(result.session?.activatedAt).toBe(FIXED_TS);
    expect(registry.get("user-1")?.grantIds).toEqual(["grant-1", "grant-2"]);
    expect(audit.map((e) => e.kind)).toEqual(["workstation_session_activated"]);
    expect(audit[0]?.outcome).toBe("activated");
    // No secrets / command output in the audit row.
    expect(audit[0]).not.toHaveProperty("pin");
  });

  it("activates an eligible session with no durable grant ids", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ grantIds: [] });
    const result = registry.activate(s, s);
    expect(result).toMatchObject({ ok: true, outcome: "activated" });
    expect(registry.get("user-1")?.grantIds).toEqual([]);
  });

  it("denies an ineligible headless relay (no desktopSessionId)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const headless = binding({ desktopSessionId: "" });
    const result = registry.activate(headless, headless);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
    expect(registry.get("user-1")).toBeNull();
  });

  it("denies a foreign binding that does not match the authoritative resolver output", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const client = binding({ serverBindingId: "client-claimed" });
    const authoritative = binding({ serverBindingId: "authoritative" });
    const result = registry.activate(client, authoritative);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("foreign_binding");
    expect(registry.get("user-1")).toBeNull();
  });

  it("denies a session whose grantIds are broader than the authoritative binding", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const authoritative = binding({ grantIds: ["grant-1"] });
    const session = binding({ grantIds: ["grant-1", "grant-2"] });
    const result = registry.activate(session, authoritative);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("broader_revision");
  });

  it("denies a stale capabilityRevision relative to the authoritative binding", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const authoritative = binding({ capabilityRevision: 20 });
    const session = binding({ capabilityRevision: 10 });
    const result = registry.activate(session, authoritative);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("stale_revision");
  });

  it("denies a duplicate of the already-active session", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding();
    registry.activate(s, s);
    const dup = registry.activate(s, s);
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.denialCode).toBe("duplicate_active");
  });

  it("denies a scope change at the same capabilityRevision (broader_revision)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ grantIds: ["grant-1", "grant-2"], capabilityRevision: 10 });
    registry.activate(s, s);
    // Same revision, narrower content — forbidden without a bump.
    const narrower = binding({ grantIds: ["grant-1"], capabilityRevision: 10 });
    const auth = binding({ grantIds: ["grant-1"], capabilityRevision: 10 });
    const result = registry.activate(narrower, auth);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("broader_revision");
  });

  it("switches an authoritative restarted desktop session at the same capability revision", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const prior = binding({ desktopSessionId: "desktop-session-before-restart" });
    expect(registry.activate(prior, prior)).toMatchObject({ ok: true, outcome: "activated" });
    const restarted = binding({ desktopSessionId: "desktop-session-after-restart" });
    const result = registry.activate(restarted, restarted);
    expect(result).toMatchObject({ ok: true, outcome: "switched" });
    expect(registry.get("user-1")?.desktopSessionId).toBe("desktop-session-after-restart");
    expect(audit.at(-1)?.kind).toBe("workstation_session_switched");
  });

  it("narrows the active session on a higher revision with a grant subset", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding({ grantIds: ["grant-1", "grant-2"], capabilityRevision: 10 });
    registry.activate(s, s);
    const narrowed = binding({ grantIds: ["grant-1"], capabilityRevision: 11 });
    const result = registry.activate(narrowed, narrowed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("narrowed");
    expect(registry.get("user-1")?.grantIds).toEqual(["grant-1"]);
    expect(registry.get("user-1")?.capabilityRevision).toBe(11);
    expect(audit.at(-1)?.kind).toBe("workstation_session_narrowed");
  });

  it("narrows the active session to an empty durable grant set at a higher revision", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding({ grantIds: ["grant-1"], capabilityRevision: 10 });
    registry.activate(s, s);
    const narrowed = binding({ grantIds: [], capabilityRevision: 11 });
    const result = registry.activate(narrowed, narrowed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("narrowed");
    expect(result.session?.grantIds).toEqual([]);
    expect(registry.get("user-1")?.grantIds).toEqual([]);
    expect(audit.at(-1)?.kind).toBe("workstation_session_narrowed");
  });

  it("broadens at the same serverBindingId after a higher authoritative revision", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding({ grantIds: ["grant-1"], capabilityRevision: 10 });
    registry.activate(s, s);
    const broader = binding({ grantIds: ["grant-1", "grant-2"], capabilityRevision: 11 });
    const result = registry.activate(broader, broader);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("broadened");
    expect(registry.get("user-1")?.grantIds).toEqual(["grant-1", "grant-2"]);
    expect(audit.at(-1)?.kind).toBe("workstation_session_broadened");
  });

  it("treats a serverBindingId mismatch as a server switch and replaces the session", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding({ serverBindingId: "binding-A", capabilityRevision: 10 });
    registry.activate(s, s);
    const switched = binding({ serverBindingId: "binding-B", capabilityRevision: 12 });
    const result = registry.activate(switched, switched);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("switched");
    expect(registry.get("user-1")?.serverBindingId).toBe("binding-B");
    expect(audit.at(-1)?.kind).toBe("workstation_session_switched");
  });

  it("on a server switch to an empty durable grant set, stores the new coherent session", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ grantIds: ["grant-1"], capabilityRevision: 10 });
    registry.activate(s, s);
    const switched = binding({
      serverBindingId: "binding-B",
      grantIds: [],
      capabilityRevision: 11,
    });
    const result = registry.activate(switched, switched);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("switched");
    expect(registry.get("user-1")).toMatchObject({
      serverBindingId: "binding-B",
      grantIds: [],
    });
  });

  it("denies a stale revision relative to the already-active session", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ capabilityRevision: 10 });
    registry.activate(s, s);
    const stale = binding({ grantIds: ["grant-1"], capabilityRevision: 9 });
    const auth = binding({ grantIds: ["grant-1"], capabilityRevision: 9 });
    const result = registry.activate(stale, auth);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("stale_revision");
  });

  it("rejects an invalid agentScope", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const bad = binding({ agentScope: "cross_subject_wildcard" as unknown as typeof FULL_WORKSTATION_AGENT_SCOPE });
    const result = registry.activate(bad, bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
  });

  it("denies a binding whose profileRevision is 0 (must be >= 1)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const zero = binding({ profileRevision: 0 });
    const result = registry.activate(zero, zero);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
    expect(result.reason).toContain("profileRevision");
    expect(registry.get("user-1")).toBeNull();
  });

  it("denies a binding whose capabilityRevision is 0 (must be >= 1)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const zero = binding({ capabilityRevision: 0 });
    const result = registry.activate(zero, zero);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
    expect(result.reason).toContain("capabilityRevision");
    expect(registry.get("user-1")).toBeNull();
  });

  it("accepts an empty durable grant set carrying a positive capabilityRevision", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const initial = binding({ grantIds: ["grant-1"], capabilityRevision: 10 });
    registry.activate(initial, initial);
    // A higher positive revision may narrow to no durable grants; the revision
    // floor is independent of the durable grant set.
    const narrowed = binding({ grantIds: [], capabilityRevision: 11 });
    const result = registry.activate(narrowed, narrowed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("narrowed");
    expect(registry.get("user-1")?.grantIds).toEqual([]);
  });

  it("emits a denied audit event on rejection", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const headless = binding({ desktopSessionId: "" });
    registry.activate(headless, headless);
    expect(audit[0]?.kind).toBe("workstation_session_denied");
    expect(audit[0]?.denialCode).toBe("ineligible_binding");
  });
});

describe("InMemoryWorkstationSessionRegistry — pending authorization (D418)", () => {
  it("issues a zero-grant revision-0 ticket without activating a session, then completes once on an advertised zero-grant revision bump", () => {
    const registry = new InMemoryWorkstationSessionRegistry({
      now: clock,
      mintPendingTicket: () => "opaque-ticket",
    });
    const pending = registry.issuePendingAuthorization({
      userId: "user-1",
      instanceId: "instance-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-1",
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      agentScope: FULL_WORKSTATION_AGENT_SCOPE,
      profileId: "profile-1",
      profileRevision: 1,
      baselineCapabilityRevision: 0,
    });
    expect(pending.ticket).toBe("opaque-ticket");
    expect(registry.get("user-1")).toBeNull();
    const completed = registry.completePendingAuthorization(
      pending.ticket,
      binding({ capabilityRevision: 1, grantIds: [] }),
    );
    expect(completed.ok).toBe(true);
    expect(registry.get("user-1")?.grantIds).toEqual([]);
    const replay = registry.completePendingAuthorization(
      pending.ticket,
      binding({ capabilityRevision: 1, grantIds: [] }),
    );
    expect(replay).toMatchObject({ ok: false, denialCode: "invalid_pending_authorization" });
  });

  it("does not commit a session when the advertised revision did not advance", () => {
    const registry = new InMemoryWorkstationSessionRegistry({
      now: clock,
      mintPendingTicket: () => "ticket",
    });
    const pending = registry.issuePendingAuthorization({
      userId: "user-1", instanceId: "instance-1", relayId: "relay-1",
      desktopSessionId: "desktop-session-1", serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      agentScope: FULL_WORKSTATION_AGENT_SCOPE, profileId: "profile-1",
      profileRevision: 1, baselineCapabilityRevision: 0,
    });
    const result = registry.completePendingAuthorization(
      pending.ticket,
      binding({ capabilityRevision: 0, grantIds: [] }),
    );
    expect(result).toMatchObject({ ok: false, denialCode: "invalid_pending_authorization" });
    expect(registry.get("user-1")).toBeNull();
  });

  it("expires pending authorizations without ever creating a session", () => {
    let now = new Date(FIXED_TS);
    const registry = new InMemoryWorkstationSessionRegistry({
      now: () => now,
      mintPendingTicket: () => "expiring-ticket",
      pendingAuthorizationTtlMs: 10,
    });
    const pending = registry.issuePendingAuthorization({
      userId: "user-1", instanceId: "instance-1", relayId: "relay-1",
      desktopSessionId: "desktop-session-1", serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      agentScope: FULL_WORKSTATION_AGENT_SCOPE, profileId: "profile-1",
      profileRevision: 1, baselineCapabilityRevision: 0,
    });
    now = new Date(now.getTime() + 11);
    expect(registry.peekPendingAuthorization(pending.ticket)).toBeNull();
    expect(registry.get("user-1")).toBeNull();
  });

  it("D418 Commit 2 — rejects completion when pairingGeneration drifted from the pending authorization (re-pair between phases)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({
      now: clock,
      mintPendingTicket: () => "ticket",
    });
    const pending = registry.issuePendingAuthorization({
      userId: "user-1", instanceId: "instance-1", relayId: "relay-1",
      desktopSessionId: "desktop-session-1", serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      agentScope: FULL_WORKSTATION_AGENT_SCOPE, profileId: "profile-1",
      profileRevision: 1, baselineCapabilityRevision: 0,
    });
    // The relay re-paired between phase one and two: the advertised binding
    // now carries a different server-derived pairingGeneration.
    const result = registry.completePendingAuthorization(
      pending.ticket,
      binding({ capabilityRevision: 1, grantIds: ["policy-pack-grant"], pairingGeneration: "pairing-2" }),
    );
    expect(result).toMatchObject({ ok: false, denialCode: "invalid_pending_authorization" });
    expect(registry.get("user-1")).toBeNull();
  });
});

describe("InMemoryWorkstationSessionRegistry — disable (D418)", () => {
  it("is user-bound and idempotent", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding();
    registry.activate(s, s);
    const first = registry.disable("user-1");
    expect(first.ok).toBe(true);
    expect(first.outcome).toBe("disabled");
    expect(registry.get("user-1")).toBeNull();
    // Idempotent: disabling again is a no-op success.
    const second = registry.disable("user-1");
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe("not_active");
    const disabledKinds = audit.filter((e) => e.kind === "workstation_session_disabled").map((e) => e.outcome);
    expect(disabledKinds).toEqual(["disabled", "not_active"]);
  });

  it("does not disable another user's session", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const a = binding({ userId: "user-A" });
    const b = binding({ userId: "user-B" });
    registry.activate(a, a);
    registry.activate(b, b);
    registry.disable("user-A");
    expect(registry.get("user-A")).toBeNull();
    expect(registry.get("user-B")?.userId).toBe("user-B");
  });
});

describe("InMemoryWorkstationSessionRegistry — invalidateForRelayBinding (D418)", () => {
  it("invalidates the active session matching the relay binding", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ serverBindingId: "binding-1", relayId: "relay-1", desktopSessionId: "desktop-1" });
    registry.activate(s, s);
    const result = registry.invalidateForRelayBinding({
      userId: "user-1",
      serverBindingId: "binding-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
    });
    expect(result.invalidated).toBe(true);
    expect(registry.get("user-1")).toBeNull();
  });

  it("does not invalidate when the serverBindingId differs", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ serverBindingId: "binding-1" });
    registry.activate(s, s);
    const result = registry.invalidateForRelayBinding({
      userId: "user-1",
      serverBindingId: "binding-other",
    });
    expect(result.invalidated).toBe(false);
    expect(registry.get("user-1")?.serverBindingId).toBe("binding-1");
  });

  it("does not invalidate when an optional relayId/desktopSessionId filter mismatches", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ serverBindingId: "binding-1", relayId: "relay-1", desktopSessionId: "desktop-1" });
    registry.activate(s, s);
    const r = registry.invalidateForRelayBinding({
      userId: "user-1",
      serverBindingId: "binding-1",
      relayId: "relay-other",
    });
    expect(r.invalidated).toBe(false);
    expect(registry.get("user-1")).not.toBeNull();
  });

  it("is a no-op when no session is active", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const r = registry.invalidateForRelayBinding({ userId: "user-1", serverBindingId: "binding-1" });
    expect(r.invalidated).toBe(false);
  });
});

describe("InMemoryWorkstationSessionRegistry — no persistence", () => {
  it("starts empty and stores nothing across instances", () => {
    const a = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding();
    a.activate(s, s);
    expect(a.get("user-1")).not.toBeNull();
    const b = new InMemoryWorkstationSessionRegistry({ now: clock });
    expect(b.get("user-1")).toBeNull();
  });
});

describe("InMemoryWorkstationSessionRegistry — pairingGeneration (D418 Commit 2)", () => {
  it("denies a binding whose pairingGeneration is empty (must be server-derived + non-empty)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const noGeneration = binding({ pairingGeneration: "" });
    const result = registry.activate(noGeneration, noGeneration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
    expect(result.reason).toContain("pairingGeneration");
    expect(registry.get("user-1")).toBeNull();
  });

  it("treats a pairingGeneration mismatch as a re-pair switch and replaces the session", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding({ pairingGeneration: "pairing-A", capabilityRevision: 10 });
    registry.activate(s, s);
    // Same server + same desktop session, but a new server-derived pairing
    // generation (a re-pair). The old session is invalidated and the new one
    // replaces it — even though desktopSessionId is reused.
    const rePaired = binding({ pairingGeneration: "pairing-B", capabilityRevision: 12 });
    const result = registry.activate(rePaired, rePaired);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("switched");
    expect(registry.get("user-1")?.pairingGeneration).toBe("pairing-B");
    expect(audit.at(-1)?.kind).toBe("workstation_session_switched");
  });

  it("on a re-pair to an empty durable grant set, stores the new coherent session", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ pairingGeneration: "pairing-A", grantIds: ["grant-1"], capabilityRevision: 10 });
    registry.activate(s, s);
    const rePaired = binding({
      pairingGeneration: "pairing-B",
      grantIds: [],
      capabilityRevision: 11,
    });
    const result = registry.activate(rePaired, rePaired);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("switched");
    expect(registry.get("user-1")).toMatchObject({
      pairingGeneration: "pairing-B",
      grantIds: [],
    });
  });

  it("invalidateForRelayBinding optionally pins the prior pairingGeneration", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ serverBindingId: "binding-1", relayId: "relay-1", desktopSessionId: "desktop-1", pairingGeneration: "pairing-A" });
    registry.activate(s, s);
    // A mismatched pairingGeneration filter does NOT invalidate (the session
    // was already re-activated under the new generation).
    const mismatched = registry.invalidateForRelayBinding({
      userId: "user-1",
      serverBindingId: "binding-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-other",
    });
    expect(mismatched.invalidated).toBe(false);
    expect(registry.get("user-1")?.pairingGeneration).toBe("pairing-A");
    // The matching prior generation invalidates the session.
    const matched = registry.invalidateForRelayBinding({
      userId: "user-1",
      serverBindingId: "binding-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-A",
    });
    expect(matched.invalidated).toBe(true);
    expect(registry.get("user-1")).toBeNull();
  });
});

// ===========================================================================
// D418 Commit 4 — runtime-owned redacted `WorkstationAdmissionAuditEvent`
// shape. The row is a REDACTED, dependency-free type carrying execution
// class + outcome/reason + tool/tool-call id + OPAQUE session/plan binding
// identifiers. The server mirrors it into the global `SecurityAuditEvent`
// union + writer; this pins the canonical shape + redaction contract.
// ===========================================================================

// ===========================================================================
// D418 default-instance — a canonical `instanceId: ""` (the default unnamed
// instance) is a valid binding identity. It must activate exactly like a
// named instance, remain exact-match-only (a named binding does not match a
// default-instance authoritative binding), and reject whitespace / noncanonical
// instance ids at validation. The exact-equality checks (identity + deep
// equals) are preserved unchanged.
// ===========================================================================

describe("InMemoryWorkstationSessionRegistry — default instanceId \"\" (D418)", () => {
  it("activates an eligible session whose instanceId is the canonical default \"\"", () => {
    const audit: WorkstationAccessAuditEvent[] = [];
    const registry = new InMemoryWorkstationSessionRegistry({ audit: (e) => audit.push(e), now: clock });
    const s = binding({ instanceId: "" });
    const result = registry.activate(s, s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("activated");
    expect(result.session?.instanceId).toBe("");
    expect(registry.get("user-1")?.instanceId).toBe("");
    expect(audit.map((e) => e.kind)).toEqual(["workstation_session_activated"]);
  });

  it("denies a binding whose instanceId is whitespace-only (noncanonical)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const blank = binding({ instanceId: " " });
    const result = registry.activate(blank, blank);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
    expect(result.reason).toContain("instanceId");
    expect(registry.get("user-1")).toBeNull();
  });

  it("denies a binding whose instanceId has surrounding whitespace (noncanonical)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const padded = binding({ instanceId: "instance-1 " });
    const result = registry.activate(padded, padded);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
    expect(result.reason).toContain("instanceId");
  });

  it("denies a binding whose instanceId is a noncanonical pattern (uppercase)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const bad = binding({ instanceId: "Instance-1" });
    const result = registry.activate(bad, bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("ineligible_binding");
    expect(result.reason).toContain("instanceId");
  });

  it("treats a default-instance session as foreign against a named authoritative binding (exact-match only)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const session = binding({ instanceId: "" });
    const authoritative = binding({ instanceId: "instance-1" });
    const result = registry.activate(session, authoritative);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("foreign_binding");
    expect(registry.get("user-1")).toBeNull();
  });

  it("treats a named session as foreign against a default-instance authoritative binding (exact-match only)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const session = binding({ instanceId: "instance-1" });
    const authoritative = binding({ instanceId: "" });
    const result = registry.activate(session, authoritative);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denialCode).toBe("foreign_binding");
    expect(registry.get("user-1")).toBeNull();
  });

  it("denies a duplicate of an already-active default-instance session (exact deep equality)", () => {
    const registry = new InMemoryWorkstationSessionRegistry({ now: clock });
    const s = binding({ instanceId: "" });
    registry.activate(s, s);
    const dup = registry.activate(s, s);
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.denialCode).toBe("duplicate_active");
  });

  it("issues + completes a pending authorization for a default-instance binding", () => {
    const registry = new InMemoryWorkstationSessionRegistry({
      now: clock,
      mintPendingTicket: () => "default-instance-ticket",
    });
    const pending = registry.issuePendingAuthorization({
      userId: "user-1",
      instanceId: "",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-1",
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      agentScope: FULL_WORKSTATION_AGENT_SCOPE,
      profileId: "profile-1",
      profileRevision: 1,
      baselineCapabilityRevision: 0,
    });
    expect(pending.ticket).toBe("default-instance-ticket");
    expect(registry.get("user-1")).toBeNull();
    const completed = registry.completePendingAuthorization(
      pending.ticket,
      binding({ instanceId: "", capabilityRevision: 1, grantIds: ["policy-pack-grant"] }),
    );
    expect(completed.ok).toBe(true);
    expect(registry.get("user-1")?.instanceId).toBe("");
    expect(registry.get("user-1")?.grantIds).toEqual(["policy-pack-grant"]);
  });
});

describe("WorkstationAdmissionAuditEvent — runtime-owned redacted shape (Commit 4)", () => {
  it("constructs an auto admission row with the auto_admitted reason sentinel", () => {
    const event = {
      ts: FIXED_TS,
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      kind: "workstation_admission",
      userId: "user-1",
      toolName: "run_shell",
      toolCallId: "tc-1",
      executionClass: "profile_bound_sandbox",
      outcome: "auto",
      reason: "auto_admitted",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-1",
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      profileId: "profile-1",
      profileRevision: 1,
      capabilityRevision: 10,
    } satisfies import("../../src/workstation-session-registry").WorkstationAdmissionAuditEvent;
    expect(event.kind).toBe("workstation_admission");
    expect(event.outcome).toBe("auto");
    expect(event.reason).toBe("auto_admitted");
    expect(event.executionClass).toBe("profile_bound_sandbox");
  });

  it("constructs a none admission row with an independent scan-refusal reason", () => {
    const event = {
      ts: FIXED_TS,
      actorId: null,
      ip: "",
      userAgent: undefined,
      kind: "workstation_admission",
      userId: "user-1",
      toolName: "run_shell",
      toolCallId: "tc-2",
      executionClass: "profile_bound_sandbox",
      outcome: "none",
      reason: "critical_or_elevation_command",
      relayId: "",
      desktopSessionId: "",
      serverBindingId: "",
      pairingGeneration: "",
      profileId: "",
      profileRevision: 0,
      capabilityRevision: 0,
    } satisfies import("../../src/workstation-session-registry").WorkstationAdmissionAuditEvent;
    expect(event.outcome).toBe("none");
    expect(event.reason).toBe("critical_or_elevation_command");
  });

  it("the row shape never carries authority material (redaction by construction)", () => {
    const keys = new Set(
      Object.keys({
        ts: "", actorId: null, ip: "", userAgent: undefined, kind: "workstation_admission",
        userId: "", toolName: "", toolCallId: "", executionClass: "profile_bound_sandbox",
        outcome: "auto", reason: "auto_admitted", relayId: "", desktopSessionId: "",
        serverBindingId: "", pairingGeneration: "", profileId: "", profileRevision: 0,
        capabilityRevision: 0,
      } satisfies import("../../src/workstation-session-registry").WorkstationAdmissionAuditEvent),
    );
    expect(keys.has("command")).toBe(false);
    expect(keys.has("commandOutput")).toBe(false);
    expect(keys.has("output")).toBe(false);
    expect(keys.has("roots")).toBe(false);
    expect(keys.has("allowedRoots")).toBe(false);
    expect(keys.has("env")).toBe(false);
    expect(keys.has("token")).toBe(false);
    expect(keys.has("pin")).toBe(false);
    expect(keys.has("grantIds")).toBe(false);
  });
});
