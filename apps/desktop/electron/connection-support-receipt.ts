import type {
  ConnectionPresentation, ConnectionPresentationAction, ConnectionPresentationFailureCode,
  ConnectionPresentationPhase, ConnectionPriorPairing, ConnectionPairingStateChange,
} from "./connection-presentation";

export const CONNECTION_SUPPORT_RECEIPT_OMITTED = [
  "server-url", "server-origin", "server-identity", "response-body",
  "provider-configuration", "credentials", "tokens", "internal-attempt-id",
  "authority-receipts",
] as const;

type ReceiptOutcome = "failed" | "decision-required" | "cancelled" | "superseded";
type PhaseOutcome = "advanced" | ReceiptOutcome;
export type ConnectionSupportReceipt = Readonly<{
  version: 1;
  kind: "desktop-connection-failure";
  attemptRef: string;
  outcome: ReceiptOutcome;
  complete: false;
  failureCode: ConnectionPresentationFailureCode;
  recovery: Readonly<{ retrySafe: boolean; validActions: readonly ConnectionPresentationAction[] }>;
  pairing: Readonly<{ priorPairing: ConnectionPriorPairing; stateChange: ConnectionPairingStateChange }>;
  phases: readonly Readonly<{
    phase: ConnectionPresentationPhase; visits: number; durationMs: number; outcome: PhaseOutcome;
  }>[];
  omitted: typeof CONNECTION_SUPPORT_RECEIPT_OMITTED;
}>;

const WORK_PHASES = new Set<ConnectionPresentationPhase>([
  "preparing", "awaiting-downgrade-confirmation", "contacting", "waiting-for-server",
  "verifying-server", "verifying-identity", "discovering-setup", "discovering-sign-in",
  "opening-nautilo", "saving-connection",
]);
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function connectionSupportAttemptRef(bytes: Uint8Array): string {
  if (bytes.length !== 10) throw new Error("support reference entropy must be 10 bytes");
  let bits = 0, value = 0, encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { encoded += BASE32[(value >>> (bits -= 5)) & 31]; }
  }
  return `conn_${encoded}`;
}

type MutablePhase = { phase: ConnectionPresentationPhase; visits: number; durationMs: number; outcome: PhaseOutcome };

/** Main-only reducer of already-sanitized presentation snapshots. */
export class ConnectionSupportReceiptProjector {
  private attemptRef: string | null = null;
  private active: { phase: ConnectionPresentationPhase; sinceMs: number } | null = null;
  private phases = new Map<ConnectionPresentationPhase, MutablePhase>();
  private decisionClosed = false;
  private lastNowMs = 0;

  constructor(private readonly nowMs: () => number, private readonly mintRef: () => string) {}

  project(snapshot: ConnectionPresentation): ConnectionPresentation {
    const sampled = this.nowMs();
    const now = Number.isFinite(sampled)
      ? Math.max(this.lastNowMs, Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(sampled))))
      : this.lastNowMs;
    this.lastNowMs = now;
    if (snapshot.phase === "preparing") this.reset(now);
    if (!this.attemptRef || (this.decisionClosed && snapshot.phase !== "preparing")) return this.output(snapshot, null);

    if (snapshot.failureCode !== null) {
      if (!this.active) return this.output(snapshot, null);
      const outcome = this.terminalOutcome(snapshot.phase);
      this.closeActive(now, outcome);
      this.decisionClosed = !snapshot.validActions.includes("resume-handoff");
      return this.output(snapshot, {
        version: 1, kind: "desktop-connection-failure", attemptRef: this.attemptRef,
        outcome, complete: false, failureCode: snapshot.failureCode,
        recovery: { retrySafe: snapshot.retrySafe, validActions: [...snapshot.validActions] },
        pairing: { priorPairing: snapshot.priorPairing, stateChange: snapshot.pairingStateChange },
        phases: [...this.phases.values()].map((phase) => ({ ...phase })),
        omitted: CONNECTION_SUPPORT_RECEIPT_OMITTED,
      });
    }

    if (WORK_PHASES.has(snapshot.phase) && this.active?.phase !== snapshot.phase) {
      this.closeActive(now, "advanced");
      const row = this.phases.get(snapshot.phase);
      if (row) row.visits = Math.min(Number.MAX_SAFE_INTEGER, row.visits + 1);
      else if (this.phases.size < 10) this.phases.set(snapshot.phase, {
        phase: snapshot.phase, visits: 1, durationMs: 0, outcome: "advanced",
      });
      this.active = { phase: snapshot.phase, sinceMs: now };
    }
    return this.output(snapshot, null);
  }

  private reset(now: number): void {
    this.attemptRef = null;
    this.active = null;
    this.phases.clear();
    this.decisionClosed = false;
    this.lastNowMs = now;
    this.attemptRef = this.mintRef();
  }

  private closeActive(now: number, outcome: PhaseOutcome): void {
    if (!this.active) return;
    const row = this.phases.get(this.active.phase);
    if (row) {
      row.durationMs = Math.min(Number.MAX_SAFE_INTEGER,
        row.durationMs + Math.max(0, now - this.active.sinceMs));
      row.outcome = outcome;
    }
    this.active = null;
  }

  private terminalOutcome(phase: ConnectionPresentationPhase): ReceiptOutcome {
    if (phase === "identity-mismatch") return "decision-required";
    if (phase === "cancelled") return "cancelled";
    if (phase === "superseded") return "superseded";
    return "failed";
  }

  private output(snapshot: ConnectionPresentation, supportReceipt: ConnectionSupportReceipt | null): ConnectionPresentation {
    return {
      version: snapshot.version, revision: snapshot.revision, phase: snapshot.phase,
      lastObservationAtMs: snapshot.lastObservationAtMs, retrySafe: snapshot.retrySafe,
      validActions: [...snapshot.validActions], priorPairing: snapshot.priorPairing,
      pairingStateChange: snapshot.pairingStateChange, failureCode: snapshot.failureCode,
      supportReceipt,
    };
  }
}

export function formatConnectionSupportReceipt(receipt: ConnectionSupportReceipt): string {
  return JSON.stringify(receipt, null, 2);
}
