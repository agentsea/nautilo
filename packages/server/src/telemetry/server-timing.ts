import {
  TELEMETRY_STAGES,
  type RequestTelemetryContext,
  type TelemetryStage,
} from "./request-telemetry";

const METRIC_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function isValidMetricDuration(dur: number): boolean {
  return Number.isFinite(dur) && dur >= 0;
}

function metricNameForStage(stage: TelemetryStage): string | null {
  if (!METRIC_NAME_RE.test(stage)) return null;
  return stage;
}

/**
 * Build a syntactically valid `Server-Timing` value from stage durations only.
 * Returns null when no metrics are recorded or any metric would be invalid.
 */
export function formatServerTimingHeader(ctx: RequestTelemetryContext): string | null {
  const parts: string[] = [];

  for (const stage of TELEMETRY_STAGES) {
    const dur = ctx.stageDurationsMs[stage];
    if (dur === undefined) continue;
    if (!isValidMetricDuration(dur)) return null;

    const name = metricNameForStage(stage);
    if (name === null) return null;

    parts.push(`${name};dur=${dur.toFixed(1)}`);
  }

  if (parts.length === 0) return null;

  return parts.join(", ");
}

/** Whether a header value matches the Server-Timing token grammar we emit. */
export function isValidServerTimingHeader(value: string): boolean {
  if (value.length === 0) return false;
  const metrics = value.split(",").map((m) => m.trim());
  if (metrics.some((m) => m.length === 0)) return false;

  for (const metric of metrics) {
    const match = /^([a-zA-Z0-9_-]+);dur=([0-9]+(?:\.[0-9]+)?)$/.exec(metric);
    if (!match) return false;
    const dur = Number.parseFloat(match[2]!);
    if (!Number.isFinite(dur) || dur < 0) return false;
  }

  return true;
}
