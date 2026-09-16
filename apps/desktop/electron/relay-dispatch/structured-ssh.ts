import * as path from "node:path";

import {
  computeRelaySshApprovedRequestDigestV1,
  parseRelaySshApprovedRequestV1,
  parseRelaySshDispatchBinding,
  RELAY_SSH_APPROVED_REQUEST_VERSION,
  RELAY_SSH_PREPARE_VERSION,
  type RelayCapabilities,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelaySshPrepareFailureCode,
  type RelaySshPrepareRequestV1,
  type RelaySshPrepareResponseV1,
  type RelaySshResolutionFailure,
} from "@nautilo/relay";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";

import {
  runStructuredSshBroker,
  type StructuredSshBrokerDependencies,
  type StructuredSshBrokerResult,
} from "../structured-ssh/broker.ts";
import {
  parseSshInvocationSubject,
  type SshCapabilityTools,
  type SshInvocationSubject,
} from "../structured-ssh/contracts.ts";
import { SshCapabilityStore } from "../structured-ssh/capability-store.ts";
import {
  discoverPreferredSshHostKey,
  observeSshHostKey,
  type SshHostKeyObservationReason,
} from "../structured-ssh/host-key-observation.ts";
import {
  SshHostTrustStore,
  type SshHostTrustStoreErrorCode,
} from "../structured-ssh/host-trust-store.ts";
import {
  observeHumanKnownHosts,
  type HumanKnownHostsObservationReason,
} from "../structured-ssh/human-known-hosts.ts";
import {
  resolveOpenSshDestinationPlan,
  type OpenSshPlanFailure,
} from "../structured-ssh/open-ssh-plan.ts";
import { runOpenSshConfigProbe } from "../structured-ssh/open-ssh-probe.ts";
import {
  SshPreparationStore,
  sshHumanApprovalSummary,
  type SshHostTrustDecision,
} from "../structured-ssh/preparation-store.ts";
import {
  probeSystemSshAgent,
  type SshSystemAgentProbe,
} from "../structured-ssh/system-agent.ts";
import {
  dispatchRetainedOutputArtifact,
  type RunShellOutputArtifactStore,
} from "../run-shell-output-continuity.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type DesktopDispatchDecision,
} from "./router.ts";

/**
 * The only readiness summary Electron may expose outside the local probe.
 * It intentionally excludes public-key fingerprints/handles, socket paths,
 * host targets, trust records, grants, and every diagnostic string.
 *
 * This is the exact allow-listed `RelayCapabilities.structuredSsh` shape. It
 * is used for both local dispatch gating and relay discovery so the two paths
 * cannot drift or acquire renderer/server supplied fields.
 */
export type StructuredSshReadinessProjection = NonNullable<
  RelayCapabilities["structuredSsh"]
>;

/**
 * Electron-local SSH state for exactly one active relay session. Durable
 * stores and broker ports are injected by the owner; this module never owns
 * the relay client, grants, or provider lifecycle.
 */
export interface StructuredSshDispatchRuntime {
  readonly instanceId: string;
  /** Opaque Electron-local active-server scope; never sent to the server. */
  readonly serverBindingId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly appDataDirectory: string;
  /** Always-present local baseline for SCP endpoints; never Current Folder. */
  readonly workspaceRoot: string;
  readonly getCapabilityRevision: () => number;
  readonly capabilityStore: SshCapabilityStore;
  readonly preparationStore: Pick<SshPreparationStore, "create" | "consume">;
  readonly hostTrustStore: SshHostTrustStore;
  /** Test seam; production always probes the fixed local OpenSSH agent. */
  readonly probeReadiness?: () => Promise<StructuredSshReadinessProjection>;
  /** Test seam; production resolves using the fixed OpenSSH config probe. */
  readonly resolveDestinationPlan?: typeof resolveOpenSshDestinationPlan;
  /** Test seams for the two fixed `ssh-keyscan` observation modes. */
  readonly observeHostKey?: typeof observeSshHostKey;
  readonly discoverPreferredHostKey?: typeof discoverPreferredSshHostKey;
  /** Test seam; production performs fixed, read-only `ssh-keygen` lookups. */
  readonly observeHumanKnownHosts?: typeof observeHumanKnownHosts;
  readonly runBroker?: (
    request: Parameters<typeof runStructuredSshBroker>[0],
    input: Parameters<typeof runStructuredSshBroker>[1],
    dependencies: StructuredSshBrokerDependencies,
  ) => Promise<StructuredSshBrokerResult>;
}

function projectStructuredSshReadiness(
  probe: SshSystemAgentProbe,
  enabledTools: SshCapabilityTools | null,
): StructuredSshReadinessProjection {
  if (probe.binaryProbes.ssh !== "observed")
    return {
      version: 1,
      state: "unavailable",
      provider: "openssh",
      ssh: probe.binaryProbes.ssh,
      scp: probe.binaryProbes.scp,
    };
  if (enabledTools === null)
    return {
      version: 1,
      state: "not-enabled",
      provider: "openssh",
      ssh: "observed",
      scp: probe.binaryProbes.scp,
    };
  return {
    version: 1,
    state: "enabled",
    provider: "openssh",
    ssh: "observed",
    scp: probe.binaryProbes.scp,
    auth: enabledTools.auth,
    exec: enabledTools.exec,
    upload: enabledTools.copyUpload,
    download: enabledTools.copyDownload,
  };
}

