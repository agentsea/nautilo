import {
  assertVerifiedHumanMembershipTransition,
  type HumanMembershipTargetRoomRole,
  type HumanMembershipTransition,
  type HumanMembershipTransitionKind,
} from "../../delivery/human-membership-transition.ts";
import type {
  HumanMembershipAdmissionResult,
} from "./postgres-human-membership-admission-repository.ts";

export interface HumanMembershipAtomicActivationRequest {
  readonly operationId: string;
  readonly kind: HumanMembershipTransitionKind;
  readonly roomId: string;
  readonly activatedAt: number;
  readonly auditRef: string;
  readonly outboxId: string;
}

export type HumanMembershipAtomicActivationResult =
  | {
    readonly status: "activated" | "duplicate";
    readonly kind: HumanMembershipTransitionKind;
    readonly roomId: string;
    readonly targetHumanActorId: string;
    readonly targetRoomRole: HumanMembershipTargetRoomRole | null;
    readonly namespaceId: string;
    readonly accessRevision: number;
  }
  | { readonly status: "not_ready" | "stale_state" };

export interface HumanMembershipAtomicPort<Transaction> {
  transaction<Result>(
    callback: (transaction: Transaction) => Promise<Result>,
  ): Promise<Result>;
  lockRoomInTx(transaction: Transaction, roomId: string): Promise<void>;
  admitRemovalCryptoInTx(
    transaction: Transaction,
    input: {
      readonly transition: HumanMembershipTransition;
      readonly requestedAt: number;
    },
  ): Promise<HumanMembershipAdmissionResult>;
  activateCryptoInTx(
    transaction: Transaction,
    input: HumanMembershipAtomicActivationRequest,
  ): Promise<HumanMembershipAtomicActivationResult>;
  addHumanToRoomInTx(
    transaction: Transaction,
    input: {
      readonly roomId: string;
      readonly targetHumanActorId: string;
      readonly targetRoomRole: HumanMembershipTargetRoomRole;
    },
  ): Promise<void>;
  removeHumanFromRoomInTx(
    transaction: Transaction,
    input: {
      readonly roomId: string;
      readonly targetHumanActorId: string;
    },
  ): Promise<void>;
  assertHumanRoomStateInTx(
    transaction: Transaction,
    input: {
      readonly roomId: string;
      readonly targetHumanActorId: string;
      readonly present: boolean;
    },
  ): Promise<void>;
}

/**
 * Owns the transaction ordering shared by product membership and crypto
 * membership. The concrete port must bind every callback to the same database
 * transaction; no production route is wired in Wave 7.
 */
export class HumanMembershipAtomicCoordinator<Transaction> {
  constructor(
    private readonly port: HumanMembershipAtomicPort<Transaction>,
  ) {}

  admitRemoval(input: {
    readonly transition: HumanMembershipTransition;
    readonly requestedAt: number;
  }): Promise<HumanMembershipAdmissionResult> {
    assertVerifiedHumanMembershipTransition(input.transition);
    if (input.transition.kind !== "human_remove") {
      throw new TypeError(
        "Atomic Human removal admission requires a removal transition",
      );
    }
    return this.port.transaction(async (transaction) => {
      await this.port.lockRoomInTx(transaction, input.transition.roomId);
      const result = await this.port.admitRemovalCryptoInTx(
        transaction,
        input,
      );
      if (result.status === "admitted") {
        await this.port.removeHumanFromRoomInTx(transaction, {
          roomId: input.transition.roomId,
          targetHumanActorId: input.transition.targetHumanActorId,
        });
      } else if (result.status === "duplicate") {
        await this.port.assertHumanRoomStateInTx(transaction, {
          roomId: input.transition.roomId,
          targetHumanActorId: input.transition.targetHumanActorId,
          present: false,
        });
      }
      return result;
    });
  }

  activate(
    input: HumanMembershipAtomicActivationRequest,
  ): Promise<HumanMembershipAtomicActivationResult> {
    return this.port.transaction(async (transaction) => {
      await this.port.lockRoomInTx(transaction, input.roomId);
      const result = await this.port.activateCryptoInTx(transaction, input);
      if (
        result.status !== "activated"
        && result.status !== "duplicate"
      ) {
        return result;
      }
      if (result.roomId !== input.roomId || result.kind !== input.kind) {
        throw new Error(
          "Human membership activation coordinates changed after Room lock",
        );
      }
      const expectedPresent = result.kind === "human_add";
      if (result.status === "duplicate" || !expectedPresent) {
        await this.port.assertHumanRoomStateInTx(transaction, {
          roomId: result.roomId,
          targetHumanActorId: result.targetHumanActorId,
          present: expectedPresent,
        });
        return result;
      }
      if (result.targetRoomRole === null) {
        throw new Error(
          "Activated Human addition is missing its target Room role",
        );
      }
      await this.port.addHumanToRoomInTx(transaction, {
        roomId: result.roomId,
        targetHumanActorId: result.targetHumanActorId,
        targetRoomRole: result.targetRoomRole,
      });
      return result;
    });
  }
}
