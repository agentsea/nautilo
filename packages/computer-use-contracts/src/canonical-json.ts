/**
 * Semantics-free canonical JSON for signed Computer Use catalogue arguments.
 * This lives below both Agent and Host protocol so neither imports the other
 * merely to obtain deterministic argument identity.
 */
export type ComputerUseJson = null | boolean | number | string | readonly ComputerUseJson[] | { readonly [key: string]: ComputerUseJson };

function invalid(): never { throw new TypeError("invalid computer use JSON"); }
function scalar(value: unknown): null | boolean | number | string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") invalid();
  return undefined;
}

/** Validate, detach, and lexically order object keys without a hidden depth limit. */
export function canonicalizeComputerUseJson(value: unknown): ComputerUseJson {
  const rootScalar = scalar(value);
  if (rootScalar !== undefined) return rootScalar;
  type Container = Record<string, ComputerUseJson> | ComputerUseJson[];
  type Pending = Readonly<{ source: object; target: Container }>;
  const root = value as object;
  const output: Container = Array.isArray(root) ? [] : Object.create(null) as Record<string, ComputerUseJson>;
  const seen = new WeakSet<object>();
  seen.add(root);
  const pending: Pending[] = [{ source: root, target: output }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (Object.getOwnPropertySymbols(current.source).length !== 0) invalid();
    const entries: [string, unknown][] = Array.isArray(current.source)
      ? (() => {
          const input = current.source as unknown[];
          const keys = Object.keys(input);
          if (keys.length !== input.length || keys.some((key, index) => key !== String(index))) invalid();
          return keys.map((key) => [key, input[Number(key)]!]);
        })()
      : Object.entries(current.source as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (const [key, item] of entries) {
      const childScalar = scalar(item);
      if (childScalar !== undefined) { (current.target as Record<string, ComputerUseJson>)[key] = childScalar; continue; }
      const child = item as object;
      if (seen.has(child)) invalid();
      seen.add(child);
      const target: Container = Array.isArray(child) ? [] : Object.create(null) as Record<string, ComputerUseJson>;
      (current.target as Record<string, ComputerUseJson>)[key] = target;
      pending.push({ source: child, target });
    }
  }
  return output;
}