/**
 * Resolve readiness from Electron-local state only. Probe failures become an
 * unavailable projection so SSH cannot prevent relay registration or erase
 * unrelated capabilities during refresh/reconnect.
 */
export async function resolveStructuredSshReadiness(
  runtime: Pick<
    StructuredSshDispatchRuntime,
    | "probeReadiness"
    | "capabilityStore"
    | "instanceId"
    | "userId"
    | "relayId"
    | "desktopSessionId"
  >,
): Promise<StructuredSshReadinessProjection> {
  try {
    if (runtime.probeReadiness !== undefined)
      return await runtime.probeReadiness();
    const [probe, listed] = await Promise.all([
      probeSystemSshAgent(),
      runtime.capabilityStore.listForDesktopSession({
        instanceId: runtime.instanceId,
        userId: runtime.userId,
        relayId: runtime.relayId,
        desktopSessionId: runtime.desktopSessionId,
      }),
    ]);
    if (!listed.ok)
      throw new Error("structured SSH capability state unavailable");
    const active = listed.data.capabilities.filter(
      (capability) => capability.enabled,
    );
    const enabledTools =
      active.length === 0
        ? null
        : {
            auth: active.some((capability) => capability.tools.auth),
            exec: active.some((capability) => capability.tools.exec),
            copyUpload: active.some(
              (capability) => capability.tools.copyUpload,
            ),
            copyDownload: active.some(
              (capability) => capability.tools.copyDownload,
            ),
          };
    return projectStructuredSshReadiness(probe, enabledTools);
  } catch {
    return {
      version: 1,
      state: "unavailable",
      provider: "openssh",
      ssh: "unavailable",
      scp: "unavailable",
    };
  }
}

function prepareFailure(
  errorCode: RelaySshPrepareFailureCode,
  failure?: RelaySshResolutionFailure,
) {
  return {
    ok: false as const,
    errorCode,
    ...(failure === undefined ? {} : { failure }),
  };
}
function resolutionFailure(
  failure: OpenSshPlanFailure,
): RelaySshResolutionFailure {
  return {
    code: failure.code,
    phase: failure.phase,
    retrySafe: true,
    sideEffectStarted: false,
    stateChanged: false,
    recovery: failure.recovery,
    ...(failure.source === undefined ? {} : { source: failure.source }),
    ...(failure.observed === undefined ? {} : { observed: failure.observed }),
    ...(failure.configuredBounds === undefined
      ? {}
      : { configuredBounds: failure.configuredBounds }),
    ...(failure.completeness === undefined
      ? {}
      : { completeness: false as const }),
    ...(failure.candidates === undefined
      ? {}
      : { candidates: failure.candidates }),
  };
}
function preEffectFailure(
  code: RelaySshResolutionFailure["code"],
  phase: Extract<
    RelaySshResolutionFailure["phase"],
    "trust_store_lookup" | "host_key_scan" | "known_hosts_lookup"
  >,
): RelaySshResolutionFailure {
  return {
    code,
    phase,
    retrySafe: true,
    sideEffectStarted: false,
    stateChanged: false,
    recovery: "retry",
  };
}
function trustStoreLookupFailure(reason?: SshHostTrustStoreErrorCode) {
  return preEffectFailure(
    reason === "store_corrupt"
      ? "trust_store_corrupt"
      : reason === "store_instance_mismatch"
        ? "trust_store_instance_mismatch"
        : "trust_store_unavailable",
    "trust_store_lookup",
  );
}
function hostKeyScanFailure(reason?: SshHostKeyObservationReason) {
  return preEffectFailure(
    reason === "invalid_request"
      ? "scan_invalid_request"
      : (reason ?? "scan_failed"),
    "host_key_scan",
  );
}
function humanKnownHostsLookupFailure(
  reason?: HumanKnownHostsObservationReason,
) {
  return preEffectFailure(
    reason === "invalid_request"
      ? "lookup_invalid_request"
      : (reason ?? "observer_unavailable"),
    "known_hosts_lookup",
  );
}

/** The trust decision persisted with preparation, never server-provided data. */
type TrustDecision =
  | { readonly ok: true; readonly trustDecision: SshHostTrustDecision }
  | { readonly ok: false; readonly failure: RelaySshResolutionFailure };
/**
 * Observe a local target before preparing an effect. An unknown target may be
 * recognized from the Human's `known_hosts`, but no input can forge trust or
 * select an arbitrary host-key source.
 */
