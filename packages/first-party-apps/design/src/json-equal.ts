/** Iterative JSON-like equality that terminates for cyclic object graphs. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  const compared = new WeakMap<object, WeakSet<object>>();
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
    const seen = compared.get(a);
    if (seen?.has(b)) continue;
    if (seen) seen.add(b); else compared.set(a, new WeakSet([b]));
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const key of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      pending.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
    }
  }
  return true;
}
