/**
 * Server-side construction of the per-turn relay sandbox envelope.
 * D060 Sprint 1 G5.4.b (ship plan v3 §5.4).
 *
 * The Policy Resolver runs this once per relay-dispatched tool call,
 * combining:
 *
 *   - Server posture (`deploymentMode` + `securityLevel`) from
 *     `@nautilo/config::resolveServerPosture()` — server-enforced,
 *     not env-var overridable (G5.6 discipline).
 *   - Relay-reported server-private paths (`workspaceRoot` as the
 *     app-owned Workspace baseline, with the generic active-jail first root
 *     available for relays that have not yet advertised the named root, plus
 *     the G5.4 additions `dataDir` + `toolsBin` + `userHome`). The server
 *     never invents filesystem paths on the relay\u0027s machine — the
 *     relay reports them at registration; the server combines them
 *     with posture to produce the envelope.
 *   - `@nautilo/sandbox`\u0027s deployment-profile helpers
 *     (`serverRestrictive` / `desktopPermissive` / `desktopLocked`)
 *     as the SINGLE source of truth for what each mode means. We
 *     don\u0027t re-derive writable/readOnly shapes here; we call the
 *     helper and serialize its output to the relay wire format.
 *
 * If the relay hasn\u0027t reported the required paths yet (older client
 * before G5.4.c), this returns `null` and the caller logs a warning
 * + dispatches without an envelope. Release builds will refuse that
 * dispatch once G5.4.c ships the relay-side guard; for the G5.4.b
 * foundation commit we just forward what we have.
 */

import type {
  RelayCapabilities,
  RelayNetworkAllowRule,
  RelayNetworkPolicy,
  RelaySandboxProfile,
} from "@nautilo/relay";
import {
  desktopLocked,
  desktopPermissive,
  serverRestrictive,
  type SandboxProfileSpec,
} from "@nautilo/sandbox";
import {
  defaultNetworkPolicyForDeploymentMode,
  type NetworkAllowRule,
  type NetworkPolicy,
  type ServerPosture,
} from "@nautilo/config";
import { warn } from "@nautilo/logger";

export interface BuildRelaySandboxProfileInputs {
  readonly posture: ServerPosture;
  readonly relayCaps: RelayCapabilities;
  readonly currentFolder?: string | null;
  readonly extraWritablePaths?: readonly string[];
  readonly extraNetworkAllowRules?: readonly NetworkAllowRule[];
}

/**
 * Returns the wire-format envelope ready to attach to a
 * `relay:dispatch` message, or `null` if the relay hasn\u0027t reported
 * the paths needed to construct one.
 */
