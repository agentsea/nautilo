/** Search coordinates refer to the host's combined, sanitized UTF-8 stream. */
export interface LocalExecutionSearchProgress {
  readonly matchedAt: number | null;
  readonly nextSearchCursor: number;
  /** Exhausted the retained suffix at observed produced, and execution settled.
   * A gap still means the discarded prefix was not searched. */
  readonly complete: boolean;
  readonly gap: boolean;
  readonly availableFrom: number;
  readonly produced: number;
}

/** Finds one literal occurrence without copying or retaining the output window.
 * Continue with the same literal and returned cursor. On a hit, advancing one
 * code point permits overlapping matches without returning the same match.
 * On an open miss, retain candidate starts for a match crossing a later append. */
export function searchLocalExecutionOutput(input: {
  readonly output: Buffer;
  readonly produced: number;
  readonly cursor: number;
  readonly literal: string;
  readonly settled: boolean;
}): LocalExecutionSearchProgress {
  const { output, produced, cursor, literal, settled } = input;
  if (!Number.isSafeInteger(produced) || produced < output.length ||
      !Number.isSafeInteger(cursor) || cursor < 0 || cursor > produced ||
      typeof literal !== "string" || literal.length === 0) {
    throw new Error("LOCAL_EXECUTION_SEARCH_INVALID");
  }
  const needle = Buffer.from(literal, "utf8");
  if (needle.toString("utf8") !== literal) throw new Error("LOCAL_EXECUTION_SEARCH_INVALID");
  const availableFrom = produced - output.length;
  const from = Math.max(cursor, availableFrom);
  const localFrom = from - availableFrom;
  if (localFrom < output.length && (output[localFrom]! & 0xc0) === 0x80) {
    throw new Error("LOCAL_EXECUTION_CURSOR_INVALID");
  }
  const index = output.indexOf(needle, localFrom);
  let next = index < 0
    ? settled ? produced : Math.max(from, produced - (needle.length - 1))
    : availableFrom + index + 1;
  // All candidate positions are character boundaries. Rounding forward cannot
  // skip an unsearched start: earlier complete candidates were already tested.
  while (next < produced && (output[next - availableFrom]! & 0xc0) === 0x80) next += 1;
  return {
    matchedAt: index < 0 ? null : availableFrom + index,
    nextSearchCursor: next,
    complete: settled && index < 0,
    gap: cursor < availableFrom,
    availableFrom,
    produced,
  };
}
