export type RevokeMemoryOutcome = {
  reHomed: number;
  skipped: string[];
};

export type MakeMemoryPrivateOutcome = {
  skipped: string[];
};

export function formatRevokeMemoryOutcome(result: RevokeMemoryOutcome): string {
  const details = [
    result.reHomed
      ? `${result.reHomed} access path${result.reHomed === 1 ? "" : "s"} re-homed.`
      : null,
    result.skipped.length ? `Not changed: ${result.skipped.join(", ")}.` : null,
  ].filter((detail): detail is string => detail !== null);
  return details.length ? details.join(" ") : "Access removed.";
}

/**
 * A skipped namespace means the server could not remove every other access
 * path, so never describe that result as an absolute private transition.
 */
export function formatMakeMemoryPrivateOutcome(result: MakeMemoryPrivateOutcome): string {
  return result.skipped.length
    ? `Private access was added. Other access was not changed for: ${result.skipped.join(", ")}.`
    : "This memory is now private.";
}