async function observeTrust(
  plan: import("../structured-ssh/open-ssh-plan.ts").OpenSshDestinationPlan,
  runtime: StructuredSshDispatchRuntime,
): Promise<TrustDecision> {
  const target = { host: plan.destination.host, port: plan.destination.port };
  let pinned: Awaited<ReturnType<SshHostTrustStore["lookup"]>>;
  try {
    pinned = await runtime.hostTrustStore.lookup({ target });
  } catch {
    return { ok: false, failure: trustStoreLookupFailure() };
  }
  if (!pinned.ok)
    return { ok: false, failure: trustStoreLookupFailure(pinned.code) };
  const discover =
    runtime.discoverPreferredHostKey ?? discoverPreferredSshHostKey;
  if (pinned.data.state === "unknown") {
    let observed: Awaited<ReturnType<typeof discoverPreferredSshHostKey>>;
    try {
      observed = await discover(target);
    } catch {
      return { ok: false, failure: hostKeyScanFailure() };
    }
    if (!observed.ok)
      return { ok: false, failure: hostKeyScanFailure(observed.reason) };
    const observeHumanTrust =
      runtime.observeHumanKnownHosts ?? observeHumanKnownHosts;
    let humanTrust: Awaited<ReturnType<typeof observeHumanKnownHosts>>;
    try {
      humanTrust = await observeHumanTrust({
        target,
        knownHostFiles: plan.knownHostFiles,
        signal: new AbortController().signal,
      });
    } catch {
      return { ok: false, failure: humanKnownHostsLookupFailure() };
    }
    if (!humanTrust.ok)
      return {
        ok: false,
        failure: humanKnownHostsLookupFailure(humanTrust.reason),
      };
    if (humanTrust.trust === "absent")
      return {
        ok: true,
        trustDecision: {
          state: "unknown",
          hostKeyFingerprint: observed.data.fingerprint,
        },
      };
    if (
      humanTrust.hostKeys.some(
        (key) => key.fingerprint === observed.data.fingerprint,
      )
    )
      return {
        ok: true,
        trustDecision: {
          state: "trusted",
          hostKeyFingerprint: observed.data.fingerprint,
        },
      };
    return {
      ok: true,
      trustDecision: {
        state: "changed",
        previousHostKeyFingerprint: humanTrust.hostKeys[0]!.fingerprint,
        hostKeyFingerprint: observed.data.fingerprint,
      },
    };
  }
  const observe = runtime.observeHostKey ?? observeSshHostKey;
  let reobserved: Awaited<ReturnType<typeof observeSshHostKey>>;
  try {
    reobserved = await observe({
      target,
      approvedFingerprint: pinned.data.record.hostKeyFingerprint,
      signal: new AbortController().signal,
    });
  } catch {
    return { ok: false, failure: hostKeyScanFailure() };
  }
  if (reobserved.ok)
    return {
      ok: true,
      trustDecision: {
        state: "trusted",
        hostKeyFingerprint: pinned.data.record.hostKeyFingerprint,
      },
    };
  if (reobserved.reason !== "host_key_changed")
    return { ok: false, failure: hostKeyScanFailure(reobserved.reason) };
  let observed: Awaited<ReturnType<typeof discoverPreferredSshHostKey>>;
  try {
    observed = await discover(target);
  } catch {
    return { ok: false, failure: hostKeyScanFailure() };
  }
  return observed.ok &&
    observed.data.fingerprint !== pinned.data.record.hostKeyFingerprint
    ? {
        ok: true,
        trustDecision: {
          state: "changed",
          previousHostKeyFingerprint: pinned.data.record.hostKeyFingerprint,
          hostKeyFingerprint: observed.data.fingerprint,
        },
      }
    : {
        ok: false,
        failure: hostKeyScanFailure(
          observed.ok ? "host_key_changed" : observed.reason,
        ),
      };
}

/**
 * Commit exactly the prior observation immediately before broker invocation.
 * A stale/corrupt result fails closed; it is never broadened into a grant.
 */
async function commitTrust(
  plan: import("../structured-ssh/open-ssh-plan.ts").OpenSshDestinationPlan,
  decision: SshHostTrustDecision,
  store: SshHostTrustStore,
): Promise<import("../structured-ssh/contracts.ts").SshHostTrustRecord | null> {
  const target = { host: plan.destination.host, port: plan.destination.port };
  try {
    if (decision.state === "unknown") {
      const confirmed = await store.confirm({
        target,
        hostKeyFingerprint: decision.hostKeyFingerprint,
      });
      return confirmed.ok &&
        confirmed.data.record.hostKeyFingerprint === decision.hostKeyFingerprint
        ? confirmed.data.record
        : null;
    }
    if (decision.state === "changed") {
      const current = await store.lookup({ target });
      if (current.ok && current.data.state === "unknown") {
        const confirmed = await store.confirm({
          target,
          hostKeyFingerprint: decision.hostKeyFingerprint,
        });
        return confirmed.ok &&
          confirmed.data.record.hostKeyFingerprint ===
            decision.hostKeyFingerprint
          ? confirmed.data.record
          : null;
      }
      const replaced = await store.replace({
        target,
        previousFingerprint: decision.previousHostKeyFingerprint,
        nextFingerprint: decision.hostKeyFingerprint,
      });
      return replaced.ok &&
        replaced.data.record.hostKeyFingerprint === decision.hostKeyFingerprint
        ? replaced.data.record
        : null;
    }
    const current = await store.lookup({ target });
    if (current.ok && current.data.state === "unknown") {
      const confirmed = await store.confirm({
        target,
        hostKeyFingerprint: decision.hostKeyFingerprint,
      });
      return confirmed.ok &&
        confirmed.data.record.hostKeyFingerprint === decision.hostKeyFingerprint
        ? confirmed.data.record
        : null;
    }
    return current.ok &&
      current.data.state === "trusted" &&
      current.data.record.hostKeyFingerprint === decision.hostKeyFingerprint
      ? current.data.record
      : null;
  } catch {
    return null;
  }
}
/** Re-observe the preparation's exact host key after any wait for approval. */
async function reobserveTrust(
  plan: import("../structured-ssh/open-ssh-plan.ts").OpenSshDestinationPlan,
  decision: SshHostTrustDecision,
  signal: AbortSignal,
  runtime: StructuredSshDispatchRuntime,
): Promise<boolean> {
  try {
    const observed = await (runtime.observeHostKey ?? observeSshHostKey)({
      target: { host: plan.destination.host, port: plan.destination.port },
      approvedFingerprint: decision.hostKeyFingerprint,
      signal,
    });
    return (
      observed.ok && observed.data.fingerprint === decision.hostKeyFingerprint
    );
  } catch {
    return false;
  }
}

