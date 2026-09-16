import type { ChartValueAxis } from "./element";

/** Return why an explicit value-axis cannot be represented, if invalid. */
export function chartValueAxisError(
  axis: ChartValueAxis | undefined,
): string | undefined {
  if (!axis) return undefined;
  if (
    (axis.min !== undefined && !Number.isFinite(axis.min)) ||
    (axis.max !== undefined && !Number.isFinite(axis.max)) ||
    (axis.crossAt !== undefined && !Number.isFinite(axis.crossAt))
  ) {
    return "value-axis settings must be finite";
  }
  if (
    axis.min !== undefined &&
    axis.max !== undefined &&
    axis.min >= axis.max
  ) {
    return "value-axis minimum must be less than maximum";
  }
  if (axis.min === Number.MAX_VALUE && axis.max === undefined) {
    return "value-axis minimum leaves no distinct finite automatic maximum";
  }
  if (axis.max === -Number.MAX_VALUE && axis.min === undefined) {
    return "value-axis maximum leaves no distinct finite automatic minimum";
  }
  if (axis.crosses && !["autoZero", "min", "max"].includes(axis.crosses)) {
    return "unsupported value-axis crossing";
  }
  return undefined;
}
