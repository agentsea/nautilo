import {
  discardOwnedAvatarStaging,
  discardExpiredOwnedAvatarArtifacts,
  discardPublishedOwnedAvatarAfterNoCommit,
  publishStagedOwnedAvatar,
  stageOwnedAvatar,
  type OwnedAvatarKind,
  type StagedOwnedAvatar,
} from "../photo-library/owned-avatar-staging";
import {
  type AgentPhotoCreateCommitState,
  type ExpiredAgentPhotoCreateReservation,
  type AgentPhotoCreateFinalizeInput,
  type AgentPhotoCreateFailureInput,
  type AgentPhotoCreateReservation,
  type AgentPhotoCreateReservationOutcome,
  type AgentPhotoCreateReservationInput,
  type AgentPhotoCreateResult,
  type AgentPhotoCreateSemantic,
  type AgentPhotoCreateTransactionContext,
} from "./agent-photo-library-service";

/** Minimal public service boundary; makes ambiguous-commit recovery testable. */
export interface AgentPhotoLibraryCreateService {
  reserveCreate(input: AgentPhotoCreateReservationInput): Promise<AgentPhotoCreateReservationOutcome>;
  finalizeCreate(
    input: AgentPhotoCreateFinalizeInput,
    promoteStaged: () => Promise<void>,
    afterCreateInTransaction?: (
      context: AgentPhotoCreateTransactionContext,
    ) => Promise<void>,
  ): Promise<AgentPhotoCreateResult>;
  failCreate(input: AgentPhotoCreateFailureInput): Promise<boolean>;
  inspectCreateCommitState(input: {
    readonly authority: AgentPhotoCreateReservationInput["authority"];
    readonly operationId: string;
    readonly leaseToken: string;
  }): Promise<AgentPhotoCreateCommitState>;
  reapExpiredCreateReservations(input: {
    readonly authority: AgentPhotoCreateReservationInput["authority"];
    readonly limit?: number;
  }): Promise<readonly ExpiredAgentPhotoCreateReservation[]>;
  markExpiredCreateArtifactCleanupComplete(input: {
    readonly authority: AgentPhotoCreateReservationInput["authority"];
    readonly operationId: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
}

export interface AgentPhotoCreateCandidateBytes {
  readonly kind: OwnedAvatarKind;
  /** Normalized server-produced bytes, never a client path or provider key. */
  readonly bytes: Buffer;
}

export interface AgentPhotoCreateProducerContext {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly expiresAt: Date;
  readonly signal: AbortSignal;
}

export interface AgentPhotoCreateCoordinatorInput extends AgentPhotoCreateReservationInput {
  /**
   * Invoked only after durable capacity is reserved. It represents the
   * existing server-owned provider/upload normalization path—not a client
   * supplied array of already materialized provider candidates.
   */
  readonly produceCandidates: (
    context: AgentPhotoCreateProducerContext,
  ) => Promise<readonly AgentPhotoCreateCandidateBytes[]>;
}

function generationFor(semantic: AgentPhotoCreateSemantic, ordinal: number) {
  if (semantic.avatarKind !== "generated") return undefined;
  if (!semantic.provider || !semantic.model || semantic.batchOrdinal !== ordinal) {
    throw new Error("generated candidate did not carry server-selected provenance");
  }
  return semantic.prompt === undefined
    ? { provider: semantic.provider, model: semantic.model, batchOrdinal: semantic.batchOrdinal }
    : { prompt: semantic.prompt, provider: semantic.provider, model: semantic.model, batchOrdinal: semantic.batchOrdinal };
}

/**
 * The create coordinator is the only place storage crosses the durable
 * reservation boundary. Routes/tools first use their existing server-owned
 * provider and rate/cost policy, then hand normalized bytes here. It neither
 * accepts provider credentials nor makes client-selected paths visible.
 */
export class AgentPhotoLibraryCreateCoordinator {
  readonly #service: AgentPhotoLibraryCreateService;

  constructor(service: AgentPhotoLibraryCreateService) {
    this.#service = service;
  }

  async produceStageAndFinalize(
    input: AgentPhotoCreateCoordinatorInput,
    afterCreateInTransaction?: (
      context: AgentPhotoCreateTransactionContext,
    ) => Promise<void>,
  ): Promise<AgentPhotoCreateResult> {
    await this.reapExpiredReservations(input.authority);
    const reservation = await this.#service.reserveCreate(input);
    if ("operation" in reservation) return reservation;
    const staged: StagedOwnedAvatar[] = [];
    let publishAttempted = false;
    try {
      const candidates = await this.#produceBeforeLeaseExpires(input, reservation);
      if (candidates.length !== input.slotCount || candidates.length !== input.semantics.length) {
        throw new Error("photo creation producer did not return the reserved batch");
      }
      for (const [ordinal, candidate] of candidates.entries()) {
        const semantic = input.semantics[ordinal];
        if (!semantic || semantic.avatarKind !== candidate.kind) {
          throw new Error("photo creation candidate does not match its reservation semantics");
        }
        staged.push(await stageOwnedAvatar({
          scope: input.authority,
          operationId: input.operationId,
          leaseToken: reservation.leaseToken,
          ordinal,
          kind: candidate.kind,
          bytes: candidate.bytes,
        }));
      }
      const result = await this.#service.finalizeCreate({
        authority: input.authority,
        operationId: input.operationId,
        leaseToken: reservation.leaseToken,
        source: input.source,
        origin: input.origin,
        semantics: input.semantics,
        entries: staged.map((candidate) => {
          const generation = generationFor(input.semantics[candidate.ordinal]!, candidate.ordinal);
          return generation
            ? {
                ordinal: candidate.ordinal,
                blobId: candidate.blobId,
                avatarKind: candidate.kind,
                mediaByteSize: candidate.byteSize,
                mediaSha256: candidate.sha256,
                mediaMimeType: "image/png" as const,
                generation,
              }
            : {
                ordinal: candidate.ordinal,
                blobId: candidate.blobId,
                avatarKind: candidate.kind,
                mediaByteSize: candidate.byteSize,
                mediaSha256: candidate.sha256,
                mediaMimeType: "image/png" as const,
              };
        }),
      }, async () => {
        publishAttempted = true;
        // This runs under the service's profile->operation locked pending
        // lease check. A partial generated original/thumb promotion throws;
        // the coordinator's durable recovery path then reconciles it.
        for (const candidate of staged) await publishStagedOwnedAvatar(candidate);
      }, afterCreateInTransaction);
      await Promise.all(staged.map(discardOwnedAvatarStaging));
      return result;
    } catch (error) {
      // Staging is never public, so it is safe to clean whether or not the DB
      // can be reached. Finals demand a durable re-read before cleanup.
      await Promise.all(staged.map(discardOwnedAvatarStaging));
      if (!publishAttempted) {
        await this.#bestEffortRecordFailure(input, reservation.leaseToken);
        throw error;
      }

      try {
        const state = await this.#service.inspectCreateCommitState({
          authority: input.authority,
          operationId: input.operationId,
          leaseToken: reservation.leaseToken,
        });
        if (state.kind === "committed") {
          // The transaction committed but its response was lost. Return its
          // receipt instead of re-running provider/storage work.
          return state.value;
        }
        if (state.kind === "not_committed") {
          // The read is the proof attached to each cleanup call. Only after
          // that proof may this worker terminally fail its own lease and
          // remove the known deterministic finals.
          const failed = await this.#service.failCreate({
            authority: input.authority,
            operationId: input.operationId,
            leaseToken: reservation.leaseToken,
            error: {
              code: "photo_library_unavailable",
              message: "Photo creation did not commit",
              retryable: true,
            },
          });
          if (failed) {
            await Promise.all(staged.map((candidate) => discardPublishedOwnedAvatarAfterNoCommit(candidate, {
              kind: "confirmed_no_committed_owned_rows",
              operationId: input.operationId,
              leaseToken: reservation.leaseToken,
            })));
            const marked = await this.#service.markExpiredCreateArtifactCleanupComplete({
              authority: input.authority,
              operationId: input.operationId,
              leaseToken: reservation.leaseToken,
            });
            if (!marked) throw new Error("photo artifact compensation receipt could not be marked");
          }
        }
        // A terminal failure has no fresh no-rows proof. Leave its finals
        // quarantined for reconciliation rather than guessing they are ours.
      } catch {
        // An unavailable/ambiguous database state is explicitly not cleanup
        // permission. Finals remain unreachable without an owned DB row.
      }
      throw error;
    }
  }

  /** Recovery is bounded and cleanup follows the service's terminal DB proof. */
  async reapExpiredReservations(authority: AgentPhotoCreateReservationInput["authority"]): Promise<number> {
    const expired = await this.#service.reapExpiredCreateReservations({ authority, limit: 16 });
    await Promise.all(expired.map(async (reservation) => {
      await discardExpiredOwnedAvatarArtifacts({
        scope: authority,
        operationId: reservation.operationId,
        leaseToken: reservation.leaseToken,
        slotCount: reservation.slotCount,
        proof: {
          kind: "confirmed_no_committed_owned_rows",
          operationId: reservation.operationId,
          leaseToken: reservation.leaseToken,
        },
      });
      const marked = await this.#service.markExpiredCreateArtifactCleanupComplete({
        authority,
        operationId: reservation.operationId,
        leaseToken: reservation.leaseToken,
      });
      if (!marked) throw new Error("expired photo artifact cleanup receipt could not be marked");
    }));
    return expired.length;
  }

  async #produceBeforeLeaseExpires(
    input: AgentPhotoCreateCoordinatorInput,
    reservation: AgentPhotoCreateReservation,
  ): Promise<readonly AgentPhotoCreateCandidateBytes[]> {
    const remaining = reservation.expiresAt.getTime() - Date.now() - 1_000;
    // Provider work is always bounded below the durable lease; no indefinite
    // request can keep a reservation live simply by never resolving.
    const timeoutMs = Math.min(10 * 60_000, remaining);
    if (timeoutMs < 1_000) throw new Error("photo creation reservation is too close to expiry");
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timed = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("photo creation producer timed out before its lease expired"));
        }, timeoutMs);
      });
      return await Promise.race([
        input.produceCandidates({
          operationId: input.operationId,
          leaseToken: reservation.leaseToken,
          expiresAt: reservation.expiresAt,
          signal: controller.signal,
        }),
        timed,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
  }

  async #bestEffortRecordFailure(input: AgentPhotoCreateCoordinatorInput, leaseToken: string): Promise<void> {
    try {
      await this.#service.failCreate({
        authority: input.authority,
        operationId: input.operationId,
        leaseToken,
        error: {
          code: "photo_library_unavailable",
          message: "Photo creation bytes could not be staged",
          retryable: true,
        },
      });
    } catch {
      // The token-scoped staging has already been removed; lease recovery will
      // terminally expire the pending row without exposing any bytes.
    }
  }
}
