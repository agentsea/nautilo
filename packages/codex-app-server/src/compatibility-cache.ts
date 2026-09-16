import {
  isVerifiedProtocolObservation,
  type VerifiedProtocolObservation,
} from "./compatibility-contract";

export type CompatibilityCacheKey = VerifiedProtocolObservation;

function pairKey(key: CompatibilityCacheKey): string {
  if (!isVerifiedProtocolObservation(key)) {
    throw new TypeError("compatibility evidence is not verified");
  }
  return JSON.stringify([
    key.executable?.fingerprint ?? null,
    key.schemaFingerprint,
  ]);
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  if (clone === null || typeof clone !== "object") return clone;
  const work: object[] = [clone as object];
  const seen = new Set<object>();
  while (work.length > 0) {
    const current = work.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") work.push(child as object);
    }
    Object.freeze(current);
  }
  return clone;
}

export class CompatibilityCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(readonly capacity = 32) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("compatibility cache capacity must be positive");
    }
  }

  get(key: CompatibilityCacheKey): T | undefined {
    const encoded = pairKey(key);
    const stored = this.entries.get(encoded);
    if (stored === undefined) return undefined;
    this.entries.delete(encoded);
    this.entries.set(encoded, stored);
    return cloneAndFreeze(stored);
  }

  set(key: CompatibilityCacheKey, value: T): T {
    const encoded = pairKey(key);
    const stored = cloneAndFreeze(value);
    this.entries.delete(encoded);
    this.entries.set(encoded, stored);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return cloneAndFreeze(stored);
  }

  getOrCompute(key: CompatibilityCacheKey, compute: () => T): T {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    return this.set(key, compute());
  }

  get size(): number {
    return this.entries.size;
  }
}
