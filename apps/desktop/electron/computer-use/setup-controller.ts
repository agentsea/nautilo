import type { DesktopAutomationReceipt } from "./contracts.ts";
import type {
  ComputerUseLocalStore,
  ComputerUseRecoveryCause,
  ComputerUseRevocationResult,
} from "./local-store.ts";

export type ComputerUseManagedState = "unavailable" | "not-enabled" | "enabled";

export interface ComputerUseSetupStatus {
  readonly state: ComputerUseManagedState;
  readonly reason: string | null;
  /** The exact Genie in the durable receipt, never an inferred default. */
  readonly agentId: string | null;
  readonly grantGeneration: number | null;
}

/** Exact Electron-owned facts for the current authenticated Desktop transport. */
export interface ComputerUseSetupRuntime {
  readonly instanceId: string;
  readonly humanUserId: string;
  readonly serverBindingId: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
  /** Ephemeral and never copied into the durable receipt. */
  readonly desktopSessionId: string;
}

export interface VerifiedComputerUsePin {
  /** Used transiently for the follow-up owned-Agent resolution only. */
  readonly accessToken: string;
  readonly humanUserId: string;
}

/** Server/relay facts fetched through Electron-owned authenticated channels. */
export interface ComputerUseActivationAttestation extends ComputerUseSetupRuntime {
  readonly controlDesktop: boolean;
}

export type ComputerUseRevocationFence =
  | {
    readonly kind: "exact_grant";
    readonly receipt: DesktopAutomationReceipt;
    readonly installationEpoch: string;
    readonly grantGeneration: number;
  }
  | {
    readonly kind: "installation_epoch_reset";
    readonly recoveryCause: ComputerUseRecoveryCause;
    readonly installationEpoch: string;
    readonly grantGeneration: number;
  };

export interface ComputerUseSetupControllerDependencies {
  readonly store: ComputerUseLocalStore;
  readonly getRuntime: () => ComputerUseSetupRuntime | null;
  /** Verifies the signed-in Human's own PIN; it must not accept an admin/owner substitute. */
  readonly verifyOwnPin: (
    pin: string,
    expectedHumanUserId: string,
  ) => Promise<VerifiedComputerUsePin | null>;
  /** Resolves the verified Human's exact personal Genie; renderer/model supply no Agent id. */
  readonly resolveOwnedAgent: (
    accessToken: string,
    expectedHumanUserId: string,
    requestedAgentId: string,
  ) => Promise<string | null>;
  /** Re-fetches live Human capability and exact relay capability/bindings. */
  readonly attestActivation: (
    expectedRuntime: ComputerUseSetupRuntime,
  ) => Promise<ComputerUseActivationAttestation | null>;
  /** Synchronous local cancellation/fence; must complete before Off is reported. */
  readonly cancelAndFenceOwnedWork: (fence: ComputerUseRevocationFence) => void;
}

function snapshotRuntime(runtime: ComputerUseSetupRuntime): ComputerUseSetupRuntime {
  return {
    instanceId: runtime.instanceId,
    humanUserId: runtime.humanUserId,
    serverBindingId: runtime.serverBindingId,
    relayId: runtime.relayId,
    pairingGeneration: runtime.pairingGeneration,
    desktopSessionId: runtime.desktopSessionId,
  };
}

function sameRuntime(left: ComputerUseSetupRuntime | null, right: ComputerUseSetupRuntime): boolean {
  return left !== null
    && left.instanceId === right.instanceId
    && left.humanUserId === right.humanUserId
    && left.serverBindingId === right.serverBindingId
    && left.relayId === right.relayId
    && left.pairingGeneration === right.pairingGeneration
    && left.desktopSessionId === right.desktopSessionId;
}

function receiptMatchesRuntime(
  receipt: DesktopAutomationReceipt,
  runtime: ComputerUseSetupRuntime,
): boolean {
  return receipt.instanceId === runtime.instanceId
    && receipt.humanUserId === runtime.humanUserId
    && receipt.serverBindingId === runtime.serverBindingId
    && receipt.relayId === runtime.relayId
    && receipt.pairingGeneration === runtime.pairingGeneration;
}

function attestationMatchesRuntime(
  attestation: ComputerUseActivationAttestation | null,
  runtime: ComputerUseSetupRuntime,
): attestation is ComputerUseActivationAttestation {
  return attestation !== null && sameRuntime(attestation, runtime);
}

function unavailable(reason: string): ComputerUseSetupStatus {
  return { state: "unavailable", reason, agentId: null, grantGeneration: null };
}

