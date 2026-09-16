import type {
  RelayDispatchResult,
  RelayNetworkPolicy,
  RelaySandboxProfile,
  RelayWorkstationShellBinding,
} from "@nautilo/relay";
import {
  resolveRelayDispatchSandbox,
  type RelayDispatchSandboxFactory,
  type RelayDispatchSandboxLocalAuthority,
  type Sandbox,
} from "@nautilo/sandbox";

/**
 * Request-local lower-chain state. It deliberately owns no relay lifecycle,
 * durable stores, grants, profiles, or providers: those remain injected by
 * Electron's active session and are resolved before this value is created.
 */
export interface LocalDispatchPolicy {
  readonly desktopFilesystemAuthority:
    | {
        readonly roots: readonly string[];
        readonly readOnlyRoots?: readonly string[];
        readonly writableRoots?: readonly string[];
      }
    | undefined;
  readonly revalidatedShellBinding: RelayWorkstationShellBinding | undefined;
  readonly shellNetworkPolicy: RelayNetworkPolicy | undefined;
  readonly locallyAuthorizedWorkspace: string | undefined;
  readonly sandboxEnvelope: RelaySandboxProfile | undefined;
  readonly sandbox: Sandbox | null;
}

/**
 * Build the exact immutable hand-off used by the local-file, shell, and
 * terminal lower lanes. A non-match cannot create a sandbox or any authority;
 * the caller supplies only already revalidated local state.
 */
function createLocalDispatchPolicy(
  input: LocalDispatchPolicy,
): LocalDispatchPolicy {
  return Object.freeze({ ...input });
}

export type LocalDispatchPolicyPreparation =
  | { readonly ok: true; readonly policy: LocalDispatchPolicy }
  | { readonly ok: false; readonly result: RelayDispatchResult };

/**
 * Prepare the shared lower-chain policy after direct local-file and fs lanes
 * have declined. Authority-bearing work arrives as narrow local closures; this
 * helper retains no client, profile, grant, or sandbox beyond this request.
 */
export async function prepareLocalDispatchPolicy(input: {
  readonly toolName: string;
  readonly isProduction: boolean;
  readonly desktopFilesystemAuthority: LocalDispatchPolicy["desktopFilesystemAuthority"];
  readonly revalidatedShellBinding: RelayWorkstationShellBinding | undefined;
  readonly shellNetworkPolicy: RelayNetworkPolicy | undefined;
  readonly requestHasShellBinding: boolean;
  readonly augmentEnvelope: () => Promise<
    | {
        readonly ok: true;
        readonly sandboxEnvelope: RelaySandboxProfile | undefined;
        readonly locallyAuthorizedWorkspace: string | undefined;
      }
    | { readonly ok: false; readonly result: RelayDispatchResult }
  >;
  readonly checkUnboundRunShell: () => Promise<RelayDispatchResult | undefined>;
  readonly revalidateWorkspaceBeforeOperation: (
    locallyAuthorizedWorkspace: string | undefined,
  ) => Promise<RelayDispatchResult | undefined>;
  readonly createSandbox?: RelayDispatchSandboxFactory | undefined;
  /** Electron-derived authority; never accepted from the relay request. */
  readonly resolveLocalAuthority?:
    | ((
        locallyAuthorizedWorkspace: string | undefined,
      ) => RelayDispatchSandboxLocalAuthority | undefined)
    | undefined;
}): Promise<LocalDispatchPolicyPreparation> {
  const unboundRefusal = await input.checkUnboundRunShell();
  if (unboundRefusal !== undefined)
    return { ok: false, result: unboundRefusal };

  const augmented = await input.augmentEnvelope();
  if (!augmented.ok) return augmented;
  const sandboxResolution = await resolveRelayDispatchSandbox({
    envelope: augmented.sandboxEnvelope,
    isProduction: input.isProduction,
    developmentRoot: process.cwd(),
    toolName: input.toolName,
    ...(input.createSandbox === undefined
      ? {}
      : { createSandbox: input.createSandbox }),
    ...(input.resolveLocalAuthority === undefined
      ? {}
      : {
          localAuthority: input.resolveLocalAuthority(
            augmented.locallyAuthorizedWorkspace,
          ),
        }),
    reportWarning: (message) => console.warn(message),
  });
  if (!sandboxResolution.ok) {
    return {
      ok: false,
      result: { status: "error", error: sandboxResolution.error },
    };
  }
  const sandbox = sandboxResolution.sandbox;
  if (
    augmented.sandboxEnvelope !== undefined &&
    input.requestHasShellBinding &&
    input.desktopFilesystemAuthority !== undefined &&
    !sandbox.containmentActive()
  ) {
    await sandbox.close();
    return {
      ok: false,
      result: {
        status: "error",
        errorCode: "WORKSTATION_SHELL_SANDBOX_UNAVAILABLE",
        error:
          "workstation shell binding rejected: guarded execution requires an enabled sandbox backend",
      },
    };
  }
  if (
    augmented.sandboxEnvelope !== undefined &&
    input.requestHasShellBinding &&
    input.desktopFilesystemAuthority !== undefined &&
    (augmented.sandboxEnvelope.config.protectedPaths?.length ?? 0) > 0 &&
    !sandbox.protectedFileMaskSupported()
  ) {
    await sandbox.close();
    return {
      ok: false,
      result: {
        status: "error",
        errorCode: "WORKSTATION_SHELL_SANDBOX_UNAVAILABLE",
        error:
          "workstation shell binding rejected: sandbox backend lacks a safe protected-file mask capability",
      },
    };
  }
  let workspaceRefusal: RelayDispatchResult | undefined;
  try {
    workspaceRefusal = await input.revalidateWorkspaceBeforeOperation(
      augmented.locallyAuthorizedWorkspace,
    );
  } catch (error) {
    await sandbox.close();
    throw error;
  }
  if (workspaceRefusal !== undefined) {
    await sandbox.close();
    return { ok: false, result: workspaceRefusal };
  }
  return {
    ok: true,
    policy: createLocalDispatchPolicy({
      desktopFilesystemAuthority: input.desktopFilesystemAuthority,
      revalidatedShellBinding: input.revalidatedShellBinding,
      shellNetworkPolicy: input.shellNetworkPolicy,
      locallyAuthorizedWorkspace: augmented.locallyAuthorizedWorkspace,
      sandboxEnvelope: augmented.sandboxEnvelope,
      sandbox,
    }),
  };
}
