import { randomBytes } from "node:crypto";

import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";
import {
  RECORD_SEARCH_POLICY_V1,
  type EligibleHierarchyCoordinatePort,
} from "@nautilo/reflection/search";

import type { ProjectedAuthorityEligibility } from "./authority-eligibility";
import type { RecordRepositoryPort } from "./contracts";
import type {
  RecordEvidenceTraversalCheckpoint,
  RecordEvidenceTraversalCheckpointPort,
  RecordSearchTraversalCheckpoint,
  RecordSearchTraversalCheckpointPort,
} from "./record-search-composition";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MILLISECONDS = 5 * 60 * 1_000;

interface Stored<Value> {
  readonly value: Value;
  readonly expiresAt: number;
}

class BoundedExpiringMap<Value> {
  private readonly values = new Map<string, Stored<Value>>();

  constructor(
    private readonly maximumEntries = DEFAULT_MAX_ENTRIES,
    private readonly ttlMilliseconds = DEFAULT_TTL_MILLISECONDS,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("Record checkpoint capacity must be positive");
    }
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1) {
      throw new RangeError("Record checkpoint TTL must be positive");
    }
  }

  get(key: string): Value | null {
    this.prune();
    const stored = this.values.get(key);
    if (stored === undefined) return null;
    this.values.delete(key);
    this.values.set(key, stored);
    return stored.value;
  }

  set(key: string, value: Value): void {
    this.prune();
    this.values.delete(key);
    while (this.values.size >= this.maximumEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    this.values.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMilliseconds,
    });
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, stored] of this.values) {
      if (stored.expiresAt <= now) this.values.delete(key);
    }
  }
}

/** Process-local only; authenticated continuations fail stale after restart. */
export class BoundedRecordSearchTraversalCheckpoints
implements RecordSearchTraversalCheckpointPort {
  private readonly values: BoundedExpiringMap<RecordSearchTraversalCheckpoint>;

  constructor(input: Readonly<{
    maximumEntries?: number;
    ttlMilliseconds?: number;
  }> = {}) {
    this.values = new BoundedExpiringMap(
      input.maximumEntries,
      input.ttlMilliseconds,
    );
  }

  load(ref: string): Promise<RecordSearchTraversalCheckpoint | null> {
    return Promise.resolve(this.values.get(ref));
  }

  save(ref: string, checkpoint: RecordSearchTraversalCheckpoint): Promise<void> {
    this.values.set(ref, checkpoint);
    return Promise.resolve();
  }

  remove(ref: string): Promise<void> {
    this.values.delete(ref);
    return Promise.resolve();
  }
}

/** Process-local sensitive traversal state; only a sealed opaque ref leaves. */
export class BoundedRecordEvidenceTraversalCheckpoints
implements RecordEvidenceTraversalCheckpointPort {
  private readonly values: BoundedExpiringMap<RecordEvidenceTraversalCheckpoint>;

  constructor(input: Readonly<{
    maximumEntries?: number;
    ttlMilliseconds?: number;
  }> = {}) {
    this.values = new BoundedExpiringMap(
      input.maximumEntries,
      input.ttlMilliseconds,
    );
  }

  save(checkpoint: RecordEvidenceTraversalCheckpoint): Promise<string> {
    const ref = randomBytes(32).toString("base64url");
    this.values.set(ref, checkpoint);
    return Promise.resolve(ref);
  }

  load(ref: string): Promise<RecordEvidenceTraversalCheckpoint | null> {
    return Promise.resolve(this.values.get(ref));
  }

  remove(ref: string): Promise<void> {
    this.values.delete(ref);
    return Promise.resolve();
  }
}

/** Invocation-bound graph view used only after the exact search authority gate. */
export class InvocationEligibleHierarchyCoordinates
implements EligibleHierarchyCoordinatePort {
  constructor(private readonly ports: Readonly<{
    repository: RecordRepositoryPort;
    eligibility: ProjectedAuthorityEligibility;
    invocationAudience: EffectiveAudienceAlternative;
    readBindingRef: string;
  }>) {}

  async isEligible(recordRef: string): Promise<boolean> {
    return (await this.ports.eligibility.check({
      recordRef,
      invocationAudience: this.ports.invocationAudience,
    })).status === "eligible";
  }

  async childrenOf(input: Parameters<EligibleHierarchyCoordinatePort["childrenOf"]>[0]) {
    const page = await this.ports.repository.readDependencies({
      recordRef: input.recordRef,
      readBindingRef: this.ports.readBindingRef,
      limit: Math.min(input.limit, RECORD_SEARCH_POLICY_V1.graphPageMaximum),
      ...(input.continuation === undefined
        ? {}
        : { continuation: input.continuation }),
    });
    if (page.status !== "available") return { recordRefs: [] };
    const visible: string[] = [];
    for (const recordRef of page.page.items) {
      if (await this.isEligible(recordRef)) visible.push(recordRef);
    }
    // RecordPayloadV1 currently caps direct children below one graph page. If
    // that codec grows, this adapter must gain hidden-page draining before it
    // can forward a continuation with an empty visible page.
    if (page.page.continuation !== undefined && visible.length === 0) {
      throw new TypeError("hidden Record child page cannot make visible progress");
    }
    return {
      recordRefs: visible,
      ...(page.page.continuation === undefined
        ? {}
        : { continuation: page.page.continuation }),
    };
  }
}