class ComputerUseRevocationError extends Error {
  constructor(
    message: string,
    readonly authorityRevoked: boolean,
  ) {
    super(message);
  }
}

/**
 * Electron-local management of the one standing Desktop automation grant.
 * The renderer supplies only a transient PIN. Auto-Approve, approval.ask,
 * prove_it, provider lifecycle, and model-controlled identity have no role at
 * this boundary.
 */
export function createComputerUseSetupController(
  dependencies: ComputerUseSetupControllerDependencies,
) {
  const revokeAndFence = async (): Promise<ComputerUseRevocationResult> => {
    const revoked = await dependencies.store.revoke();
    if (!revoked.ok) {
      throw new ComputerUseRevocationError(
        "Nautilo could not revoke Computer use authority on this Mac.",
        false,
      );
    }
    if (!revoked.data.revoked) return revoked.data;
    const fence: ComputerUseRevocationFence = revoked.data.recovered
      ? {
        kind: "installation_epoch_reset",
        recoveryCause: revoked.data.recoveryCause!,
        installationEpoch: revoked.data.installationEpoch,
        grantGeneration: revoked.data.grantGeneration,
      }
      : {
        kind: "exact_grant",
        receipt: revoked.data.previousReceipt!,
        installationEpoch: revoked.data.installationEpoch,
        grantGeneration: revoked.data.grantGeneration,
      };
    try {
      dependencies.cancelAndFenceOwnedWork(fence);
    } catch {
      throw new ComputerUseRevocationError(
        "Computer use authority is revoked, but owned work could not be cancelled and fenced.",
        true,
      );
    }
    return revoked.data;
  };

  /**
   * Local management truth only: store, current Desktop binding, and the
   * synchronous revocation fence. It deliberately performs no server/live
   * authority attestation, so a wedged relay can never hide PIN-free Off.
   */
  const localStatus = async (): Promise<ComputerUseSetupStatus> => {
    const stored = await dependencies.store.get();
    if (!stored.ok) return unavailable("Nautilo could not read Computer use state on this Mac.");
    const runtime = dependencies.getRuntime();
    if (runtime === null) {
      return {
        state: "unavailable",
        reason: "Connect this signed-in Nautilo Desktop to manage Computer use on this Mac.",
        agentId: stored.data.receipt?.agentId ?? null,
        grantGeneration: stored.data.receipt?.grantGeneration ?? null,
      };
    }
    const current = snapshotRuntime(runtime);
    const receipt = stored.data.receipt;
    if (receipt === null) {
      return {
        state: "not-enabled",
        reason: null,
        agentId: null,
        grantGeneration: null,
      };
    }
    if (!receiptMatchesRuntime(receipt, current) || !sameRuntime(dependencies.getRuntime(), current)) {
      try {
        await revokeAndFence();
      } catch {
        return unavailable("Computer use was disabled because the Desktop binding changed, but local cleanup needs attention.");
      }
      return {
        state: "not-enabled",
        reason: "Computer use was disabled because the signed-in Desktop binding changed.",
        agentId: null,
        grantGeneration: null,
      };
    }
    return {
      state: "enabled",
      reason: null,
      agentId: receipt.agentId,
      grantGeneration: receipt.grantGeneration,
    };
  };

  const status = async (): Promise<ComputerUseSetupStatus> => {
    const stored = await dependencies.store.get();
    if (!stored.ok) return unavailable("Nautilo could not read Computer use state on this Mac.");
    const runtime = dependencies.getRuntime();
    if (runtime === null) {
      return {
        state: "unavailable",
        reason: "Connect this signed-in Nautilo Desktop to manage Computer use on this Mac.",
        agentId: stored.data.receipt?.agentId ?? null,
        grantGeneration: stored.data.receipt?.grantGeneration ?? null,
      };
    }
    const current = snapshotRuntime(runtime);
    const receipt = stored.data.receipt;
    if (receipt === null) {
      return {
        state: "not-enabled",
        reason: null,
        agentId: null,
        grantGeneration: null,
      };
    }
    if (!receiptMatchesRuntime(receipt, current) || !sameRuntime(dependencies.getRuntime(), current)) {
      try {
        await revokeAndFence();
      } catch {
        return unavailable("Computer use was disabled because the Desktop binding changed, but local cleanup needs attention.");
      }
      return {
        state: "not-enabled",
        reason: "Computer use was disabled because the signed-in Desktop binding changed.",
        agentId: null,
        grantGeneration: null,
      };
    }
    let attestation: ComputerUseActivationAttestation | null;
    try {
      attestation = await dependencies.attestActivation(current);
    } catch {
      attestation = null;
    }
    const runtimeStillCurrent = sameRuntime(dependencies.getRuntime(), current);
    if (!attestationMatchesRuntime(attestation, current)
      || !runtimeStillCurrent
      || !attestation.controlDesktop) {
      try {
        await revokeAndFence();
      } catch {
        return unavailable("Computer use was disabled because live Desktop authority changed, but local cleanup needs attention.");
      }
      const reason = !runtimeStillCurrent || !attestationMatchesRuntime(attestation, current)
        ? "Computer use was disabled because live Desktop authority could not be re-attested."
        : "Computer use was disabled because your Desktop control permission changed.";
      return {
        state: "not-enabled",
        reason,
        agentId: null,
        grantGeneration: null,
      };
    }
    // A concurrent local Off wins over this completed remote attestation.
    // Re-read only local truth so an old enabled receipt cannot escape after
    // its revoke/fence has already completed.
    return await localStatus();
  };

  return {
    localStatus,
    status,
    check: status,

    /** The Human supplies their own PIN and an explicit Genie choice; authority facts remain Electron/server derived. */
    async enable(pin: string, requestedAgentId: string): Promise<ComputerUseSetupStatus> {
      if (!/^\d{6,8}$/.test(pin)) {
        throw new Error("Enter your 6–8 digit PIN to enable Computer use.");
      }
      const observed = dependencies.getRuntime();
      if (observed === null) {
        throw new Error("Connect this signed-in Nautilo Desktop before enabling Computer use.");
      }
      const runtime = snapshotRuntime(observed);
      const initialAttestation = await dependencies.attestActivation(runtime);
      if (!attestationMatchesRuntime(initialAttestation, runtime)) {
        throw new Error("Nautilo could not attest this exact Desktop connection. Computer use was not changed.");
      }
      if (!initialAttestation.controlDesktop) {
        throw new Error("Your account does not currently have permission to control this Desktop.");
      }
      const verified = await dependencies.verifyOwnPin(pin, runtime.humanUserId);
      if (verified === null || verified.humanUserId !== runtime.humanUserId) {
        throw new Error("Your PIN could not be verified. Computer use was not changed.");
      }
      const agentId = await dependencies.resolveOwnedAgent(
        verified.accessToken,
        runtime.humanUserId,
        requestedAgentId,
      );
      if (!agentId) {
        throw new Error("Choose a Genie you currently own before enabling Computer use.");
      }
      if (!sameRuntime(dependencies.getRuntime(), runtime)) {
        throw new Error("The Desktop connection changed during Computer use setup. Try again.");
      }
      const finalAttestation = await dependencies.attestActivation(runtime);
      if (!attestationMatchesRuntime(finalAttestation, runtime)
        || !sameRuntime(dependencies.getRuntime(), runtime)) {
        throw new Error("The Desktop connection changed during Computer use setup. Try again.");
      }
      if (!finalAttestation.controlDesktop) {
        throw new Error("Desktop control permission changed during setup. Computer use was not enabled.");
      }
      const minted = await dependencies.store.mint({
        instanceId: runtime.instanceId,
        humanUserId: runtime.humanUserId,
        agentId,
        serverBindingId: runtime.serverBindingId,
        relayId: runtime.relayId,
        pairingGeneration: runtime.pairingGeneration,
      });
      if (!minted.ok) {
        throw new Error("Nautilo could not enable Computer use on this Mac.");
      }
      if (!sameRuntime(dependencies.getRuntime(), runtime)) {
        try {
          await revokeAndFence();
        } catch {
          throw new Error("The Desktop connection changed during setup. Computer use is blocked, but local cleanup needs attention.");
        }
        throw new Error("The Desktop connection changed during setup. Computer use was not enabled.");
      }
      // The bearer is deliberately allowed to leave scope here. Neither it nor
      // the PIN is accepted by the store or returned to the renderer.
      return await localStatus();
    },

    /** Revocation is always local, immediate, and PIN-free—even while disconnected. */
    async disable(): Promise<ComputerUseSetupStatus> {
      try {
        await revokeAndFence();
      } catch (error) {
        if (error instanceof ComputerUseRevocationError && error.authorityRevoked) {
          throw new Error("Computer use is Off, but Nautilo could not finish cancelling and fencing its previous work.");
        }
        throw new Error("Nautilo could not turn off Computer use on this Mac.");
      }
      return await localStatus();
    },
  };
}
