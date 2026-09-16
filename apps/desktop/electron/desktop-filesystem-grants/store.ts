/**
 * Instance-scoped durable desktop-filesystem-grant store.
 *
 * This is persistence only. It neither obtains platform authorization nor
 * decides whether a grant may be enforced by a relay.
 */

import {
  parseDesktopFilesystemGrant,
  type DesktopFilesystemGrant,
} from "@nautilo/desktop-filesystem-grants";
import {
  createDesktopFilesystemGrantStorage,
  type DesktopFilesystemGrantStorage,
  type DesktopFilesystemGrantStorageDependencies,
} from "./storage.ts";

const STORE_VERSION = 1 as const;
const EPOCH = new Date(0);

export interface DesktopFilesystemGrantEnvelope {
  version: typeof STORE_VERSION;
  instanceId: string;
  revision: number;
  grants: DesktopFilesystemGrant[];
  updatedAt: string;
}

export type DesktopFilesystemGrantStoreErrorCode =
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  | "invalid_grant"
  | "grant_not_found";

export type DesktopFilesystemGrantStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: DesktopFilesystemGrantStoreErrorCode; message: string };

export interface DesktopFilesystemGrantStoreOptions {
  instanceId: string;
  filePath: string;
  /** Historical path read once only when the renamed store is absent. */
  legacyFilePath?: string | undefined;
  clock?: () => Date;
  storage?: DesktopFilesystemGrantStorage;
  storageDependencies?: DesktopFilesystemGrantStorageDependencies;
}

export interface ListDesktopFilesystemGrantsInput {
  userId: string;
  /** Include expired or revoked records as non-authoritative history. */
  includeHistory?: boolean;
}

export interface ListedDesktopFilesystemGrant {
  grant: DesktopFilesystemGrant;
  status: "active" | "revoked" | "expired";
}

function resultError<T>(
  code: DesktopFilesystemGrantStoreErrorCode,
  message: string,
): DesktopFilesystemGrantStoreResult<T> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtcIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function grantStatus(grant: DesktopFilesystemGrant, now: Date): ListedDesktopFilesystemGrant["status"] {
  if (grant.revokedAt) return "revoked";
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now.getTime()) return "expired";
  return "active";
}

/**
 * Serialized in-process transaction façade. Cross-process locking is
 * intentionally outside this Electron-only persistence slice.
 */
