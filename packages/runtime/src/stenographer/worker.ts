import { randomUUID } from "node:crypto";
import { getSharedDirectDb } from "@nautilo/db";
import { error as logError, log, warn } from "@nautilo/logger";
import type {
  StenographerDataOperationPort,
  StenographerOperationOutcome,
} from "@nautilo/lattice-bridge/server";

import {
  BackgroundAttemptCancelledError,
  BackgroundAttemptUnavailableError,
  runBackgroundAttempt,
  type BackgroundAccessSession,
  type BackgroundAttemptIdentity,
  type BackgroundAttemptObservation,
} from "../background-processing/attempt";
import type { MaintenanceGate } from "../maintenance-controller";
import {
  candidateRoomIds,
  compactionCandidateRooms,
  historicalCandidateRoomIds,
  initializeHistoricalBackfills,
} from "./repository";

export interface StenographerCandidatePort {
  extraction(input: Readonly<{
    lane: "live" | "historical";
    now: Date;
  }>): Promise<readonly string[]>;
  initializeHistorical(input: Readonly<{ now: Date }>): Promise<void>;
  compaction(input: Readonly<{ now: Date }>): Promise<readonly string[]>;
}

export interface StenographerWorkerDeps {
  maintenanceGate: Pick<MaintenanceGate, "isAcceptingWork">;
  resolveModelId: () => string;
  operations: StenographerDataOperationPort;
  /** Metadata-only discovery; confidential claim loading belongs to operations. */
  candidates?: StenographerCandidatePort;
  /** Open before a selected intent can claim or load any source body. */
  openAccess?: (
    identity: BackgroundAttemptIdentity,
    signal: AbortSignal,
  ) => Promise<BackgroundAccessSession>;
  now?: () => Date;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface StenographerWorkerOptions {
  scanIntervalMs?: number;
  shutdownWaitMs?: number;
}

const unavailable = (): StenographerOperationOutcome =>
  Object.freeze({ status: "unavailable", processed: false });

function observationOutcome(
  result: StenographerOperationOutcome,
): BackgroundAttemptObservation["outcome"] {
  switch (result.status) {
    case "completed":
    case "prepared_rebuild":
      return "completed";
    case "waiting":
    case "unavailable":
      return "unavailable";
    case "failed":
    case "cancelled":
      return result.status;
  }
}

function defaultCandidates(): StenographerCandidatePort {
  return Object.freeze({
    extraction: async ({ lane, now }: {
      lane: "live" | "historical";
      now: Date;
    }) => {
      const db = getSharedDirectDb();
      return lane === "live"
        ? candidateRoomIds(db, now)
        : historicalCandidateRoomIds(db, now);
    },
    initializeHistorical: ({ now }: { now: Date }) =>
      initializeHistoricalBackfills({ db: getSharedDirectDb(), now }),
    compaction: async ({ now }: { now: Date }) =>
      (await compactionCandidateRooms(getSharedDirectDb(), now))
        .map(({ roomId }) => roomId),
  });
}

/**
 * Server-owned, durable polling shell. It handles only metadata discovery,
 * scheduling and the M319 attempt lifetime; the Lattice operation owns every
 * claim, body, model and publication call.
 */
export class StenographerWorker {
  private readonly scanIntervalMs: number;
  private readonly shutdownWaitMs: number;
  private readonly candidates: StenographerCandidatePort;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private activeController: AbortController | null = null;
  private readonly logger: NonNullable<StenographerWorkerDeps["logger"]>;

  constructor(
    private readonly deps: StenographerWorkerDeps,
    opts: StenographerWorkerOptions = {},
  ) {
    this.scanIntervalMs = opts.scanIntervalMs ?? 15_000;
    this.shutdownWaitMs = opts.shutdownWaitMs ?? 10_000;
    this.candidates = deps.candidates ?? defaultCandidates();
    const logger = deps.logger ?? {
      info: (message: string, fields?: Record<string, unknown>) =>
        log(message, fields),
      warn: (message: string, fields?: Record<string, unknown>) =>
        warn(message, fields),
      error: (message: string, fields?: Record<string, unknown>) =>
        logError(message, fields),
    };
    this.logger = {
      info: (message, fields) => {
        try { logger.info(message, fields); } catch { /* diagnostic only */ }
      },
      warn: (message, fields) => {
        try { logger.warn(message, fields); } catch { /* diagnostic only */ }
      },
      error: (message, fields) => {
        try { logger.error(message, fields); } catch { /* diagnostic only */ }
      },
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.poll(), this.scanIntervalMs);
    this.timer.unref?.();
    this.poll();
  }