export function buildRelaySandboxProfile(
  inputs: BuildRelaySandboxProfileInputs,
): RelaySandboxProfile | null {
  const {
    posture,
    relayCaps,
    currentFolder,
    extraWritablePaths = [],
    extraNetworkAllowRules = [],
  } = inputs;
  const networkPolicy = toRelayNetworkPolicy(
    mergeExtraNetworkRules(
      posture.networkPolicy ??
        defaultNetworkPolicyForDeploymentMode(posture.deploymentMode),
      extraNetworkAllowRules,
    ),
  );

  // D458: every current relay explicitly advertises its canonical Workspace.
  // The generic jail list is not a fallback source for execution identity.
  const workspace = relayCaps.workspaceRoot;
  if (workspace === undefined || workspace.length === 0) return null;
  // Filesystem identity comes from the execution host, not from the security
  // strictness selected for that host. A Desktop relay must keep the Human's
  // exact Current Folder even when the server applies the paranoid `server`
  // profile; that profile may narrow permissions and network access, but must
  // never silently substitute the unrelated Genie Workspace. A true headless
  // relay has no Desktop Current Folder and remains workspace-confined.
  const executionRoot =
    relayCaps.profile === "desktop-agent"
      ? resolveDesktopExecutionRoot(
          currentFolder,
          workspace,
          relayCaps.currentFolderRoot,
        )
      : workspace;

  // dataDir + toolsBin are non-negotiable inputs to every deployment
  // profile helper. Without them we can\u0027t build a valid spec —
  // bail cleanly so the caller falls back to the legacy path.
  if (
    relayCaps.dataDir === undefined ||
    relayCaps.dataDir.length === 0 ||
    relayCaps.toolsBin === undefined ||
    relayCaps.toolsBin.length === 0
  ) {
    return null;
  }

  const sharedInputs = {
    dataDir: relayCaps.dataDir,
    toolsBin: relayCaps.toolsBin,
  };

  let spec: SandboxProfileSpec;
  switch (posture.deploymentMode) {
    case "server":
      // `serverRestrictive` supplies the paranoid permission/network shape.
      // On Desktop its execution root is still the live Current Folder; on a
      // headless relay `executionRoot` is the canonical server workspace.
      spec = serverRestrictive({
        ...sharedInputs,
        artifactsDir: executionRoot,
        extraWritablePaths,
      });
      break;

    case "desktop-permissive":
      if (
        relayCaps.userHome === undefined ||
        relayCaps.userHome.length === 0
      ) {
        // The permissive helper throws without userHome. Rather
        // than that hard-failure, degrade to locked — workspace-only
        // containment is the safe narrower shape. Log the downgrade
        // so an operator debugging "why can't the Agent read my home
        // dir" has a trail pointing at the root cause (a misbehaving
        // relay that omits userHome in its capabilities registration).
        //
        // PR-017 MINOR #1 — previously silent; the original comment
        // said "the caller can log" but no caller did. Logging inline
        // guarantees the trail exists regardless of which call site
        // triggered the downgrade.
        warn(
          "[sandbox-profile-builder] relay claimed desktop-permissive " +
            "but omitted userHome in RelayCapabilities — downgrading " +
            "to desktop-locked for this dispatch (workspace-only " +
            "containment is the safe narrower shape). Fix the relay's " +
            "RelayCapabilities.userHome to restore desktop-permissive.",
        );
        spec = desktopLocked({
          ...sharedInputs,
          currentProject: executionRoot,
          extraWritablePaths,
        });
      } else {
        spec = desktopPermissive({
          ...sharedInputs,
          currentProject: executionRoot,
          userHome: relayCaps.userHome,
          extraWritablePaths,
        });
      }
      break;

    case "desktop-locked":
      spec = desktopLocked({
        ...sharedInputs,
        currentProject: executionRoot,
        extraWritablePaths,
      });
      break;
  }

  // Serialize SandboxProfileSpec into the relay wire format. Fields
  // are structurally identical today; keeping the serialization
  // explicit anchors the protocol so a future SandboxConfig field
  // can\u0027t accidentally leak over the wire without a deliberate
  // protocol-version bump.
  return {
    workspace: spec.spec.workspace,
    dataDir: spec.spec.dataDir,
    toolsBin: spec.spec.toolsBin,
    mode: spec.mode,
    securityLevel: posture.securityLevel,
    // `failIfNoBackend` encodes the paranoid contract — if the
    // helper set it true (server + desktop-locked do), the relay
    // MUST refuse to execute when bwrap/sandbox-exec is missing.
    // Carrying it through the wire is the G5.4.c self-review SEC-1
    // fix; previously the relay hardcoded false and silently
    // passthrough-executed paranoid-level dispatches.
    //
    // PR-017 nit — the `?? false` is type-system conformance only
    // (Omit<SandboxCreateOptions, "backend"> has `failIfNoBackend?`
    // as optional). All three profile helpers set it explicitly
    // (`serverRestrictive` + `desktopLocked` → true; `desktopPermissive`
    // → false), so the fallback is runtime-unreachable. Kept in
    // place rather than tightening `SandboxCreateOptions` because
    // that ripples to Sandbox.create() callers outside the profile
    // path.
    failIfNoBackend: spec.spec.failIfNoBackend ?? false,
    config: {
      mode: spec.spec.config.mode,
      writablePaths: spec.spec.config.writablePaths,
      projectPaths: spec.spec.config.projectPaths,
      ...(spec.spec.config.readOnlyPaths !== undefined
        ? { readOnlyPaths: spec.spec.config.readOnlyPaths }
        : {}),
      passthroughEnv: spec.spec.config.passthroughEnv,
      networkPolicy,
    },
  };
}

