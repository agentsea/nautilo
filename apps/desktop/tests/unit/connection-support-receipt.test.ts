import { describe, expect, test } from "bun:test";
import type { ConnectionPresentation } from "../../electron/connection-presentation";
import {
  CONNECTION_SUPPORT_RECEIPT_OMITTED, ConnectionSupportReceiptProjector,
  connectionSupportAttemptRef, formatConnectionSupportReceipt,
} from "../../electron/connection-support-receipt";

function snapshot(overrides: Partial<ConnectionPresentation> = {}): ConnectionPresentation {
  return {
    version: 1, revision: 1, phase: "preparing", lastObservationAtMs: null,
    retrySafe: false, validActions: ["cancel"], priorPairing: "present",
    pairingStateChange: "unchanged", failureCode: null, supportReceipt: null,
    ...overrides,
  };
}

describe("connection support receipt", () => {
  test("records main receive-time durations and emits the exact bounded sanitized failure shape", () => {
    let now = 100;
    const projector = new ConnectionSupportReceiptProjector(() => now, () => "conn_aaaaaaaaaaaaaaaa");
    projector.project(snapshot());
    now = 130;
    projector.project(snapshot({ revision: 2, phase: "contacting" }));
    now = 175;
    projector.project(snapshot({ revision: 3, phase: "waiting-for-server" }));
    now = 205;
    const projected = projector.project(snapshot({
      revision: 4, phase: "failed", failureCode: "readiness-unavailable",
      retrySafe: true, validActions: ["retry", "edit-target", "cancel"],
    }));
    expect(projected.supportReceipt).toEqual({
      version: 1, kind: "desktop-connection-failure", attemptRef: "conn_aaaaaaaaaaaaaaaa",
      outcome: "failed", complete: false, failureCode: "readiness-unavailable",
      recovery: { retrySafe: true, validActions: ["retry", "edit-target", "cancel"] },
      pairing: { priorPairing: "present", stateChange: "unchanged" },
      phases: [
        { phase: "preparing", visits: 1, durationMs: 30, outcome: "advanced" },
        { phase: "contacting", visits: 1, durationMs: 45, outcome: "advanced" },
        { phase: "waiting-for-server", visits: 1, durationMs: 30, outcome: "failed" },
      ],
      omitted: CONNECTION_SUPPORT_RECEIPT_OMITTED,
    });
    expect(formatConnectionSupportReceipt(projected.supportReceipt!)).toBe(JSON.stringify(projected.supportReceipt, null, 2));
    expect(Object.keys(projected.supportReceipt!)).toEqual([
      "version", "kind", "attemptRef", "outcome", "complete", "failureCode",
      "recovery", "pairing", "phases", "omitted",
    ]);
    expect(Object.keys(projected.supportReceipt!.recovery)).toEqual(["retrySafe", "validActions"]);
    expect(Object.keys(projected.supportReceipt!.pairing)).toEqual(["priorPairing", "stateChange"]);
    expect(Object.keys(projected.supportReceipt!.phases[0]!)).toEqual(["phase", "visits", "durationMs", "outcome"]);
  });

  test("aggregates resumed visits under one public ref and resets only at the next preparing phase", () => {
    let now = 0, ref = 0;
    const projector = new ConnectionSupportReceiptProjector(() => now, () => `conn_ref${++ref}`);
    projector.project(snapshot());
    now = 10; projector.project(snapshot({ phase: "saving-connection" }));
    now = 20;
    const first = projector.project(snapshot({ phase: "failed", failureCode: "promotion-failed", validActions: ["resume-handoff"] }));
    now = 30; projector.project(snapshot({ phase: "saving-connection" }));
    now = 50;
    const resumed = projector.project(snapshot({ phase: "failed", failureCode: "promotion-failed", validActions: ["resume-handoff"] }));
    expect(resumed.supportReceipt?.attemptRef).toBe(first.supportReceipt?.attemptRef);
    expect(resumed.supportReceipt?.phases.find((row) => row.phase === "saving-connection")).toEqual({
      phase: "saving-connection", visits: 2, durationMs: 30, outcome: "failed",
    });
    now = 60;
    projector.project(snapshot({ phase: "preparing" }));
    now = 70;
    const next = projector.project(snapshot({ phase: "cancelled", failureCode: "cancelled" }));
    expect(next.supportReceipt?.attemptRef).not.toBe(first.supportReceipt?.attemptRef);
  });

  test("locks after a decision and fails closed for terminal-first or non-failure snapshots", () => {
    let now = 0;
    const projector = new ConnectionSupportReceiptProjector(() => now, () => "conn_decision");
    expect(projector.project(snapshot({ phase: "failed", failureCode: "health-unavailable" })).supportReceipt).toBeNull();
    projector.project(snapshot());
    now = 10; projector.project(snapshot({ phase: "verifying-identity" }));
    now = 20;
    const decision = projector.project(snapshot({ phase: "identity-mismatch", failureCode: "identity-mismatch", validActions: ["accept-identity", "cancel"] }));
    expect(decision.supportReceipt?.outcome).toBe("decision-required");
    expect(projector.project(snapshot({ phase: "saving-connection", revision: 5 })).supportReceipt).toBeNull();
    expect(projector.project(snapshot({ phase: "complete", revision: 6 })).supportReceipt).toBeNull();

    const failed = new ConnectionSupportReceiptProjector(() => now, () => "conn_failed");
    failed.project(snapshot());
    failed.project(snapshot({ phase: "failed", failureCode: "health-unavailable", validActions: ["retry"] }));
    failed.project(snapshot({ phase: "contacting", revision: 7 }));
    expect(failed.project(snapshot({ phase: "failed", failureCode: "transport-unavailable", revision: 8 })).supportReceipt).toBeNull();
  });

  test("randomness injection yields independent public base32 refs without private sentinels", () => {
    const first = new ConnectionSupportReceiptProjector(() => 0,
      () => connectionSupportAttemptRef(new Uint8Array(10).fill(1)));
    const second = new ConnectionSupportReceiptProjector(() => 0,
      () => connectionSupportAttemptRef(new Uint8Array(10).fill(2)));
    first.project(snapshot()); second.project(snapshot());
    const a = first.project(snapshot({ phase: "cancelled", failureCode: "cancelled" })).supportReceipt!;
    const b = second.project(snapshot({ phase: "cancelled", failureCode: "cancelled" })).supportReceipt!;
    expect(a.attemptRef).toMatch(/^conn_[a-z2-7]{16}$/);
    expect(b.attemptRef).not.toBe(a.attemptRef);
    expect(JSON.stringify(a)).not.toContain("private-url-or-token-sentinel");
  });

  test("clamps backward and non-finite clock samples to safe integer durations", () => {
    let now = 20;
    const projector = new ConnectionSupportReceiptProjector(() => now, () => "conn_clock");
    projector.project(snapshot());
    now = Number.NaN; projector.project(snapshot({ phase: "contacting" }));
    now = -5;
    const receipt = projector.project(snapshot({ phase: "failed", failureCode: "transport-unavailable" })).supportReceipt!;
    expect(receipt.phases.every((row) => Number.isSafeInteger(row.durationMs) && row.durationMs >= 0)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("null");
  });

  test("projects an exact allow-list and strips hostile private-shaped input", () => {
    let now = 0;
    const projector = new ConnectionSupportReceiptProjector(() => ++now, () => "conn_redacted");
    const secrets = [
      "https://private.example.test", "private-origin", "private-fingerprint", "private-body",
      "private-provider", "private-credential", "private-token", "private-internal-id", "private-receipt",
    ];
    projector.project({ ...snapshot(), serverUrl: secrets[0], origin: secrets[1], fingerprint: secrets[2],
      body: secrets[3], providerConfiguration: secrets[4], credential: secrets[5], token: secrets[6],
      attemptId: secrets[7], authorityReceipt: secrets[8] } as ConnectionPresentation);
    const projected = projector.project({ ...snapshot({ phase: "failed", failureCode: "navigation-failed" }),
      serverUrl: secrets[0], token: secrets[6] } as ConnectionPresentation);
    expect(Object.keys(projected)).toEqual([
      "version", "revision", "phase", "lastObservationAtMs", "retrySafe", "validActions",
      "priorPairing", "pairingStateChange", "failureCode", "supportReceipt",
    ]);
    const serialized = JSON.stringify(projected.supportReceipt);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });

  test("keeps non-failures receipt-free, maps superseded, and never exceeds ten work rows", () => {
    let now = 0;
    const projector = new ConnectionSupportReceiptProjector(() => ++now, () => "conn_bounded");
    projector.project(snapshot());
    expect(projector.project(snapshot({ phase: "awaiting-downgrade-confirmation" })).supportReceipt).toBeNull();
    expect(projector.project(snapshot({ phase: "complete" })).supportReceipt).toBeNull();
    for (const phase of ["contacting", "waiting-for-server", "verifying-server", "verifying-identity",
      "discovering-setup", "discovering-sign-in", "opening-nautilo", "saving-connection"] as const) {
      projector.project(snapshot({ phase }));
    }
    const failed = projector.project(snapshot({ phase: "superseded", failureCode: "superseded" }));
    expect(failed.supportReceipt?.outcome).toBe("superseded");
    expect(failed.supportReceipt?.phases).toHaveLength(10);
  });

  test("clears the prior attempt before a new reference is minted", () => {
    let mint = 0;
    const projector = new ConnectionSupportReceiptProjector(() => mint,
      () => { if (++mint === 2) throw new Error("entropy unavailable"); return "conn_first"; });
    projector.project(snapshot());
    projector.project(snapshot({ phase: "failed", failureCode: "invalid-target" }));
    expect(() => projector.project(snapshot({ phase: "preparing", revision: 3 }))).toThrow();
    projector.project(snapshot({ phase: "contacting", revision: 4 }));
    expect(projector.project(snapshot({ phase: "failed", failureCode: "transport-unavailable", revision: 5 })).supportReceipt).toBeNull();
  });
});
