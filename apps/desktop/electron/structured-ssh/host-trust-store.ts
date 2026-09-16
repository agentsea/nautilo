import {
  createStructuredSshStorage,
  hasExactKeys,
  isCanonicalSshHost,
  isSshFingerprint,
  isUtcIso,
  MAX_STRUCTURED_SSH_RECORDS,
  parseSshHostTrustRecord,
  STRUCTURED_SSH_STORE_VERSION,
  type SshHostTrustRecord,
  type SshHostTrustTarget,
  type StructuredSshStorage,
  type StructuredSshStorageDependencies,
} from "./contracts.ts";

interface SshHostTrustEnvelope {
  readonly version: typeof STRUCTURED_SSH_STORE_VERSION;
  readonly instanceId: string;
  readonly revision: number;
  readonly records: readonly SshHostTrustRecord[];
  readonly updatedAt: string;
}

export type SshHostTrustStoreErrorCode =
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  | "invalid_record"
  | "trust_not_found"
  | "trust_changed"
  | "retention_exhausted";

export type SshHostTrustStoreResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: SshHostTrustStoreErrorCode; readonly message: string };

export interface SshHostTrustStoreOptions {
  readonly instanceId: string;
  readonly filePath: string;
  readonly storage?: StructuredSshStorage;
  readonly storageDependencies?: StructuredSshStorageDependencies;
  readonly clock?: () => Date;
}

export type SshHostTrustInspection =
  | { readonly state: "unknown" }
  | { readonly state: "trusted"; readonly record: SshHostTrustRecord }
  | {
      readonly state: "changed";
      readonly record: SshHostTrustRecord;
      readonly observedFingerprint: string;
    };

/** Exact app-local pin lookup for the broker; it never touches ~/.ssh. */
export type SshHostTrustLookup =
  | { readonly state: "unknown" }
  | { readonly state: "trusted"; readonly record: SshHostTrustRecord };

function failed<T>(code: SshHostTrustStoreErrorCode, message: string): SshHostTrustStoreResult<T> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 31 - 1;
}

function isTarget(value: unknown): value is SshHostTrustTarget {
  return isRecord(value) && hasExactKeys(value, ["host", "port"]) && isCanonicalSshHost(value["host"]) && typeof value["port"] === "number" && Number.isSafeInteger(value["port"]) && value["port"] >= 1 && value["port"] <= 65_535;
}

function sameTarget(left: SshHostTrustTarget, right: SshHostTrustTarget): boolean {
  return left.host === right.host && left.port === right.port;
}

function isActive(record: SshHostTrustRecord): boolean {
  return record.replacedAt === undefined;
}

/**
 * App-local SSH host-key trust. It owns no OpenSSH configuration and has no
 * path to the Human's ~/.ssh files; callers supply only this store's own path.
 */
