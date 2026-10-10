/**
 * Pure workstation admission decisions. Basic requires an exact foreground
 * managed-execution plan; Development requires its active session and plan.
 * Explicit host commands retain their independent Electron consent gate.
 * This module never authorizes paths, accounts, network, or containment:
 * those are revalidated locally before effects. Actor/protected-content
 * admission and critical-command refusal remain the caller's responsibility.
 */

// ---------------------------------------------------------------------------
// Session evidence (structurally compatible with the runtime registry's
// FullWorkstationSession). Re-declared locally to avoid a dependency on the
// runtime package.
// ---------------------------------------------------------------------------

/**
 * The active Full Workstation session, or `null` when none is active.
 *
 * Structurally compatible with `@nautilo/runtime`'s `FullWorkstationSession`
 * so the integrator can pass the registry row verbatim. Re-declared locally
 * to avoid a dependency on the runtime package.
 */
export interface FullWorkstationSessionEvidence {
  readonly userId: string;
  readonly instanceId: string;
  readonly relayId: string;
  /** Per Electron main-process-launch identity; empty ⇒ headless relay. */
  readonly desktopSessionId: string;
  /** Server-side binding id; changes on server switch / re-pair. */
  readonly serverBindingId: string;
  readonly agentScope: string;
  readonly profileId: string;
  readonly profileRevision: number;
  /** Unique, non-empty opaque grant ids the session was activated with. */
  readonly grantIds: readonly string[];
  /** Monotonic revision of the advertised capability state. */
  readonly capabilityRevision: number;
  readonly activatedAt: string;
}

// ---------------------------------------------------------------------------
// Execution class + concrete tool/operation identity
// ---------------------------------------------------------------------------

/**
 * The Workstation execution classes. This replaces the old six-value
 * operation taxonomy (`file / shell / network / background / package / mcp`):
 *   - `profile_bound_sandbox` — a relay-dispatched, sandbox-contained
 *     operation whose roots / paths / network / OS authority is the live
 *     Electron grant + sandbox profile. Eligible for `auto` admission only
 *     as a `run_shell` attempt under an exact active session + plan; local
 *     Electron enforcement remains authoritative at execution.
 *   - `real_workstation` — the explicit raw host-command lane. Routine
 *     `run_shell` attempts may auto-admit past command-shape approval, but
 *     Electron's exact local consent remains final execution authority.
 */
/** Basic never represents a synthetic Development activation. */
export type WorkstationExecutionClass =
  | "basic_sandbox"
  | "profile_bound_sandbox"
  | "real_workstation";

/**
 * Concrete tool/operation identity, carried SEPARATE from the execution
 * class for audit / telemetry correlation. The engine does NOT branch on it
 * — the admission decision is by execution class. `operation` is the
 * concrete workstation access operation (e.g. `"execute"` for `run_shell`)
 * when the caller can derive it, or `null` when it cannot be determined
 * safely (the caller then refuses the dispatch independently, before
 * consulting this engine).
 */
export interface WorkstationToolIdentity {
  readonly name: string;
  readonly operation: string | null;
}

// ---------------------------------------------------------------------------
// Admission evidence + decision
// ---------------------------------------------------------------------------

/**
 * The slim execution-admission evidence bundle. Every field is
 * caller-resolved; the engine is pure with respect to it. There is NO
 * caller-authored dispatch binding copied from the active session — the
 * exact binding proof is `exactPlan`, set only when a live
 * `WorkstationDispatchPlan` was admitted AND revalidated against the bound
 * relay's live fingerprint (which already proves subject / desktop session /
 * capability revision / profile binding match).
 */
export interface WorkstationAdmissionEvidence {
  readonly executionClass: WorkstationExecutionClass;
  readonly session: FullWorkstationSessionEvidence | null;
  /**
   * True only when a live `WorkstationDispatchPlan` was admitted AND
   * revalidated for this dispatch (the bound relay's live fingerprint still
   * exactly matches the session binding). Auto REQUIRES a live exact plan —
   * no plan, no auto (the tools node would have nothing to pin).
   */
  readonly exactPlan: boolean;
  /**
   * Concrete tool/operation identity. Auto admission requires a tool supported
   * by the exact execution class; this classification is not a server claim
   * that the Electron-local sandbox has been created or remains active.
   */
  readonly tool: WorkstationToolIdentity;
}

