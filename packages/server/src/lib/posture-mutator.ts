/**
 * Production posture mutator wired into `PUT /api/security/posture`
 * in app.ts. D060 Sprint 1 G5.3.d (ship plan v3 §5.3 + §5.8) + G4
 * (sidecar persistence).
 *
 * Responsibilities (in order — fail-fast chain):
 *   1. Append a `posture_changed` row to the JSONL audit log. This
 *      HAPPENS FIRST so a crash between audit-write and any later
 *      step still leaves a forensic trail of what the caller
 *      attempted.
 *   2. Atomically write the `~/.nautilo/posture.json` sidecar. This
 *      is the disk persistence — the change survives server restart.
 *      If this throws, the mutator aborts before touching in-memory
 *      config or broadcasting; next GET returns the pre-mutation
 *      state + the audit row records the attempt.
 *   3. Update the in-memory runtime config via `setConfigOverrides`
 *      so the next `GET /api/security/posture` reflects the change
 *      without waiting for re-read.
 *   4. Broadcast `policy.changed` over the event bus so subscribed
 *      WebSocket clients re-read the posture endpoint.
 */

import {
  defaultNetworkPolicyForDeploymentMode,
  setConfigOverrides,
} from "@nautilo/config";
import { eventBus } from "@nautilo/runtime";

import type { PostureMutationMeta, PostureMutator } from "../routes/security";
import { writeSecurityAuditEvent } from "./security-audit-log";
import { writePostureSidecar } from "./posture-sidecar";

export interface PostureMutatorDeps {
  /**
   * Absolute path to the JSONL audit log file. Production wires
   * `~/.nautilo/logs/security-audit.log`; tests pass a tmp path.
   */
  readonly auditLogPath: string;
  /**
   * Absolute path to the posture sidecar file (D060 G4). Production
   * wires `~/.nautilo/posture.json`; tests pass a tmp path. The
   * sidecar is read at boot to override the nautilo.config.ts
   * defaults with the last persisted mutation.
   */
  readonly sidecarPath: string;
  /**
   * Clock — defaults to `() => new Date()`. Tests inject a fixed
   * clock so assertions about the `ts` field are stable.
   */
  readonly now?: () => Date;
}

/**
 * Factory: returns a `PostureMutator` closure wired with the given
 * dependencies. Kept as a factory (rather than a free function) so
 * app.ts can inject the log path once at boot and hand the closure
 * to `securityRoutes()` without leaking the path into the route body.
 */
export function createPostureMutator(deps: PostureMutatorDeps): PostureMutator {
  const now = deps.now ?? (() => new Date());

  return (meta: PostureMutationMeta): Promise<void> => {
    const ts = now().toISOString();
    const networkPolicy =
      meta.next.networkPolicy ??
      defaultNetworkPolicyForDeploymentMode(meta.next.deploymentMode);
    // D538 — this remains sidecar-owned rather than becoming a generic runtime
    // config field. The existing policy.changed event is the re-fetch signal.
    const allowUncontainedHostCommands =
      meta.next.allowUncontainedHostCommands;

    // Step 1: audit log FIRST. Forensic trail survives any
    // subsequent failure. If this throws, the subsequent steps do
    // NOT fire — rejecting the mutation is preferable to leaving
    // an un-audited state change.
    writeSecurityAuditEvent(deps.auditLogPath, {
      kind: "posture_changed",
      ts,
      actorId: meta.actorId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      prev: meta.prev,
      next: meta.next,
    });

    // Step 2: atomic sidecar write (D060 G4 — survives restart).
    // If this throws (disk full, permission denied, etc.) we abort
    // before touching in-memory config or broadcasting. The audit
    // row already records the attempt; the next GET returns the
    // unchanged posture; the caller sees the error and can retry.
    writePostureSidecar(deps.sidecarPath, {
      ...meta.next,
      allowUncontainedHostCommands,
    });

    // Step 3: update in-memory config so next GET reflects the
    // change without waiting for re-read.
    setConfigOverrides({
      nautilo_deployment_mode: meta.next.deploymentMode,
      nautilo_security_level: meta.next.securityLevel,
      nautilo_network_policy: networkPolicy,
    });

    // Step 4: broadcast. Subscribed WS clients re-read on receipt.
    eventBus.emit({
      type: "policy.changed",
      deploymentMode: meta.next.deploymentMode,
      securityLevel: meta.next.securityLevel,
      networkPolicy,
      at: ts,
    });

    return Promise.resolve();
  };
}