  poll(): void {
    if (this.stopped || this.inFlight) return;
    const run = this.runOnce()
      .catch((error) => {
        this.logger.error(
          `[stenographer] poll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  private async runOnce(): Promise<void> {
    if (this.stopped) return;
    if (!(await this.deps.maintenanceGate.isAcceptingWork())) return;
    const now = (this.deps.now ?? (() => new Date()))();
    const controller = new AbortController();
    this.activeController = controller;
    try {
      // Repair shares the poll and cannot monopolize the extraction schedule.
      if (this.deps.operations.runNextOutputRepair !== undefined) {
        await this.runIntent("next-output-repair", "output-repair",
          attempt => this.deps.operations.runNextOutputRepair!({now, attempt}), controller.signal);
      }
      const rebuild = await this.runIntent(
        "next-rebuild",
        "rebuild",
        (attempt) => this.deps.operations.runNextRebuild({ now, attempt }),
        controller.signal,
      );
      if (rebuild.status === "prepared_rebuild") {
        const extraction = await this.runIntent(
          rebuild.roomId,
          "rebuild",
          (attempt) => this.deps.operations.runExtraction({
            roomId: rebuild.roomId,
            lane: "rebuild",
            modelId: this.deps.resolveModelId(),
            now,
            attempt,
          }),
          controller.signal,
        );
        if (extraction.processed && extraction.status !== "waiting") return;
      } else if (rebuild.processed && rebuild.status !== "waiting") return;

      if (await this.runExtractionLane("live", now, controller.signal)) return;

      await this.candidates.initializeHistorical({ now });
      if (
        await this.runExtractionLane("historical", now, controller.signal)
        || this.stopped
      ) return;

      const conversion = await this.runIntent(
        "legacy-conversion",
        "conversion",
        (attempt) => this.deps.operations.runLegacyConversion({ now, attempt }),
        controller.signal,
      );
      if (conversion.processed && conversion.status !== "waiting") return;

      for (const roomId of await this.candidates.compaction({ now })) {
        const result = await this.runIntent(
          roomId,
          "compaction",
          (attempt) => this.deps.operations.runCompaction({
            roomId,
            modelId: this.deps.resolveModelId(),
            now,
            attempt,
          }),
          controller.signal,
        );
        if (result.processed && result.status !== "waiting") return;
      }
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private async runExtractionLane(
    lane: "live" | "historical",
    now: Date,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (const roomId of await this.candidates.extraction({ lane, now })) {
      const result = await this.runIntent(
        roomId,
        lane === "live" ? "extraction" : "historical",
        (attempt) => this.deps.operations.runExtraction({
          roomId,
          lane,
          modelId: this.deps.resolveModelId(),
          now,
          attempt,
        }),
        signal,
      );
      if (result.processed && result.status !== "waiting") return true;
    }
    return false;
  }

  private async runIntent(
    workId: string,
    stage: string,
    run: (
      attempt: Parameters<
        StenographerDataOperationPort["runNextRebuild"]
      >[0]["attempt"],
    ) => Promise<StenographerOperationOutcome>,
    signal: AbortSignal,
  ): Promise<StenographerOperationOutcome> {
    try {
      return await runBackgroundAttempt<StenographerOperationOutcome>({
        identity: {
          family: "stenographer",
          stage,
          workId,
          attemptId: randomUUID(),
        },
        signal,
        observe: (observation) => {
          this.logger.info("[stenographer] background attempt closed", {
            ...observation,
          });
        },
        checkAvailable: () => this.deps.maintenanceGate.isAcceptingWork(),
        openAccess: this.deps.openAccess ?? (() => Promise.resolve({
          assertCurrent: async () => {
            if (!(await this.deps.maintenanceGate.isAcceptingWork())) {
              throw new BackgroundAttemptUnavailableError();
            }
          },
          close: () => Promise.resolve(),
        })),
        classifyResult: observationOutcome,
        run,
      });
    } catch (error) {
      if (error instanceof BackgroundAttemptUnavailableError) {
        return unavailable();
      }
      if (signal.aborted || error instanceof BackgroundAttemptCancelledError) throw error;
      // The attempt already closed as failed. Leave durable recovery to Lattice
      // and continue scheduling other intents without replaying this operation.
      this.logger.error("[stenographer] intent failed; continuing other work", {
        workId,
        stage,
      });
      return unavailable();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const active = this.inFlight;
    if (!active) return;
    const controller = this.activeController;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            controller?.abort();
            resolve();
          }, this.shutdownWaitMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