/**
 * Bind the server-approved request to this exact local relay session before
 * any SSH effect. The approved request is reparsed and redigested locally;
 * durable capability and trust state remain owned by Electron stores.
 */
export async function prepareStructuredSsh(
  request: RelaySshPrepareRequestV1,
  runtime: StructuredSshDispatchRuntime | undefined,
): Promise<
  | { readonly ok: true; readonly response: RelaySshPrepareResponseV1 }
  | {
      readonly ok: false;
      readonly errorCode: RelaySshPrepareFailureCode;
      readonly failure?: RelaySshResolutionFailure;
    }
> {
  if (runtime === undefined) return prepareFailure("prepare_unavailable");
  const parsedApproved = parseRelaySshApprovedRequestV1(
    request.approvedRequest,
  );
  const approvedOperation = parsedApproved.ok
    ? parsedApproved.request.toolName === "structured_ssh_auth"
      ? "auth"
      : parsedApproved.request.toolName === "structured_ssh_exec"
        ? "exec"
        : parsedApproved.request.toolName === "structured_ssh_copy_upload"
          ? "copy-upload"
          : "copy-download"
    : null;
  if (
    !parsedApproved.ok ||
    parsedApproved.request.toolCallId !== request.toolCallId ||
    approvedOperation !== request.operation ||
    computeRelaySshApprovedRequestDigestV1(parsedApproved.request) !==
      request.approvedRequestDigest
  )
    return prepareFailure("invalid_request");
  const subject = request.subject as SshInvocationSubject;
  if (
    parseSshInvocationSubject(subject) === null ||
    subject.instanceId !== runtime.instanceId ||
    subject.userId !== runtime.userId ||
    subject.relayId !== runtime.relayId ||
    subject.desktopSessionId !== runtime.desktopSessionId ||
    subject.capabilityRevision !== runtime.getCapabilityRevision()
  )
    return prepareFailure("topology_mismatch");
  const capabilitySubject = {
    instanceId: subject.instanceId,
    userId: subject.userId,
    agentId: subject.agentId,
    relayId: subject.relayId,
    desktopSessionId: subject.desktopSessionId,
  };
  let capability: Awaited<
    ReturnType<StructuredSshDispatchRuntime["capabilityStore"]["get"]>
  >;
  try {
    capability = await runtime.capabilityStore.get(capabilitySubject);
  } catch {
    return prepareFailure("prepare_unavailable");
  }
  if (!capability.ok)
    return prepareFailure(
      capability.code === "store_unavailable" ||
        capability.code === "store_corrupt" ||
        capability.code === "store_instance_mismatch"
        ? "prepare_unavailable"
        : "capability_unavailable",
    );
  const localCapability = capability.data.capability;
  if (localCapability === null || localCapability.revokedAt !== undefined)
    return prepareFailure("capability_unavailable");
  if (!localCapability.enabled) return prepareFailure("capability_disabled");
  const requestedTool =
    request.operation === "auth"
      ? localCapability.tools.auth
      : request.operation === "exec"
        ? localCapability.tools.exec
        : request.operation === "copy-upload"
          ? localCapability.tools.copyUpload
          : localCapability.tools.copyDownload;
  if (!requestedTool) return prepareFailure("tool_disabled");
  let resolved: Awaited<ReturnType<typeof resolveOpenSshDestinationPlan>>;
  try {
    resolved = await (
      runtime.resolveDestinationPlan ?? resolveOpenSshDestinationPlan
    )(parsedApproved.request.args.destination, { run: runOpenSshConfigProbe });
  } catch {
    return prepareFailure("destination_unavailable");
  }
  if (!resolved.ok)
    return prepareFailure(
      resolved.failure.code,
      resolutionFailure(resolved.failure),
    );
  const observedTrust = await observeTrust(resolved.plan, runtime);
  if (!observedTrust.ok)
    return prepareFailure(observedTrust.failure.code, observedTrust.failure);
  const created = runtime.preparationStore.create({
    toolCallId: request.toolCallId,
    approvedRequestDigest: request.approvedRequestDigest,
    operation: request.operation,
    subject,
    capabilityStoreRevision: capability.data.revision,
    destinationPlan: resolved.plan,
    destinationIntent: resolved.intent,
    connectionSource: resolved.summary.connectionSource,
    semanticFingerprint: resolved.semanticFingerprint,
    trustDecision: observedTrust.trustDecision,
    approval: sshHumanApprovalSummary(
      parsedApproved.request.args.destination,
      resolved.plan,
      request.operation,
      observedTrust.trustDecision,
    ),
  });
  if (!created.ok) return prepareFailure("preparation_unavailable");
  return {
    ok: true,
    response: {
      version: RELAY_SSH_PREPARE_VERSION,
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      approvedRequestDigest: request.approvedRequestDigest,
      operation: request.operation,
      subject: request.subject,
      preparationId: created.data.preparationId,
      approval: { ...created.data.approval, operation: request.operation },
    },
  };
}

