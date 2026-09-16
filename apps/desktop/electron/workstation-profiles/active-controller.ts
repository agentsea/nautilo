/**
 * D418 — Electron-main active Workstation Profile state machine.
 *
 * One `ActiveWorkstationProfileController` owns the instance-scoped
 * `WorkstationProfileStore`, shares the single main-process
 * `DesktopFilesystemGrantAuthority`, and tracks the currently bound subject +
 * compiled policy-pack session. It is the only path that turns a stored
 * admin profile into live authority: `activate` compiles a stored profile
 * against already-canonical discovered facts into `policy_pack` / `session`
 * overlay grants, then atomically swaps the active session in for the
 * prior one. `deactivate` revokes the session grants and drops the binding.
 *
 * Visibility invariant — the active profile is only visible after a
 * successful compile:
 *   - `compileWorkstationProfileSession` is fail-closed and rolls back any
 *     partial overlay mutation on failure, so a failed compile adds no
 *     authority. The prior active session (and its grants) are left
 *     untouched on failure — they are cleared ONLY after the new session
 *     has compiled successfully.
 *   - The advertised `RelayWorkstationProfileSnapshot` is derived solely
 *     from the swapped-in `activeSession`, so a failed compile never
 *     advertises a binding.
 *
 * The snapshot is advisory and strictly redacted: it carries only
 * `profileId + profileRevision + grantIds + protectedPolicyVersion +
 * networkMode + capabilities[{id, backend}]`. Roots, environment values,
 * executable paths, filesystem identity, discovery providers, profile name,
 * and timestamps never cross the wire. The desktop relay's live
 * compiled-profile authority remains final; a stale or revoked binding
 * advertised here fails closed on the relay.
 *
 * Internal/testable only: no renderer IPC, Workbench UI, discovery probes,
 * server route, approval resolver, or sandbox/MCP surface touches this.
 * Future settings/discovery wiring invokes the controller.
 */

import {
  type DesktopFilesystemGrantSubject,
} from "@nautilo/desktop-filesystem-grants";
import {
  type DiscoveredWorkstationFacts,
  type ProfileCapabilityBackend,
  type ProfileNetworkMode,
  type ProfileNetworkPolicy,
  type WorkstationProfile,
  type WorkstationProfileCompileErrorCode,
} from "@nautilo/workstation-profiles";
import type { RelayWorkstationProfileSnapshot } from "@nautilo/relay";
import { randomUUID } from "node:crypto";

import type { DesktopFilesystemGrantAuthority } from "../desktop-filesystem-grants/authority.ts";
import {
  clearCompiledProfileSession,
  compileWorkstationProfileSession,
} from "./compiler.ts";
import { WorkstationProfileStore } from "./store.ts";
import { workstationProfilesFilePath } from "../paths.ts";

/** Redacted capability entry advertised in the profile binding snapshot. */
export interface ActiveWorkstationProfileCapabilityEntry {
  readonly id: string;
  readonly backend: ProfileCapabilityBackend;
}

/** The currently bound active profile session, in-memory only. */
export interface ActiveWorkstationProfileSession {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly subject: DesktopFilesystemGrantSubject;
  readonly grantIds: readonly string[];
  readonly compiledAt: string;
  readonly protectedPolicyVersion: number;
  readonly networkMode: ProfileNetworkMode;
  /**
   * The complete network policy from the stored active profile. This is the
   * LOCAL Electron-main authority for the planned shell sandbox envelope's
   * network posture — it never crosses the wire (the advertised
   * `RelayWorkstationProfileSnapshot` carries only `networkMode`). The relay
   * shell-binding resolver sources it from here and REPLACES the server's
   * `sandboxProfile.config.networkPolicy` with this value.
   */
  readonly network: ProfileNetworkPolicy;
  readonly capabilities: readonly ActiveWorkstationProfileCapabilityEntry[];
}

export interface ActiveWorkstationProfileControllerOptions {
  readonly instanceId: string;
  /**
   * The single main-process grant authority, shared with the relay resolver,
   * advisory snapshot builder, and grant IPC handlers. The controller adds
   * compiled `policy_pack` / `session` grants to this overlay; it never
   * owns a separate authority.
   */
  readonly authority: DesktopFilesystemGrantAuthority;
  /**
   * Inject the owned profile store. When omitted the controller constructs
   * one bound to `workstationProfilesFilePath()` for this instance — the
   * production path. Tests inject an in-memory store.
   */
  readonly profileStore?: WorkstationProfileStore;
  /** Override the owned store file path (tests / non-Electron hosts). */
  readonly filePath?: string;
  /** Inject a clock for deterministic `compiledAt`. */
  readonly clock?: () => Date;
  /** Mints fresh grant ids per compiled root. Defaults to crypto.randomUUID. */
  readonly mintGrantId?: () => string;
  /**
   * Fired after a successful activate / deactivate so the relay can
   * re-advertise its capabilities atomically via
   * `refreshDesktopRelayCapabilities`. Optional because the controller is
   * usable without a live relay (tests, pre-relay boot).
   */
  readonly onActiveProfileChanged?: (reason: string) => void;
}

