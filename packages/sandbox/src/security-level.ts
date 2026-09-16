/**
 * Security-level → sandbox-mode mapping. D060 Phase 1 task 1.7.
 *
 * The bridge between D053's `SecurityLevel` union (yolo / permissive
 * / standard / cautious / paranoid) and this package's
 * `SandboxMode` + fail-loud policy.
 *
 *   Level         SandboxMode   failIfNoBackend   Notes
 *   ─────────────────────────────────────────────────────────
 *   yolo          disabled      false             dev only
 *   permissive    disabled      false             path-deny still active
 *   standard      disabled      false             scanner + path-deny + content scan
 *   cautious      enabled       false             wrap with available backend;
 *                                                 WARN if backend=none
 *   paranoid      enabled       true              REFUSE to execute when backend=none
 *
 * Diverges from Spacebot (`src/sandbox.rs:182-227`): Spacebot WARNs
 * universally when mode=enabled but backend=none. We tighten
 * paranoid to FAIL per the D060 issue §Q6 "fail-loud-at-paranoid"
 * principle — a paranoid user should NOT get silent degradation to
 * unsandboxed execution. Other levels still WARN + passthrough.
 */

import type { SandboxMode } from "./types";

/**
 * D053's security levels. Duplicated here rather than imported from
 * `@nautilo/security` so `@nautilo/sandbox` stays a leaf package. The
 * tuple MUST stay in sync with `@nautilo/security`'s `SecurityLevel`
 * union — `security-level.test.ts` has a type-level assertion that
 * pins this.
 */
export type SecurityLevel =
  | "yolo"
  | "permissive"
  | "standard"
  | "cautious"
  | "paranoid";

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  /**
   * When true, `Sandbox.create()` THROWS if the detected backend is
   * `none`. Currently only `paranoid` sets this — the operator
   * explicitly opted into "no containment = no shell."
   */
  readonly failIfNoBackend: boolean;
}

/**
 * Map a security level to the sandbox policy. Pure function — safe
 * to call at config-parse time before the sandbox is constructed.
 */
export function sandboxPolicyForLevel(level: SecurityLevel): SandboxPolicy {
  switch (level) {
    case "yolo":
    case "permissive":
    case "standard":
      return { mode: "disabled", failIfNoBackend: false };
    case "cautious":
      return { mode: "enabled", failIfNoBackend: false };
    case "paranoid":
      return { mode: "enabled", failIfNoBackend: true };
  }
}
