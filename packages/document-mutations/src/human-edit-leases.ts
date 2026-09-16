import {
  humanEditLeaseRecordSchema,
  humanEditLeaseSchema,
  type AnchoredTextPatch,
  type DocumentIdentity,
  type DocumentVersion,
  type HumanEditLease,
  type HumanEditLeaseRecord,
  type HumanEditLeaseState,
  type HumanEditLeaseStoreResult,
} from "@nautilo/types";

/** Advisory presence lifetime; deliberately not a document-size/count ceiling. */
export const DEFAULT_HUMAN_EDIT_LEASE_TTL_MS = 45_000;

export interface HumanEditLeaseRegistryOptions {
  /** Registry lifetime only. It is not document authority. */
  readonly ttlMs: number;
  readonly now?: () => number;
  /** Must return a unique, non-empty opaque identifier. */
  readonly newLeaseId: () => string;
}

export interface RegisterHumanEditLeaseInput {
  readonly sessionId: string;
  readonly humanId: string;
  readonly identity: DocumentIdentity;
  readonly baseVersion: DocumentVersion;
  readonly state: HumanEditLeaseState;
  readonly draftPatch?: AnchoredTextPatch;
}

export interface UpdateHumanEditLeaseInput {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly humanId: string;
  readonly expectedGeneration: number;
  readonly baseVersion: DocumentVersion;
  readonly state: HumanEditLeaseState;
  readonly draftPatch?: AnchoredTextPatch;
}

export interface AccessHumanEditLeaseInput {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly humanId: string;
  readonly expectedGeneration: number;
}

function identityKey(identity: DocumentIdentity): string {
  return identity.kind === "workspace_artifact"
    ? `workspace:${identity.artifactId}\u0000${identity.logicalPath}`
    : `local:${identity.relayId}\u0000${identity.canonicalPath}`;
}

function bindingKey(input: {
  readonly humanId: string;
  readonly sessionId: string;
  readonly identity: DocumentIdentity;
}): string {
  return JSON.stringify([
    input.humanId,
    input.sessionId,
    identityKey(input.identity),
  ]);
}

function invalid(reason: string): HumanEditLeaseStoreResult {
  return { status: "invalid", reason };
}

/**
 * Process-local, ephemeral human-edit presence registry.
 *
 * The registry records state that a trusted server adapter has already
 * authorized and canonicalized. A record is never evidence that its holder
 * may read or mutate a document. Every eventual document operation must run
 * its normal authority and version checks independently.
 */
export class HumanEditLeaseRegistry {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #newLeaseId: () => string;
  readonly #records = new Map<string, HumanEditLeaseRecord>();
  readonly #leaseIdsByIdentity = new Map<string, Set<string>>();
  readonly #leaseIdByBinding = new Map<string, string>();

  constructor(options: HumanEditLeaseRegistryOptions) {
    if (
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs <= 0
    ) {
      throw new Error("Human edit lease ttlMs must be a positive safe integer");
    }
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    this.#newLeaseId = options.newLeaseId;
  }