export type ActiveWorkstationProfileControllerErrorCode =
  | "profile_not_found"
  | "store_unavailable"
  | "store_corrupt"
  | "subject_instance_mismatch"
  | "compile_failed";

export type ActiveWorkstationProfileActivateResult =
  | { readonly ok: true; readonly data: { session: ActiveWorkstationProfileSession } }
  | {
      readonly ok: false;
      readonly code: ActiveWorkstationProfileControllerErrorCode;
      readonly message: string;
      /** The shared compiler error code when the compile step failed. */
      readonly compileErrorCode?: WorkstationProfileCompileErrorCode;
    };

export type ActiveWorkstationProfileDeactivateResult =
  | { readonly ok: true; readonly data: { cleared: number; skipped: readonly string[] } }
  | { readonly ok: false; readonly code: "no_active_profile"; readonly message: string };

function controllerError(
  code: ActiveWorkstationProfileControllerErrorCode,
  message: string,
): { ok: false; code: ActiveWorkstationProfileControllerErrorCode; message: string } {
  return { ok: false, code, message };
}

/**
 * Owns the active profile session state machine. All mutations are
 * serialized through `pending` so a concurrent activate/deactivate cannot
 * tear the active session or the overlay.
 */
export class ActiveWorkstationProfileController {
  private readonly instanceId: string;
  private readonly authority: DesktopFilesystemGrantAuthority;
  private readonly profileStore: WorkstationProfileStore;
  private readonly clock: () => Date;
  private readonly mintGrantId: () => string;
  private readonly onActiveProfileChanged: ((reason: string) => void) | undefined;
  private activeSession: ActiveWorkstationProfileSession | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: ActiveWorkstationProfileControllerOptions) {
    this.instanceId = options.instanceId;
    this.authority = options.authority;
    this.profileStore =
      options.profileStore ??
      new WorkstationProfileStore({
        instanceId: options.instanceId,
        filePath: options.filePath ?? workstationProfilesFilePath(),
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
      });
    this.clock = options.clock ?? (() => new Date());
    this.mintGrantId = options.mintGrantId ?? (() => randomUUID());
    this.onActiveProfileChanged = options.onActiveProfileChanged;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  /**
   * Compiles a stored profile against already-canonical discovered facts
   * into `policy_pack` / `session` overlay grants, then atomically swaps
   * the active session in for the prior one. A failed compile leaves the
   * prior active session and its grants intact — the prior session is
   * cleared ONLY after the new session compiles successfully.
   */
  activate(input: {
    profileId: string;
    facts: DiscoveredWorkstationFacts;
    subject: DesktopFilesystemGrantSubject;
  }): Promise<ActiveWorkstationProfileActivateResult> {
    return this.serialized(async () => {
      if (input.subject.instanceId !== this.instanceId) {
        return controllerError(
          "subject_instance_mismatch",
          "activate subject must bind to this controller's instance",
        );
      }

      const stored = await this.profileStore.get({ profileId: input.profileId });
      if (!stored.ok) {
        // D418 — distinguish store health from a missing profile so the
        // caller (future settings/discovery wiring) can react differently:
        //   - profile_not_found  → the store is fine, the id is unknown;
        //   - store_unavailable  → the store file could not be read;
        //   - store_corrupt      → the store file is invalid JSON / a bad
        //     envelope / belongs to another instance.
        // The store's own typed `code` is the authority; the controller maps
        // it to the narrow controller-side error union.
        if (stored.code === "profile_not_found") {
          return controllerError(
            "profile_not_found",
            "profile not found in this instance store",
          );
        }
        if (stored.code === "store_unavailable") {
          return controllerError(
            "store_unavailable",
            "workstation profile store is unavailable",
          );
        }
        return controllerError(
          "store_corrupt",
          `workstation profile store is corrupt: ${stored.code}`,
        );
      }
      const profile: WorkstationProfile = stored.data.profile;

      // Compile FIRST. compileWorkstationProfileSession is fail-closed and
      // rolls back any partial overlay mutation on failure, so a failed
      // compile adds no authority and the prior session is untouched.
      const compiled = await compileWorkstationProfileSession(
        {
          profile,
          facts: input.facts,
          subject: input.subject,
          authority: this.authority,
        },
        { clock: this.clock, mintGrantId: this.mintGrantId },
      );
      if (!compiled.ok) {
        return {
          ...controllerError(
            "compile_failed",
            `profile compile rejected: ${compiled.code}`,
          ),
          ...(compiled.compileErrorCode !== undefined
            ? { compileErrorCode: compiled.compileErrorCode }
            : {}),
        };
      }

      // The new session compiled successfully. Now it is safe to tear down
      // the prior session's grants and swap the active binding. A transient
      // overlap of old + new grants inside the lock is benign — both are
      // valid authority for the same subject — and the advertised snapshot
      // is derived solely from `activeSession`, which is swapped below.
      if (this.activeSession !== null) {
        await clearCompiledProfileSession({
          authority: this.authority,
          userId: this.activeSession.subject.userId,
          grantIds: this.activeSession.grantIds,
        });
      }

      const nextSession: ActiveWorkstationProfileSession = {
        profileId: compiled.data.profileId,
        profileRevision: compiled.data.profileRevision,
        subject: input.subject,
        grantIds: [...compiled.data.grantIds],
        compiledAt: compiled.data.compiledAt,
        protectedPolicyVersion: profile.protectedPolicyVersion,
        networkMode: profile.network.mode,
        network: profile.network,
        capabilities: profile.toolchainCapabilities.map((capability) => ({
          id: capability.id,
          backend: capability.backend,
        })),
      };
      this.activeSession = nextSession;

      // Notify after the swap so the relay's atomic re-advertise reflects
      // the new binding. Fired within the serialized section so a concurrent
      // activate/deactivate cannot interleave a stale advertisement.
      this.onActiveProfileChanged?.("workstation profile activate");

      return { ok: true, data: { session: nextSession } };
    });
  }

  /**
   * Revokes the active session's policy-pack grants and drops the binding.
   * Idempotent: returns `no_active_profile` when nothing is bound so the
   * caller can distinguish a no-op from a real teardown.
   */
  deactivate(): Promise<ActiveWorkstationProfileDeactivateResult> {
    return this.serialized(async () => {
      const current = this.activeSession;
      if (current === null) {
        return {
          ok: false,
          code: "no_active_profile",
          message: "no active workstation profile is bound",
        };
      }
      const cleared = await clearCompiledProfileSession({
        authority: this.authority,
        userId: current.subject.userId,
        grantIds: current.grantIds,
      });
      this.activeSession = null;
      this.onActiveProfileChanged?.("workstation profile deactivate");
      return { ok: true, data: { cleared: cleared.cleared, skipped: [...cleared.skipped] } };
    });
  }

  /** The currently bound session, or `null`. Read-only snapshot. */
  getActiveSession(): ActiveWorkstationProfileSession | null {
    return this.activeSession;
  }

  /**
   * The complete network policy of the active profile, or `null` when no
   * profile is bound. This is the LOCAL Electron-main authority the relay
   * shell-binding resolver sources to REPLACE the server's sandbox envelope
   * network posture for a plan-bound shell dispatch. It is distinct from the
   * redacted wire snapshot (`getProfileSnapshot`): the full `allow` rules
   * never cross the wire.
   */
  getActiveNetworkPolicy(): ProfileNetworkPolicy | null {
    return this.activeSession === null ? null : this.activeSession.network;
  }

  /**
   * The strict, redacted advisory snapshot advertised in `RelayCapabilities`.
   * `undefined` when no profile is active so the relay omits the field
   * rather than advertising a partial or misleading binding.
   */
  getProfileSnapshot(): Promise<RelayWorkstationProfileSnapshot | undefined> {
    const session = this.activeSession;
    if (session === null) return Promise.resolve(undefined);
    return Promise.resolve({
      profileId: session.profileId,
      profileRevision: session.profileRevision,
      grantIds: [...session.grantIds],
      protectedPolicyVersion: session.protectedPolicyVersion,
      networkMode: session.networkMode,
      capabilities: session.capabilities.map((capability) => ({
        id: capability.id,
        backend: capability.backend,
      })),
    });
  }

  /** The owned profile store (shared with future settings/discovery wiring). */
  getProfileStore(): WorkstationProfileStore {
    return this.profileStore;
  }

  /** The shared grant authority (the relay reads this same instance). */
  getAuthority(): DesktopFilesystemGrantAuthority {
    return this.authority;
  }
}