/**
 * Convert private provider/broker failures into stable, secret-free semantic
 * outcomes. Raw provider/broker diagnostics and host details remain local.
 */
function failure(
  code: string,
  detail?: RelaySshResolutionFailure,
): RelayDispatchResult {
  const messages: Readonly<Record<string, string>> = {
    STRUCTURED_SSH_BINDING_INVALID:
      "The structured SSH request binding is invalid. No SSH operation was started.",
    STRUCTURED_SSH_REQUEST_INVALID:
      "The structured SSH request is invalid. No SSH operation was started.",
    STRUCTURED_SSH_REQUEST_MISMATCH:
      "The structured SSH request changed after authorization. No SSH operation was started.",
    STRUCTURED_SSH_UNAVAILABLE:
      "Structured SSH is unavailable on this desktop.",
    STRUCTURED_SSH_BINDING_STALE:
      "The structured SSH desktop-session binding changed before dispatch. Retry on the connected desktop.",
    STRUCTURED_SSH_PREPARATION_NOT_FOUND:
      "The structured SSH preparation is unavailable or was already consumed. Retry the operation.",
    STRUCTURED_SSH_PREPARATION_EXPIRED:
      "The structured SSH preparation expired before dispatch. Retry the operation.",
    STRUCTURED_SSH_PREPARATION_REPLAYED:
      "The structured SSH preparation was already consumed. The operation was not replayed.",
    STRUCTURED_SSH_CAPABILITY_UNAVAILABLE:
      "The enabled structured SSH capability could not be read on this desktop.",
    STRUCTURED_SSH_CAPABILITY_STALE:
      "The structured SSH capability changed before dispatch. Retry using its current state.",
    STRUCTURED_SSH_CONNECTION_SOURCE_DRIFT:
      "The resolved SSH connection changed before dispatch. No SSH operation was started; resolve the destination again.",
    STRUCTURED_SSH_TRUST_STALE:
      "The SSH host-key observation changed before dispatch. No SSH operation was started; review the current host key.",
    STRUCTURED_SSH_NOT_READY:
      "Structured SSH became unavailable locally before dispatch. Check the desktop SSH readiness details and retry.",
    STRUCTURED_SSH_EXECUTION_FAILED:
      "The local structured SSH broker failed unexpectedly after dispatch began. Check the desktop logs before retrying.",
    STRUCTURED_SSH_INVALID_REQUEST:
      "The structured SSH broker rejected the request before starting SSH.",
    STRUCTURED_SSH_ABORTED: "The structured SSH operation was cancelled.",
    STRUCTURED_SSH_OPERATION_UNSUPPORTED:
      "This structured SSH operation is not supported by the desktop.",
    STRUCTURED_SSH_CAPABILITY_INVALID:
      "The desktop's structured SSH capability record is invalid.",
    STRUCTURED_SSH_CAPABILITY_REVISION_MISMATCH:
      "The structured SSH capability revision changed before execution.",
    STRUCTURED_SSH_CAPABILITY_SUBJECT_MISMATCH:
      "The structured SSH capability belongs to a different desktop session or Agent.",
    STRUCTURED_SSH_CAPABILITY_DISABLED:
      "Structured SSH is turned off on this desktop.",
    STRUCTURED_SSH_CAPABILITY_NOT_AUTHORIZED:
      "This structured SSH operation is not enabled on the desktop.",
    STRUCTURED_SSH_IDENTITY_SOURCE_UNAVAILABLE:
      "The identities selected by this Mac's OpenSSH configuration could not be used.",
    STRUCTURED_SSH_HOST_TRUST_UNAVAILABLE:
      "The desktop could not read its SSH host-trust record.",
    STRUCTURED_SSH_HOST_NOT_TRUSTED:
      "The SSH destination does not have a current Human-confirmed host key.",
    STRUCTURED_SSH_HOST_KEY_UNAVAILABLE:
      "The SSH host key could not be observed before execution.",
    STRUCTURED_SSH_HOST_KEY_CHANGED:
      "The SSH host key changed before execution. No remote operation was started.",
    STRUCTURED_SSH_HOST_KEY_AMBIGUOUS:
      "The SSH destination returned multiple conflicting host keys.",
    STRUCTURED_SSH_CONFINEMENT_FAILED:
      "The structured SSH operation could not establish its local confinement.",
    STRUCTURED_SSH_COPY_PATH_UNAVAILABLE:
      "The local copy path could not be resolved safely.",
    STRUCTURED_SSH_COPY_PATH_NOT_AUTHORIZED:
      "The local copy path is outside the authorized Workspace.",
    STRUCTURED_SSH_COPY_TRANSFER_LIMITED:
      "The SSH copy completed without a verifiable local transfer result.",
    STRUCTURED_SSH_SSH_SPAWN_FAILED:
      "The system OpenSSH process could not be started.",
    STRUCTURED_SSH_SSH_TIMED_OUT: "The remote SSH operation timed out.",
    STRUCTURED_SSH_SSH_OUTPUT_LIMITED:
      "The SSH operation exceeded the bounded diagnostic output limit.",
    STRUCTURED_SSH_SSH_EXIT_NONZERO:
      "The remote SSH server rejected the identities available through this Mac's " +
      "OpenSSH setup. Check that the intended public key is authorized for the " +
      "resolved remote user.",
    STRUCTURED_SSH_SSH_RUNNER_FAILED:
      "The system OpenSSH process failed unexpectedly after it started.",
    STRUCTURED_SSH_CLEANUP_FAILED:
      "The SSH operation could not safely remove its temporary local trust material.",
  };
  console.warn(`[structured-ssh] dispatch failure code=${code}`);
  return {
    status: "error",
    errorCode: code,
    error:
      messages[code] ??
      "Structured SSH failed for an unknown desktop reason. Check the desktop logs before retrying.",
    ...(detail === undefined
      ? {}
      : { result: { structuredSshFailure: detail } }),
  };
}