/**
 * Why admission was refused. The caller surfaces this to audit / telemetry;
 * it does NOT override the normal approval decision, which runs unchanged.
 */
export type WorkstationAdmissionReason =
  // No active authenticated Full Workstation session.
  "no_active_session"
  // No live admitted+revalidated plan pins this dispatch.
  | "no_admitted_plan"
  // Compatibility reason for an unsupported tool/execution-class combination.
  | "run_shell_required"
  // The independent static scan refused critical destruction or elevation.
  | "critical_or_elevation_command";

export interface WorkstationAdmissionAuto {
  readonly override: "auto";
  readonly executionClass: WorkstationExecutionClass;
}

export interface WorkstationAdmissionNone {
  readonly override: "none";
  readonly executionClass: WorkstationExecutionClass;
  readonly reason: WorkstationAdmissionReason;
  readonly detail: string;
}

export type WorkstationAdmissionDecision =
  | WorkstationAdmissionAuto
  | WorkstationAdmissionNone;

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Resolve a Workstation execution-admission decision from the slim contract.
 *
 * The check order is deliberate:
 *   1. Explicit real-workstation `run_shell` attempts return `auto` to the
 *      independent Electron-local consent gate. Other tools fail closed.
 *   2. The active-session gate: no session ⇒ `no_active_session` (Full Mode
 *      off; normal approval + client ask→auto run unchanged).
 *   3. The exact-plan gate: no live admitted+revalidated plan ⇒
 *      `no_admitted_plan` — auto REQUIRES a live exact plan.
 *   4. The tool gate: `run_shell` or contained managed execution. Other tools fail closed. This
 *      classification does not claim Electron has constructed a sandbox.
 *   5. Every gate passed ⇒ `auto`.
 *
 * The engine is fail-closed: anything it cannot prove eligible is `none`.
 * It deliberately does NOT read a global `security.level` ("yolo") and does
 * NOT reuse the yolo verb-map row. Full Workstation Mode is a separate,
 * narrower, session-bound authority surface, not a posture change.
 */
export function resolveWorkstationAdmission(
  evidence: WorkstationAdmissionEvidence,
): WorkstationAdmissionDecision {
  const { executionClass, session, exactPlan, tool } = evidence;

  // ---- Hard escape / unsupported-class gates (independent of session) ----

  if (executionClass === "real_workstation") {
    if (tool.name !== "run_shell") {
      return none(
        executionClass,
        "run_shell_required",
        "real_workstation admission is available only for the explicit run_shell host-command lane",
      );
    }
    return { override: "auto", executionClass: "real_workstation" };
  }
  if (executionClass === "basic_sandbox") {
    if (!exactPlan) return none(executionClass, "no_admitted_plan", "Basic requires an exact foreground Desktop plan");
    if (tool.name !== "exec_command" || tool.operation !== "execute") return none(executionClass, "run_shell_required", "Basic starts only managed contained commands");
    return { override: "auto", executionClass };
  }
  // ---- Active authenticated Full Workstation session required -----------

  if (session === null) {
    return none(
      executionClass,
      "no_active_session",
      "no active Full Workstation session; admission requires an active authenticated exact-match Full session",
    );
  }

  // ---- Exact admitted + revalidated plan required ------------------------

  if (!exactPlan) {
    return none(
      executionClass,
      "no_admitted_plan",
      "no live admitted+revalidated WorkstationDispatchPlan pins this dispatch; auto requires a live exact plan",
    );
  }

  // ---- Concrete contained command identity only ---------------------------

  if (tool.name !== "run_shell" && !(executionClass === "profile_bound_sandbox"
    && (tool.name === "exec_command" || tool.name === "write_stdin"))) {
    return none(
      executionClass,
      "run_shell_required",
      "workstation admission accepts only explicit command tools within their supported execution class",
    );
  }

  // ---- Every gate passed: profile-bound admission -------------------------

  return { override: "auto", executionClass };
}

function none(
  executionClass: WorkstationExecutionClass,
  reason: WorkstationAdmissionReason,
  detail: string,
): WorkstationAdmissionNone {
  return { override: "none", executionClass, reason, detail };
}