export class SshHostTrustStore {
  private readonly instanceId: string;
  private readonly storage: StructuredSshStorage;
  private readonly clock: () => Date;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: SshHostTrustStoreOptions) {
    this.instanceId = options.instanceId;
    this.storage = options.storage ?? createStructuredSshStorage(options.filePath, options.storageDependencies);
    this.clock = options.clock ?? (() => new Date());
  }

  private async serialized<T>(operation: () => Promise<SshHostTrustStoreResult<T>>): Promise<SshHostTrustStoreResult<T>> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private empty(): SshHostTrustStoreResult<SshHostTrustEnvelope> {
    const now = this.clock();
    if (Number.isNaN(now.getTime())) return failed("store_unavailable", "structured SSH host trust clock is unavailable");
    return { ok: true, data: { version: STRUCTURED_SSH_STORE_VERSION, instanceId: this.instanceId, revision: 0, records: [], updatedAt: now.toISOString() } };
  }

  private decode(raw: string): SshHostTrustStoreResult<SshHostTrustEnvelope> {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return failed("store_corrupt", "structured SSH host trust contains invalid JSON"); }
    if (!isRecord(value) || !hasExactKeys(value, ["version", "instanceId", "revision", "records", "updatedAt"]) || value["version"] !== STRUCTURED_SSH_STORE_VERSION || typeof value["instanceId"] !== "string" || !isRevision(value["revision"]) || !Array.isArray(value["records"]) || value["records"].length > MAX_STRUCTURED_SSH_RECORDS || !isUtcIso(value["updatedAt"])) return failed("store_corrupt", "structured SSH host trust has an invalid envelope");
    if (value["instanceId"] !== this.instanceId) return failed("store_instance_mismatch", "structured SSH host trust belongs to another instance");
    const records: SshHostTrustRecord[] = [];
    const activeTargets = new Set<string>();
    for (const candidate of value["records"]) {
      const record = parseSshHostTrustRecord(candidate);
      if (record === null) return failed("store_corrupt", "structured SSH host trust contains an invalid record");
      if (isActive(record)) {
        const key = `${record.host}:${record.port}`;
        if (activeTargets.has(key)) return failed("store_corrupt", "structured SSH host trust has duplicate active targets");
        activeTargets.add(key);
      }
      records.push(record);
    }
    return { ok: true, data: { version: STRUCTURED_SSH_STORE_VERSION, instanceId: this.instanceId, revision: value["revision"], records, updatedAt: value["updatedAt"] } };
  }

  private async read(): Promise<SshHostTrustStoreResult<SshHostTrustEnvelope>> {
    let raw: string | null;
    try { raw = await this.storage.read(); } catch { return failed("store_unavailable", "structured SSH host trust could not be read"); }
    return raw === null ? this.empty() : this.decode(raw);
  }

  private async write(envelope: SshHostTrustEnvelope): Promise<SshHostTrustStoreResult<SshHostTrustEnvelope>> {
    try {
      await this.storage.writeAtomic(`${JSON.stringify(envelope, null, 2)}\n`);
      return { ok: true, data: envelope };
    } catch {
      return failed("store_unavailable", "structured SSH host trust could not be persisted");
    }
  }

  private retained(records: readonly SshHostTrustRecord[]): SshHostTrustRecord[] | null {
    const active = records.filter(isActive);
    if (active.length > MAX_STRUCTURED_SSH_RECORDS) return null;
    const history = records.filter((record) => !isActive(record)).sort((left, right) => (right.replacedAt ?? "").localeCompare(left.replacedAt ?? ""));
    return [...history.slice(0, MAX_STRUCTURED_SSH_RECORDS - active.length), ...active];
  }

  async inspect(input: { readonly target: SshHostTrustTarget; readonly observedFingerprint: string }): Promise<SshHostTrustStoreResult<SshHostTrustInspection>> {
    return this.serialized(async () => {
      if (!isTarget(input.target) || !isSshFingerprint(input.observedFingerprint)) return failed("invalid_record", "structured SSH host trust input is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      const record = current.data.records.find((candidate) => isActive(candidate) && sameTarget(candidate, input.target));
      if (!record) return { ok: true, data: { state: "unknown" } };
      return record.hostKeyFingerprint === input.observedFingerprint
        ? { ok: true, data: { state: "trusted", record } }
        : { ok: true, data: { state: "changed", record, observedFingerprint: input.observedFingerprint } };
    });
  }

  /**
   * Reads exactly one active local pin by canonical host and port. This is
   * deliberately separate from `inspect`: callers that do not yet have an
   * observed key must not manufacture a fingerprint merely to read the store.
   */
  async lookup(input: { readonly target: SshHostTrustTarget }): Promise<SshHostTrustStoreResult<SshHostTrustLookup>> {
    return this.serialized(async () => {
      if (!isTarget(input.target)) return failed("invalid_record", "structured SSH host trust input is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      const record = current.data.records.find((candidate) => isActive(candidate) && sameTarget(candidate, input.target));
      return record === undefined ? { ok: true, data: { state: "unknown" } } : { ok: true, data: { state: "trusted", record } };
    });
  }

  async confirm(input: { readonly target: SshHostTrustTarget; readonly hostKeyFingerprint: string }): Promise<SshHostTrustStoreResult<{ readonly record: SshHostTrustRecord; readonly revision: number }>> {
    return this.serialized(async () => {
      if (!isTarget(input.target) || !isSshFingerprint(input.hostKeyFingerprint)) return failed("invalid_record", "structured SSH host trust input is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      const existing = current.data.records.find((candidate) => isActive(candidate) && sameTarget(candidate, input.target));
      if (existing) {
        if (existing.hostKeyFingerprint !== input.hostKeyFingerprint) return failed("trust_changed", "structured SSH host key changed and requires explicit replacement");
        return { ok: true, data: { record: existing, revision: current.data.revision } };
      }
      const record: SshHostTrustRecord = { version: 1, ...input.target, hostKeyFingerprint: input.hostKeyFingerprint, confirmedAt: this.clock().toISOString() };
      const records = this.retained([...current.data.records, record]);
      if (!records) return failed("retention_exhausted", "structured SSH host trust retention is full");
      const written = await this.write({ ...current.data, revision: current.data.revision + 1, records, updatedAt: this.clock().toISOString() });
      return written.ok ? { ok: true, data: { record, revision: written.data.revision } } : written;
    });
  }

  async replace(input: { readonly target: SshHostTrustTarget; readonly previousFingerprint: string; readonly nextFingerprint: string }): Promise<SshHostTrustStoreResult<{ readonly record: SshHostTrustRecord; readonly revision: number }>> {
    return this.serialized(async () => {
      if (!isTarget(input.target) || !isSshFingerprint(input.previousFingerprint) || !isSshFingerprint(input.nextFingerprint) || input.previousFingerprint === input.nextFingerprint) return failed("invalid_record", "structured SSH host trust replacement is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      const previous = current.data.records.find((candidate) => isActive(candidate) && sameTarget(candidate, input.target));
      if (!previous) return failed("trust_not_found", "structured SSH host trust record was not found");
      if (previous.hostKeyFingerprint !== input.previousFingerprint) return failed("trust_changed", "structured SSH host key no longer matches the replacement request");
      const now = this.clock().toISOString();
      const record: SshHostTrustRecord = { version: 1, ...input.target, hostKeyFingerprint: input.nextFingerprint, confirmedAt: now };
      const records = this.retained([...current.data.records.map((candidate) => candidate === previous ? { ...candidate, replacedAt: now } : candidate), record]);
      if (!records) return failed("retention_exhausted", "structured SSH host trust retention is full");
      const written = await this.write({ ...current.data, revision: current.data.revision + 1, records, updatedAt: now });
      return written.ok ? { ok: true, data: { record, revision: written.data.revision } } : written;
    });
  }

  async remove(input: { readonly target: SshHostTrustTarget; readonly hostKeyFingerprint: string }): Promise<SshHostTrustStoreResult<{ readonly removed: boolean; readonly revision: number }>> {
    return this.serialized(async () => {
      if (!isTarget(input.target) || !isSshFingerprint(input.hostKeyFingerprint)) return failed("invalid_record", "structured SSH host trust input is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      const records = current.data.records.filter((record) => !(sameTarget(record, input.target) && record.hostKeyFingerprint === input.hostKeyFingerprint));
      if (records.length === current.data.records.length) return { ok: true, data: { removed: false, revision: current.data.revision } };
      const written = await this.write({ ...current.data, revision: current.data.revision + 1, records, updatedAt: this.clock().toISOString() });
      return written.ok ? { ok: true, data: { removed: true, revision: written.data.revision } } : written;
    });
  }
}