/**
 * Reconstruct only the exact approved request shape. This prevents dispatch
 * from accepting extra arguments or reusing a binding for another operation.
 */
function exactRequest(request: RelayDispatchRequest) {
  const binding = request.sshBinding;
  if (
    binding === undefined ||
    request.toolName !== "ssh" ||
    request.executionClass !== "structured-ssh" ||
    request.approvalObtained !== true
  )
    return null;
  const operation = request.args["operation"];
  if (
    operation !== binding.operation ||
    (operation !== "auth" &&
      operation !== "exec" &&
      operation !== "copy-upload" &&
      operation !== "copy-download")
  )
    return null;
  const timeoutReason = request.args["timeoutReason"];
  const keys = Object.keys(request.args).sort();
  const execKeys = [
    "argv",
    "destination",
    "operation",
    "program",
    "timeoutSeconds",
    ...(timeoutReason === undefined ? [] : ["timeoutReason"]),
  ].sort();
  const copyKeys = [
    "destination",
    "localPath",
    "operation",
    "remotePath",
    "timeoutSeconds",
    ...(timeoutReason === undefined ? [] : ["timeoutReason"]),
  ].sort();
  const approved =
    operation === "auth"
      ? keys.length === 2 &&
        keys[0] === "destination" &&
        keys[1] === "operation"
        ? {
            version: RELAY_SSH_APPROVED_REQUEST_VERSION,
            toolCallId: binding.toolCallId,
            toolName: "structured_ssh_auth" as const,
            args: { destination: request.args["destination"] },
          }
        : null
      : operation === "exec" &&
          keys.length === execKeys.length &&
          keys.every((key, index) => key === execKeys[index])
        ? {
            version: RELAY_SSH_APPROVED_REQUEST_VERSION,
            toolCallId: binding.toolCallId,
            toolName: "structured_ssh_exec" as const,
            args: {
              destination: request.args["destination"],
              program: request.args["program"],
              argv: request.args["argv"],
              timeoutSeconds: request.args["timeoutSeconds"],
              ...(timeoutReason === undefined ? {} : { timeoutReason }),
            },
          }
        : operation === "copy-upload" &&
            keys.length === copyKeys.length &&
            keys.every((key, index) => key === copyKeys[index])
          ? {
              version: RELAY_SSH_APPROVED_REQUEST_VERSION,
              toolCallId: binding.toolCallId,
              toolName: "structured_ssh_copy_upload" as const,
              args: {
                destination: request.args["destination"],
                localPath: request.args["localPath"],
                remotePath: request.args["remotePath"],
                timeoutSeconds: request.args["timeoutSeconds"],
                ...(timeoutReason === undefined ? {} : { timeoutReason }),
              },
            }
          : operation === "copy-download" &&
              keys.length === copyKeys.length &&
              keys.every((key, index) => key === copyKeys[index])
            ? {
                version: RELAY_SSH_APPROVED_REQUEST_VERSION,
                toolCallId: binding.toolCallId,
                toolName: "structured_ssh_copy_download" as const,
                args: {
                  destination: request.args["destination"],
                  remotePath: request.args["remotePath"],
                  localPath: request.args["localPath"],
                  timeoutSeconds: request.args["timeoutSeconds"],
                  ...(timeoutReason === undefined ? {} : { timeoutReason }),
                },
              }
            : null;
  if (approved === null) return null;
  const parsed = parseRelaySshApprovedRequestV1(approved);
  return parsed.ok ? parsed.request : null;
}

/**
 * Consume one preparation and revalidate topology, capability, destination,
 * and host trust immediately before the broker can start SSH. Every mismatch
 * is a fail-closed result; only the injected broker owns native execution.
 */
