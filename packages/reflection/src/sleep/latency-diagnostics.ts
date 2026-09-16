export const DURABLE_SLEEP_LATENCY_WINDOW_MAXIMUM = 128;

export type DurableSleepLatencyLane = "same_room" | "cross_room";

/**
 * One completed semantic generation with every semantic coordinate removed.
 * Nullable stages mean the process restarted after that durable stage; the
 * end-to-end and queue coordinates remain exact because they are durable.
 */
export interface DurableSleepItemLatencySample {
  readonly lane: DurableSleepLatencyLane;
  readonly queueElapsedMs: number;
  readonly claimStoreElapsedMs: number;
  readonly authorityElapsedMs: number | null;
  readonly searchProjectionElapsedMs: number | null;
  readonly sameRoomCandidateElapsedMs: number;
  readonly crossRoomCandidateElapsedMs: number;
  readonly selectedOpenElapsedMs: number;
  readonly promptConstructionElapsedMs: number;
  readonly promptInputCount: number;
  readonly promptCodePoints: number;
  readonly modelElapsedMs: number;
  readonly modelAttempts: number;
  readonly modelRepairs: number;
  readonly modelFailures: number;
  readonly proposalValidationElapsedMs: number;
  readonly publicationPlanningElapsedMs: number;
  readonly finalAuthorityElapsedMs: number;
  readonly productPublicationElapsedMs: number;
  readonly completionElapsedMs: number;
  readonly recursiveAdmissionElapsedMs: number;
  readonly endToEndElapsedMs: number;
}

export interface DurableSleepLatencyDistribution {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly maximumMs: number;
}

export interface DurableSleepLaneLatencySummary {
  readonly endToEnd: DurableSleepLatencyDistribution;
  readonly queue: DurableSleepLatencyDistribution;
  readonly candidate: DurableSleepLatencyDistribution;
  readonly model: DurableSleepLatencyDistribution;
  readonly publication: DurableSleepLatencyDistribution;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function assertDurableSleepItemLatencySample(
  sample: DurableSleepItemLatencySample,
): void {
  for (const [label, value] of Object.entries(sample)) {
    if (label === "lane" || value === null) continue;
    if (typeof value !== "number") {
      throw new TypeError("Reflection latency samples contain numeric fields only");
    }
    nonNegativeSafeInteger(value, `Reflection latency ${label}`);
  }
  if (sample.lane !== "same_room" && sample.lane !== "cross_room") {
    throw new TypeError("Reflection latency lane is invalid");
  }
  if (sample.modelRepairs > sample.modelAttempts) {
    throw new RangeError("Reflection repair count cannot exceed attempts");
  }
  if (sample.modelAttempts > 2 || sample.modelRepairs > 1) {
    throw new RangeError("Reflection permits one decision attempt and one repair");
  }
  if (sample.queueElapsedMs > sample.endToEndElapsedMs) {
    throw new RangeError("Reflection queue time cannot exceed end-to-end time");
  }
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index]!;
}

function distribution(values: readonly number[]): DurableSleepLatencyDistribution {
  return Object.freeze({
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    maximumMs: values.length === 0 ? 0 : Math.max(...values),
  });
}

function summarize(
  samples: readonly DurableSleepItemLatencySample[],
): DurableSleepLaneLatencySummary {
  return Object.freeze({
    endToEnd: distribution(samples.map((sample) => sample.endToEndElapsedMs)),
    queue: distribution(samples.map((sample) => sample.queueElapsedMs)),
    candidate: distribution(samples.map((sample) =>
      sample.sameRoomCandidateElapsedMs
      + sample.crossRoomCandidateElapsedMs
      + sample.selectedOpenElapsedMs)),
    model: distribution(samples.map((sample) => sample.modelElapsedMs)),
    publication: distribution(samples.map((sample) =>
      sample.proposalValidationElapsedMs
      + sample.publicationPlanningElapsedMs
      + sample.finalAuthorityElapsedMs
      + sample.productPublicationElapsedMs
      + sample.completionElapsedMs
      + sample.recursiveAdmissionElapsedMs)),
  });
}

/** Bounded process-local numeric window. Restart intentionally resets it. */
export class DurableSleepLatencyWindow {
  readonly #samples: DurableSleepItemLatencySample[] = [];

  constructor(readonly capacity = DURABLE_SLEEP_LATENCY_WINDOW_MAXIMUM) {
    if (
      !Number.isSafeInteger(capacity)
      || capacity < 1
      || capacity > DURABLE_SLEEP_LATENCY_WINDOW_MAXIMUM
    ) {
      throw new RangeError(
        `Reflection latency window capacity must be 1..${DURABLE_SLEEP_LATENCY_WINDOW_MAXIMUM}`,
      );
    }
  }

  add(samples: readonly DurableSleepItemLatencySample[]): void {
    for (const sample of samples) {
      assertDurableSleepItemLatencySample(sample);
      this.#samples.push(Object.freeze({ ...sample }));
      if (this.#samples.length > this.capacity) this.#samples.shift();
    }
  }

  clear(): void {
    this.#samples.splice(0);
  }

  snapshot(): Readonly<{
    sameRoom: DurableSleepLaneLatencySummary;
    crossRoom: DurableSleepLaneLatencySummary;
  }> {
    return Object.freeze({
      sameRoom: summarize(this.#samples.filter((sample) => sample.lane === "same_room")),
      crossRoom: summarize(this.#samples.filter((sample) => sample.lane === "cross_room")),
    });
  }
}
