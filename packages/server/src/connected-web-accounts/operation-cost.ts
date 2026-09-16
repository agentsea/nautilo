import type { ConnectedWebOperation } from "./store";

/** Parse non-negative USD with conservative micro-dollar rounding. */
function providerUsdMicros(value: string | null): number | null {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value)) return value === null ? 0 : null;
  const [whole, fraction = ""] = value.split(".");
  if (whole === undefined) return null;
  const wholeMicros = BigInt(whole) * 1_000_000n;
  const microDigits = `${fraction.slice(0, 6)}000000`.slice(0, 6);
  let micros = wholeMicros + BigInt(microDigits);
  if (fraction.slice(6).split("").some((digit) => digit !== "0")) micros += 1n;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

export function connectedWebRunCost(input: {
  readonly operation: Pick<ConnectedWebOperation, "cumulativeCostUsdMicros" | "remainingBudgetUsdMicros">;
  readonly result: { readonly totalCostUsd: string | null };
}): { readonly cumulative: number; readonly remaining: number; readonly exceeded: boolean; readonly known: boolean } | null {
  const reported = providerUsdMicros(input.result.totalCostUsd);
  const totalAuthorized = input.operation.cumulativeCostUsdMicros + input.operation.remainingBudgetUsdMicros;
  if (!Number.isSafeInteger(totalAuthorized)) return null;
  if (input.result.totalCostUsd === null) {
    // A terminal provider result with no total is still terminal truth. Spend
    // the remaining continuation authority rather than pretending it cost $0.
    return { cumulative: totalAuthorized, remaining: 0, exceeded: false, known: false };
  }
  if (reported === null) return null;
  if (reported > input.operation.remainingBudgetUsdMicros) {
    return { cumulative: totalAuthorized, remaining: 0, exceeded: true, known: true };
  }
  return {
    cumulative: input.operation.cumulativeCostUsdMicros + reported,
    remaining: input.operation.remainingBudgetUsdMicros - reported,
    exceeded: false,
    known: true,
  };
}