async function dispatchStructuredSsh(
  request: RelayDispatchRequest,
  signal: AbortSignal | undefined,
  runtime: StructuredSshDispatchRuntime | undefined,
  outputArtifactStore?: RunShellOutputArtifactStore,
): Promise<RelayDispatchResult> {
  const parsedBinding = parseRelaySshDispatchBinding(request.sshBinding);
  if (!parsedBinding.ok) return failure("STRUCTURED_SSH_BINDING_INVALID");
  const binding = parsedBinding.binding;
  const approved = exactRequest(request);
  if (approved === null || approved.toolCallId !== binding.toolCallId)
    return failure("STRUCTURED_SSH_REQUEST_INVALID");
  if (
    computeRelaySshApprovedRequestDigestV1(approved) !==
    binding.approvedRequestDigest
  )
    return failure("STRUCTURED_SSH_REQUEST_MISMATCH");
  if (runtime === undefined) return failure("STRUCTURED_SSH_UNAVAILABLE");
  const subject = binding.subject as SshInvocationSubject;
  if (
    parseSshInvocationSubject(subject) === null ||
    subject.instanceId !== runtime.instanceId ||
    subject.userId !== runtime.userId ||
    subject.relayId !== runtime.relayId ||
    subject.desktopSessionId !== runtime.desktopSessionId ||
    subject.capabilityRevision !== runtime.getCapabilityRevision()
  )
    return failure("STRUCTURED_SSH_BINDING_STALE");
  const prepared = runtime.preparationStore.consume({
    preparationId: binding.preparationId,
    toolCallId: binding.toolCallId,
    approvedRequestDigest: binding.approvedRequestDigest,
    operation: binding.operation,
    subject,
  });
  if (!prepared.ok)
    return failure(`STRUCTURED_SSH_${prepared.code.toUpperCase()}`);
  const capabilitySubject = {
    instanceId: subject.instanceId,
    userId: subject.userId,
    agentId: subject.agentId,
    relayId: subject.relayId,
    desktopSessionId: subject.desktopSessionId,
  };
  let capability: Awaited<
    ReturnType<StructuredSshDispatchRuntime["capabilityStore"]["get"]>
  >;
  try {
    capability = await runtime.capabilityStore.get(capabilitySubject);
  } catch {
    return failure("STRUCTURED_SSH_CAPABILITY_UNAVAILABLE");
  }
  if (
    !capability.ok ||
    capability.data.revision !== prepared.data.capabilityStoreRevision ||
    capability.data.capability === null
  )
    return failure("STRUCTURED_SSH_CAPABILITY_STALE");
  const abortSignal = signal ?? new AbortController().signal;
  const drift = (): RelayDispatchResult =>
    failure("STRUCTURED_SSH_CONNECTION_SOURCE_DRIFT", {
      code: "connection_source_drift",
      phase: "dispatch_reresolve",
      retrySafe: true,
      sideEffectStarted: false,
      stateChanged: false,
      recovery: "retry",
    });
  let fresh: Awaited<ReturnType<typeof resolveOpenSshDestinationPlan>>;
  try {
    fresh = await (
      runtime.resolveDestinationPlan ?? resolveOpenSshDestinationPlan
    )(prepared.data.destinationIntent, {
      run: runOpenSshConfigProbe,
      signal: abortSignal,
    });
  } catch {
    return drift();
  }
  if (
    !fresh.ok ||
    fresh.semanticFingerprint !== prepared.data.semanticFingerprint ||
    fresh.summary.connectionSource.kind !==
      prepared.data.connectionSource.kind ||
    fresh.summary.connectionSource.name !== prepared.data.connectionSource.name
  )
    return drift();
  if (
    !(await reobserveTrust(
      fresh.plan,
      prepared.data.trustDecision,
      abortSignal,
      runtime,
    ))
  )
    return failure("STRUCTURED_SSH_TRUST_STALE");
  const pinnedTrust = await commitTrust(
    fresh.plan,
    prepared.data.trustDecision,
    runtime.hostTrustStore,
  );
  if (pinnedTrust === null) return failure("STRUCTURED_SSH_TRUST_STALE");
  if ((await resolveStructuredSshReadiness(runtime)).state !== "enabled")
    return failure("STRUCTURED_SSH_NOT_READY");
  let outcome: StructuredSshBrokerResult;
  try {
    outcome = await (runtime.runBroker ?? runStructuredSshBroker)(
      approved,
      {
        subject,
        sshCapabilityRevision: prepared.data.capabilityStoreRevision,
        capability: capability.data.capability,
        plan: fresh.plan,
        appDataDirectory: runtime.appDataDirectory,
        workspaceRoot: runtime.workspaceRoot,
        signal: abortSignal,
      },
      {
        getPinnedHostTrust: async ({ target }) => {
          const current = await runtime.hostTrustStore.lookup({ target });
          return current.ok &&
            current.data.state === "trusted" &&
            current.data.record.hostKeyFingerprint ===
              pinnedTrust.hostKeyFingerprint
            ? { ok: true as const, record: current.data.record }
            : { ok: false as const };
        },
        reportProgress: request.reportStructuredSshProgress,
        outputArtifactStore,
        outputArtifactOwner: request.structuredSshOutputOwnerBinding,
      },
    );
  } catch {
    return failure("STRUCTURED_SSH_EXECUTION_FAILED");
  }
  if (!outcome.ok)
    return failure(`STRUCTURED_SSH_${outcome.reason.toUpperCase()}`);
  return {
    status: "ok",
    result:
      outcome.operation === "auth"
        ? {
            version: 1,
            operation: "auth",
            authenticated: true,
            sideEffectStarted: outcome.sideEffectStarted,
            retrySafe: outcome.retrySafe,
          }
        : outcome.operation === "exec"
          ? {
              version: 1,
              operation: "exec",
              exitCode: outcome.exitCode,
              stdout: outcome.stdout,
              stderr: outcome.stderr,
              stdoutTruncated: outcome.stdoutTruncated,
              stderrTruncated: outcome.stderrTruncated,
              ...(outcome.outputArtifact === undefined
                ? {}
                : { outputArtifact: outcome.outputArtifact }),
              sideEffectStarted: outcome.sideEffectStarted,
              retrySafe: outcome.retrySafe,
            }
          : {
              version: 1,
              operation: outcome.operation,
              bytes: outcome.bytes,
              sideEffectStarted: outcome.sideEffectStarted,
              retrySafe: outcome.retrySafe,
            },
  };
}

