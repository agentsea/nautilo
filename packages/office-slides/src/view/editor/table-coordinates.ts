/** Next representable finite number greater than `value`. */
function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  const bits = new BigUint64Array(1);
  const floats = new Float64Array(bits.buffer);
  floats[0] = value;
  bits[0] += value > 0 ? 1n : -1n;
  return floats[0];
}

/** Next representable finite number less than `value`. */
function nextDown(value: number): number {
  if (Number.isNaN(value) || value === -Infinity) return value;
  if (value === 0) return -Number.MIN_VALUE;
  const bits = new BigUint64Array(1);
  const floats = new Float64Array(bits.buffer);
  floats[0] = value;
  bits[0] += value > 0 ? -1n : 1n;
  return floats[0];
}

/**
 * Keep a resize boundary strictly inside its adjacent pair without imposing
 * a document-size policy. If no representable interior exists, retain the
 * original boundary instead of changing imported geometry.
 */
export function clampInsidePair(
  proposed: number,
  pairStart: number,
  pairEnd: number,
  original: number,
): number {
  const min = nextUp(pairStart);
  const max = nextDown(pairEnd);
  return min <= max ? Math.max(min, Math.min(max, proposed)) : original;
}

/** Map an outside pointer to the midpoint of the terminal painted interval. */
export function projectIntoBoundaryIntervals(
  value: number,
  boundaries: readonly number[],
): number {
  if (boundaries.length < 2) return value;
  const first = boundaries[0];
  const last = boundaries[boundaries.length - 1];
  if (value < first) return first + (boundaries[1] - first) / 2;
  if (value >= last) {
    const beforeLast = boundaries[boundaries.length - 2];
    return Math.min(
      nextDown(last),
      beforeLast + (last - beforeLast) / 2,
    );
  }
  return value;
}