function resolveDesktopExecutionRoot(
  currentFolder: string | null | undefined,
  workspaceBaseline: string,
  advertisedCurrentFolder: string | undefined,
): string {
  // A turn's Current Folder is untrusted cross-host context until the exact
  // selected relay has bound and advertised that same path. Relays without a
  // binding stay useful in their Genie Workspace baseline rather than letting
  // mobile context select an arbitrary desktop path.
  if (
    isSafeDesktopExecutionRoot(currentFolder) &&
    advertisedCurrentFolder !== undefined &&
    pathEquals(currentFolder, advertisedCurrentFolder)
  ) {
    return currentFolder;
  }
  return workspaceBaseline;
}

function pathEquals(left: string, right: string): boolean {
  // Capability paths come from the exact Relay's private registration and are
  // normalized by Electron. Keep this lexical comparison platform-neutral at
  // the server boundary; Electron performs final realpath/containment checks.
  return left.replace(/[\\/]+$/g, "") === right.replace(/[\\/]+$/g, "");
}

function isSafeDesktopExecutionRoot(
  candidate: string | null | undefined,
): candidate is string {
  if (candidate === null || candidate === undefined) return false;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed !== candidate) return false;
  const isPosixAbs = trimmed.startsWith("/");
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!isPosixAbs && !isWindowsAbs) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;

  const low = trimmed.toLowerCase();
  const macUserVolume = low.startsWith("/system/volumes/");
  const blocked = [
    "/etc/",
    "/var/root/",
    "/system/",
    "/private/etc/",
    "/private/var/root/",
    "c:\\windows\\",
    "c:/windows/",
  ];
  return !(
    !macUserVolume &&
    blocked.some((p) => low.startsWith(p) || low === p.slice(0, -1))
  );
}

function mergeExtraNetworkRules(
  policy: NetworkPolicy,
  extraRules: readonly NetworkAllowRule[],
): NetworkPolicy {
  if (extraRules.length === 0 || policy.mode === "host") return policy;
  if (policy.mode === "proxy-allowlist") {
    return {
      ...policy,
      allow: dedupeNetworkAllowRules([...policy.allow, ...extraRules]),
    };
  }
  return {
    mode: "proxy-allowlist",
    allow: dedupeNetworkAllowRules(extraRules),
  };
}

function dedupeNetworkAllowRules(
  rules: readonly NetworkAllowRule[],
): NetworkAllowRule[] {
  const out = new Map<string, NetworkAllowRule>();
  for (const rule of rules) out.set(networkAllowRuleKey(rule), rule);
  return Array.from(out.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rule]) => rule);
}

function networkAllowRuleKey(rule: NetworkAllowRule): string {
  const ports = [...(rule.ports ?? [])].sort((a, b) => a - b).join(",");
  switch (rule.type) {
    case "domain":
      return `domain:${rule.host}:${ports}`;
    case "wildcard":
      return `wildcard:${rule.suffix}:${ports}`;
    case "cidr":
      return `cidr:${rule.cidr}:${ports}`;
  }
}

function toRelayNetworkPolicy(policy: NetworkPolicy): RelayNetworkPolicy {
  if (policy.mode === "host" || policy.mode === "isolated") {
    return { mode: policy.mode };
  }
  return {
    mode: "proxy-allowlist",
    allow: policy.allow.map(toRelayNetworkAllowRule),
    ...(policy.defaultPort !== undefined ? { defaultPort: policy.defaultPort } : {}),
  };
}

function toRelayNetworkAllowRule(
  rule: Extract<NetworkPolicy, { mode: "proxy-allowlist" }>["allow"][number],
): RelayNetworkAllowRule {
  if (rule.type === "domain") {
    return {
      type: "domain",
      host: rule.host,
      ...(rule.ports !== undefined ? { ports: rule.ports } : {}),
    };
  }
  if (rule.type === "wildcard") {
    return {
      type: "wildcard",
      suffix: rule.suffix,
      ...(rule.ports !== undefined ? { ports: rule.ports } : {}),
    };
  }
  return {
    type: "cidr",
    cidr: rule.cidr,
    ...(rule.ports !== undefined ? { ports: rule.ports } : {}),
  };
}