/**
 * The family owns its retained-output operation before its broad SSH match.
 * A non-match returns the shared frozen sentinel without touching stores or
 * the broker, preserving the fixed Desktop dispatcher precedence.
 */
export async function dispatchStructuredSshFamily(input: {
  readonly request: RelayDispatchRequest;
  readonly signal: AbortSignal | undefined;
  readonly runtime: StructuredSshDispatchRuntime | undefined;
  readonly outputArtifactStore?: RunShellOutputArtifactStore | undefined;
}): Promise<DesktopDispatchDecision> {
  const { request } = input;
  if (request.toolName === "structured_ssh_output") {
    if (
      request.executionClass !== "desktop" ||
      request.args["output_artifact"] === undefined
    )
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "STRUCTURED_SSH_OUTPUT_ARTIFACT_REQUEST_INVALID",
          error: "Structured SSH output continuation request is invalid.",
        },
      };
    const retained = dispatchRetainedOutputArtifact(
      request.args,
      request.structuredSshOutputOwnerBinding,
      input.outputArtifactStore,
    );
    return {
      handled: true,
      result: retained.ok
        ? { status: "ok", result: retained.result }
        : retained.reason === "invalid"
          ? {
              status: "error",
              errorCode: "STRUCTURED_SSH_OUTPUT_ARTIFACT_REQUEST_INVALID",
              error: "Structured SSH output continuation request is invalid.",
            }
          : retained.reason === "unavailable"
            ? {
                status: "error",
                errorCode: "STRUCTURED_SSH_OUTPUT_ARTIFACT_UNAVAILABLE",
                error:
                  "Structured SSH output continuation is unavailable on this Desktop session.",
              }
            : {
                status: "error",
                errorCode: "STRUCTURED_SSH_OUTPUT_ARTIFACT_NOT_FOUND",
                error:
                  "Structured SSH output continuation is unavailable, expired, or belongs to another session.",
              },
    };
  }
  if (
    request.toolName !== "ssh" &&
    request.executionClass !== "structured-ssh" &&
    request.sshBinding === undefined
  )
    return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
  return {
    handled: true,
    result: await dispatchStructuredSsh(
      request,
      input.signal,
      input.runtime,
      input.outputArtifactStore,
    ),
  };
}

/**
 * Construct session-local durable state only after `startRelay` has bound the
 * exact instance/server/user/relay/session tuple. Invalid local identity
 * inputs fail closed instead of producing a partially scoped runtime.
 */
export function createStructuredSshDispatchRuntime(input: {
  readonly instanceId: string;
  readonly serverBindingId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly appDataDirectory: string;
  readonly workspaceRoot: string;
  readonly getCapabilityRevision: () => number;
}): StructuredSshDispatchRuntime | null {
  if (
    !path.isAbsolute(input.appDataDirectory) ||
    input.appDataDirectory.length === 0 ||
    !path.isAbsolute(input.workspaceRoot) ||
    input.workspaceRoot.length === 0 ||
    !isCanonicalNautiloInstanceId(input.instanceId) ||
    !/^ssh-server-binding-[A-Za-z0-9_-]{16,128}$/.test(input.serverBindingId) ||
    input.userId.length === 0 ||
    input.relayId.length === 0 ||
    input.desktopSessionId.length === 0
  )
    return null;
  return {
    ...input,
    capabilityStore: new SshCapabilityStore({
      instanceId: input.instanceId,
      serverBindingId: input.serverBindingId,
      filePath: path.join(
        input.appDataDirectory,
        `${input.serverBindingId}.capabilities.json`,
      ),
    }),
    preparationStore: new SshPreparationStore(),
    hostTrustStore: new SshHostTrustStore({
      instanceId: input.instanceId,
      filePath: path.join(
        input.appDataDirectory,
        `${input.serverBindingId}.host-trust.json`,
      ),
    }),
  };
}