export class DesktopFilesystemGrantStore {
  private readonly instanceId: string;
  private readonly clock: () => Date;
  private readonly storage: DesktopFilesystemGrantStorage;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: DesktopFilesystemGrantStoreOptions) {
    this.instanceId = options.instanceId;
    this.clock = options.clock ?? (() => new Date());
    this.storage =
      options.storage ??
      createDesktopFilesystemGrantStorage(
        options.filePath,
        options.legacyFilePath,
        options.storageDependencies,
      );
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private validateEnvelope(value: unknown): DesktopFilesystemGrantStoreResult<DesktopFilesystemGrantEnvelope> {
    if (!isRecord(value)) {
      return resultError("store_corrupt", "Desktop Filesystem Grant store must be a JSON object");
    }
    const keys = Object.keys(value);
    const expected = new Set(["version", "instanceId", "revision", "grants", "updatedAt"]);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      return resultError("store_corrupt", "Desktop Filesystem Grant store has an unsupported envelope shape");
    }
    if (value["version"] !== STORE_VERSION) {
      return resultError("store_corrupt", "Desktop Filesystem Grant store has an unsupported future version");
    }
    // `resolveInstance()` represents the default instance as the empty string.
    // It is a valid, durable owner identity — reject only non-string values.
    // Canonical shape (whitespace / noncanonical ids) is enforced by the grant
    // parser via `isCanonicalNautiloInstanceId`; the envelope only needs a
    // string to compare against this store's owner id.
    if (typeof value["instanceId"] !== "string") {
      return resultError("store_corrupt", "Desktop Filesystem Grant store has an invalid instance id");
    }
    if (value["instanceId"] !== this.instanceId) {
      return resultError("store_instance_mismatch", "Desktop Filesystem Grant store belongs to another instance");
    }
    if (
      typeof value["revision"] !== "number" ||
      !Number.isSafeInteger(value["revision"]) ||
      value["revision"] < 0
    ) {
      return resultError("store_corrupt", "Desktop Filesystem Grant store has an invalid revision");
    }
    if (!Array.isArray(value["grants"]) || !isUtcIso(value["updatedAt"])) {
      return resultError("store_corrupt", "Desktop Filesystem Grant store has invalid grants or updatedAt");
    }

    const grants: DesktopFilesystemGrant[] = [];
    for (const valueGrant of value["grants"]) {
      // Validate stored history against the immutable parser without treating
      // ordinary expiry as corruption; authority is decided below at read time.
      const parsed = parseDesktopFilesystemGrant(valueGrant, { now: EPOCH });
      if (!parsed.ok) {
        return resultError(
          "store_corrupt",
          `Desktop Filesystem Grant store contains an invalid grant: ${parsed.error.code}`,
        );
      }
      if (parsed.grant.subject.instanceId !== this.instanceId) {
        return resultError("store_corrupt", "Desktop Filesystem Grant belongs to another instance");
      }
      grants.push(parsed.grant);
    }
    return {
      ok: true,
      data: {
        version: STORE_VERSION,
        instanceId: value["instanceId"],
        revision: value["revision"],
        grants,
        updatedAt: value["updatedAt"],
      },
    };
  }

  /** Strictly decodes either named store; legacy bytes never get a looser schema. */
  private decodeEnvelope(
    raw: string,
    source: "renamed" | "legacy",
  ): DesktopFilesystemGrantStoreResult<DesktopFilesystemGrantEnvelope> {
    try {
      return this.validateEnvelope(JSON.parse(raw) as unknown);
    } catch {
      return resultError(
        "store_corrupt",
        `${source === "legacy" ? "legacy " : ""}Desktop Filesystem Grant store contains invalid JSON`,
      );
    }
  }

  private async readEnvelope(): Promise<DesktopFilesystemGrantStoreResult<DesktopFilesystemGrantEnvelope>> {
    let raw: string | null;
    try {
      raw = await this.storage.read();
    } catch (error) {
      return resultError(
        "store_unavailable",
        `could not read Desktop Filesystem Grant store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null) {
      let legacyRaw: string | null;
      try {
        legacyRaw = await this.storage.readLegacy?.() ?? null;
      } catch (error) {
        return resultError(
          "store_unavailable",
          `could not read legacy Desktop Filesystem Grant store: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (legacyRaw !== null) {
        const migrated = this.decodeEnvelope(legacyRaw, "legacy");
        if (!migrated.ok) return migrated;
        // The new path is written atomically before its contents are returned;
        // future reads and every mutation use only the renamed store.
        const persisted = await this.persist(migrated.data);
        if (!persisted.ok) return persisted;
        try {
          await this.storage.removeLegacy?.();
        } catch {
          // New bytes are already atomically durable. Leaving the historical
          // file behind cannot re-import it because every later read prefers
          // the renamed store; cleanup is deliberately best effort.
        }
        return persisted;
      }
      const now = this.clock();
      if (Number.isNaN(now.getTime())) {
        return resultError("store_unavailable", "Desktop Filesystem Grant store clock is invalid");
      }
      return {
        ok: true,
        data: {
          version: STORE_VERSION,
          instanceId: this.instanceId,
          revision: 0,
          grants: [],
          updatedAt: now.toISOString(),
        },
      };
    }
    return this.decodeEnvelope(raw, "renamed");
  }

  private async persist(
    envelope: DesktopFilesystemGrantEnvelope,
  ): Promise<DesktopFilesystemGrantStoreResult<DesktopFilesystemGrantEnvelope>> {
    try {
      await this.storage.writeAtomic(`${JSON.stringify(envelope, null, 2)}\n`);
      return { ok: true, data: envelope };
    } catch (error) {
      return resultError(
        "store_unavailable",
        `could not persist Desktop Filesystem Grant store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async create(input: {
    userId: string;
    grant: DesktopFilesystemGrant;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number }>> {
    return this.serialized(async () => {
      const now = this.clock();
      const parsed = parseDesktopFilesystemGrant(input.grant, { now });
      if (!parsed.ok) {
        return resultError("invalid_grant", `grant rejected: ${parsed.error.code}`);
      }
      if (
        parsed.grant.subject.userId !== input.userId ||
        parsed.grant.subject.instanceId !== this.instanceId
      ) {
        return resultError("invalid_grant", "grant subject must match the caller and store instance");
      }

      const current = await this.readEnvelope();
      if (!current.ok) return current;
      if (current.data.grants.some((grant) => grant.id === parsed.grant.id)) {
        return resultError("invalid_grant", "grant id already exists in this instance store");
      }
      const next = {
        ...current.data,
        revision: current.data.revision + 1,
        grants: [...current.data.grants, parsed.grant],
        updatedAt: now.toISOString(),
      };
      const written = await this.persist(next);
      return written.ok
        ? { ok: true, data: { grant: parsed.grant, revision: written.data.revision } }
        : written;
    });
  }

  async list(
    input: ListDesktopFilesystemGrantsInput,
  ): Promise<DesktopFilesystemGrantStoreResult<{ grants: ListedDesktopFilesystemGrant[]; revision: number }>> {
    return this.serialized(async () => {
      const current = await this.readEnvelope();
      if (!current.ok) return current;
      const now = this.clock();
      const grants = current.data.grants
        .filter((grant) => grant.subject.userId === input.userId)
        .map((grant) => ({ grant, status: grantStatus(grant, now) }))
        .filter((item) => input.includeHistory || item.status === "active");
      return { ok: true, data: { grants, revision: current.data.revision } };
    });
  }

  async revoke(input: {
    userId: string;
    grantId: string;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number }>> {
    return this.serialized(async () => {
      const current = await this.readEnvelope();
      if (!current.ok) return current;
      const now = this.clock();
      const target = current.data.grants.find(
        (grant) => grant.id === input.grantId && grant.subject.userId === input.userId,
      );
      if (!target) return resultError("grant_not_found", "grant not found for caller");
      const revoked = target.revokedAt ? target : { ...target, revokedAt: now.toISOString() };
      const next = {
        ...current.data,
        revision: current.data.revision + 1,
        grants: current.data.grants.map((grant) => (grant.id === target.id ? revoked : grant)),
        updatedAt: now.toISOString(),
      };
      const written = await this.persist(next);
      return written.ok
        ? { ok: true, data: { grant: revoked, revision: written.data.revision } }
        : written;
    });
  }

  /** Records an authorized grant use for Settings history. */
  async touchLastUsed(input: {
    userId: string;
    grantId: string;
  }): Promise<DesktopFilesystemGrantStoreResult<{ grant: DesktopFilesystemGrant; revision: number }>> {
    return this.serialized(async () => {
      const current = await this.readEnvelope();
      if (!current.ok) return current;
      const now = this.clock();
      const grant = current.data.grants.find(
        (candidate) => candidate.id === input.grantId && candidate.subject.userId === input.userId,
      );
      if (!grant) return resultError("grant_not_found", "grant not found for caller");
      if (grantStatus(grant, now) !== "active") {
        return resultError("grant_not_found", "revoked or expired grant is not active authority");
      }
      const touched = { ...grant, lastUsedAt: now.toISOString() };
      const parsed = parseDesktopFilesystemGrant(touched, { now: EPOCH });
      if (!parsed.ok) {
        return resultError("invalid_grant", `cannot record grant use: ${parsed.error.code}`);
      }
      const next = {
        ...current.data,
        revision: current.data.revision + 1,
        grants: current.data.grants.map((candidate) =>
          candidate.id === grant.id ? parsed.grant : candidate,
        ),
        updatedAt: now.toISOString(),
      };
      const written = await this.persist(next);
      return written.ok
        ? { ok: true, data: { grant: parsed.grant, revision: written.data.revision } }
        : written;
    });
  }
}