  register(input: RegisterHumanEditLeaseInput): HumanEditLeaseStoreResult {
    this.sweepExpired();
    const validated = humanEditLeaseSchema.safeParse({
      leaseId: "registration-validation",
      sessionId: input.sessionId,
      humanId: input.humanId,
      identity: input.identity,
      baseVersion: input.baseVersion,
      generation: 0,
      state: input.state,
      ...(input.draftPatch === undefined
        ? {}
        : { draftPatch: input.draftPatch }),
    });
    if (!validated.success) {
      return invalid(validated.error.issues[0]?.message ?? "invalid lease");
    }

    const existingLeaseId = this.#leaseIdByBinding.get(bindingKey(validated.data));
    if (existingLeaseId !== undefined) {
      const existing = this.#records.get(existingLeaseId);
      if (existing !== undefined) {
        // Registration is retry-idempotent. In particular, a reconnect retry
        // carrying a newer desired base/state cannot overwrite the server's
        // current truth without the existing lease's generation CAS.
        return { status: "ok", record: this.#copyRecord(existing) };
      }
      this.#leaseIdByBinding.delete(bindingKey(validated.data));
    }

    const leaseId = this.#newLeaseId();
    if (typeof leaseId !== "string" || leaseId.trim().length === 0) {
      return invalid("newLeaseId returned an empty identifier");
    }
    if (this.#records.has(leaseId)) {
      return invalid("newLeaseId returned an identifier already in use");
    }

    const lease = { ...validated.data, leaseId };
    const record = this.#newRecord(lease);
    this.#records.set(leaseId, record);
    const key = identityKey(record.lease.identity);
    const ids = this.#leaseIdsByIdentity.get(key) ?? new Set<string>();
    ids.add(leaseId);
    this.#leaseIdsByIdentity.set(key, ids);
    this.#leaseIdByBinding.set(bindingKey(record.lease), leaseId);
    return { status: "ok", record: this.#copyRecord(record) };
  }

  update(input: UpdateHumanEditLeaseInput): HumanEditLeaseStoreResult {
    const current = this.#ownedRecord(input);
    if (current === undefined) return { status: "not_found" };
    if (current.lease.generation !== input.expectedGeneration) {
      return {
        status: "stale_generation",
        record: this.#copyRecord(current),
      };
    }
    if (current.lease.generation >= Number.MAX_SAFE_INTEGER) {
      return invalid("lease generation cannot be incremented safely");
    }

    const parsed = humanEditLeaseSchema.safeParse({
      ...current.lease,
      baseVersion: input.baseVersion,
      generation: current.lease.generation + 1,
      state: input.state,
      ...(input.draftPatch === undefined
        ? { draftPatch: undefined }
        : { draftPatch: input.draftPatch }),
    });
    if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "invalid lease update");

    const record = this.#newRecord(parsed.data);
    this.#records.set(input.leaseId, record);
    return { status: "ok", record: this.#copyRecord(record) };
  }

  renew(input: AccessHumanEditLeaseInput): HumanEditLeaseStoreResult {
    const current = this.#ownedRecord(input);
    if (current === undefined) return { status: "not_found" };
    if (current.lease.generation !== input.expectedGeneration) {
      return {
        status: "stale_generation",
        record: this.#copyRecord(current),
      };
    }

    const record = this.#newRecord(current.lease);
    this.#records.set(input.leaseId, record);
    return { status: "ok", record: this.#copyRecord(record) };
  }

  release(input: AccessHumanEditLeaseInput): HumanEditLeaseStoreResult {
    const current = this.#ownedRecord(input);
    if (current === undefined) return { status: "not_found" };
    if (current.lease.generation !== input.expectedGeneration) {
      return {
        status: "stale_generation",
        record: this.#copyRecord(current),
      };
    }

    this.#deleteRecord(current);
    return { status: "ok", record: this.#copyRecord(current) };
  }

  getForIdentity(identity: DocumentIdentity): readonly HumanEditLeaseRecord[] {
    this.sweepExpired();
    const ids = this.#leaseIdsByIdentity.get(identityKey(identity));
    if (ids === undefined) return [];
    return [...ids]
      .sort()
      .flatMap((leaseId) => {
        const record = this.#records.get(leaseId);
        return record === undefined ? [] : [this.#copyRecord(record)];
      });
  }

  /** Read current ephemeral truth by opaque lease id without exposing storage. */
  getByLeaseId(leaseId: string): HumanEditLeaseRecord | null {
    this.sweepExpired();
    const record = this.#records.get(leaseId);
    return record === undefined ? null : this.#copyRecord(record);
  }

  sweepExpired(): number {
    const now = this.#safeNow();
    let removed = 0;
    for (const record of this.#records.values()) {
      if (record.expiresAtMs <= now) {
        this.#deleteRecord(record);
        removed += 1;
      }
    }
    return removed;
  }

  #ownedRecord(input: {
    readonly leaseId: string;
    readonly sessionId: string;
    readonly humanId: string;
  }): HumanEditLeaseRecord | undefined {
    const current = this.#records.get(input.leaseId);
    if (current === undefined) return undefined;
    if (current.expiresAtMs <= this.#safeNow()) {
      this.#deleteRecord(current);
      return undefined;
    }
    if (
      current.lease.humanId !== input.humanId ||
      current.lease.sessionId !== input.sessionId
    ) {
      return undefined;
    }
    return current;
  }

  #newRecord(lease: HumanEditLease): HumanEditLeaseRecord {
    const now = this.#safeNow();
    const expiresAtMs = now + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new Error("Human edit lease expiry exceeds safe integer range");
    }
    return humanEditLeaseRecordSchema.parse({ lease, expiresAtMs });
  }

  #copyRecord(record: HumanEditLeaseRecord): HumanEditLeaseRecord {
    return humanEditLeaseRecordSchema.parse(record);
  }

  #deleteRecord(record: HumanEditLeaseRecord): void {
    this.#records.delete(record.lease.leaseId);
    const boundKey = bindingKey(record.lease);
    if (this.#leaseIdByBinding.get(boundKey) === record.lease.leaseId) {
      this.#leaseIdByBinding.delete(boundKey);
    }
    const key = identityKey(record.lease.identity);
    const ids = this.#leaseIdsByIdentity.get(key);
    if (ids === undefined) return;
    ids.delete(record.lease.leaseId);
    if (ids.size === 0) this.#leaseIdsByIdentity.delete(key);
  }

  #safeNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Human edit lease clock must return non-negative epoch milliseconds");
    }
    return now;
  }
}
