/**
 * D418 Commit 3 — Workstation execution-admission engine.
 *
 * This is a **strict pure module**: no Electron, no HTTP, no filesystem, no
 * process state, no database, and no dependency on `@nautilo/security`,
 * `@nautilo/desktop-filesystem-grants`, `@nautilo/relay`, or `@nautilo/runtime`. It
 * takes a slim execution-admission contract and returns one decision:
 *
 *   - `auto`   — the dispatch is either a `run_shell` profile-bound sandbox
 *                attempt under an exact Full Workstation session+plan, or an
 *                explicit real-workstation `run_shell` attempt proceeding to
 *                Electron's independent local consent authority.
 *                The caller MAY suppress the normal `ask` / `prove_it`
 *                prompt for this dispatch and run it as a Full Workstation
 *                auto-approval.
 *   - `none`   — at least one admission gate failed. The caller MUST leave
 *                the normal approval logic intact (the dock / PIN / block
 *                path runs unchanged). The `reason` is for audit / telemetry
 *                only; it is NOT an execution denial by itself — normal
 *                approval still decides.
 *
 * The engine superseds the paused 3.2.5c nine-field
 * `WorkstationOverrideEvidence` model. It removes caller-authored
 * profile/path/network/OS/boundedness/MCP/escape booleans: those are no
 * longer admission inputs. Local execution (the relay sandbox / grant
 * authority) remains the authority for roots, paths, network, OS, and
 * boundedness. The server admits an attempt, never confirms local sandbox
 * construction: an Electron-local binding, sandbox, stale-grant, protected-
 * path, or OS denial remains fail-closed at execution and surfaces as a
 * command failure — never a silent bypass. Critical / elevation scanning is
 * an independent server-side refusal defense; it is not admission evidence.
 *
 * The contract is exactly: `executionClass + activeSession + exactPlan +
 * tool/operation identity`. The concrete tool identity MUST be `run_shell`.
 * Profile-bound sandbox admission additionally requires the exact Full
 * Workstation session+plan. Real-workstation admission authorizes only an
 * attempt: Electron still requires active-Human session or durable exact
 * local consent before it will spawn. The engine does NOT take a
 * caller-authored dispatch binding copied from the active session: the exact
 * binding proof is the `exactPlan` flag (a live, admitted, revalidated
 * `WorkstationDispatchPlan` pins the relay + profile + grant + capability
 * revisions), so the engine never compares a fabricated dispatch against the
 * session.
 *
 * Integration: the server-side post-model approval resolver
 * (`packages/server/src/routes/workstation-access.ts`) reads the LIVE
 * `InMemoryWorkstationSessionRegistry` session, admits + revalidates the
 * transient `WorkstationDispatchPlan`, and calls {@link
 * resolveWorkstationAdmission}. Commit 4 admits only an active-session,
 * exact-plan `profile_bound_sandbox` `run_shell` attempt. Electron-local
 * shell binding and sandbox construction remain the execution authority and
 * are never represented as a server-confirmed boolean.
 *
 * The `FullWorkstationSessionEvidence` shape is structurally compatible with
 * `@nautilo/runtime`'s `FullWorkstationSession` so the integrator can pass
 * the registry's session object directly without a remap. The fields are
 * re-declared here (not imported) to keep this package dependency-free.
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
 * The three Workstation execution classes. This replaces the old six-value
 * operation taxonomy (`file / shell / network / background / package / mcp`):
 *   - `profile_bound_sandbox` — a relay-dispatched, sandbox-contained
 *     operation whose roots / paths / network / OS authority is the live
 *     Electron grant + sandbox profile. Eligible for `auto` admission only
 *     as a `run_shell` attempt under an exact active session + plan; local
 *     Electron enforcement remains authoritative at execution.
 *   - `typed_broker` — a profile-listed, schema-bounded broker operation
 *     with local binding / audit / cancel / revoke. It uses the same exact
 *     active-session + plan proof as the profile-bound shell lane.
 *   - `real_workstation` — the explicit raw host-command lane. Routine
 *     `run_shell` attempts may auto-admit past command-shape approval, but
 *     Electron's exact local consent remains final execution authority.
 */
export type WorkstationExecutionClass =
  | "profile_bound_sandbox"
  | "typed_broker"
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
   * Concrete tool/operation identity. Auto admission requires `name` to be
   * `run_shell`; this is classification only and is NOT a server claim that
   * the Electron-local sandbox has been created or remains active.
   */
  readonly tool: WorkstationToolIdentity;
}

/**
 * Why admission was refused. The caller surfaces this to audit / telemetry;
 * it does NOT override the normal approval decision, which runs unchanged.
 */
export type WorkstationAdmissionReason =
  // Retained for audit compatibility with plans written before typed-broker
  // admission was enabled; new decisions use the normal session/plan gates.
  "typed_broker_not_wired"
  // No active authenticated Full Workstation session.
  | "no_active_session"
  // No live admitted+revalidated plan pins this dispatch.
  | "no_admitted_plan"
  // This B4 slice only auto-admits run_shell attempts.
  | "run_shell_required"
  // The independent static scan refused critical destruction or elevation.
  | "critical_or_elevation_command";

export interface WorkstationAdmissionAuto {
  readonly override: "auto";
  readonly executionClass: "profile_bound_sandbox" | "typed_broker" | "real_workstation";
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
 *      off; normal approval + D375 client ask→auto run unchanged).
 *   3. The exact-plan gate: no live admitted+revalidated plan ⇒
 *      `no_admitted_plan` — auto REQUIRES a live exact plan.
 *   4. The tool gate: only `run_shell` ⇒ `auto`; other tools return
 *      `run_shell_required`. This is an admission classification, not a
 *      claim that Electron has constructed a sandbox.
 *   5. Every gate passed for a `profile_bound_sandbox` or `typed_broker`
 *      `run_shell` attempt
 *      ⇒ `auto`.
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

  // ---- Workstation admission admits run_shell attempts only ----------------

  if (tool.name !== "run_shell") {
    return none(
      executionClass,
      "run_shell_required",
      "workstation admission auto-admits only run_shell attempts; other tools leave the normal approval path intact",
    );
  }

  // ---- Every gate passed: profile-bound or typed-broker admission ---------

  return { override: "auto", executionClass };
}

function none(
  executionClass: WorkstationExecutionClass,
  reason: WorkstationAdmissionReason,
  detail: string,
): WorkstationAdmissionNone {
  return { override: "none", executionClass, reason, detail };
}
