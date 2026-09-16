/**
 * Instance-scoped durable WorkstationProfile store.
 *
 * Profiles are admin configuration, never authority by themselves. This store
 * persists strict profile envelopes fail-closed: corrupt or future-format
 * state is never silently overwritten, and a store file belonging to another
 * instance is rejected rather than mutated. The store is owner-only and
 * instance-scoped — there is no per-user filter because profiles are not user
 * authority.
 *
 * Two independent revision dimensions are kept strictly separate:
 *   - each `WorkstationProfile.revision` is the per-profile configuration
 *     revision. `update` enforces monotonic +1 increments via strict
 *     `expectedRevision` optimistic concurrency.
 *   - the envelope `revision` is the store-level mutation counter. It bumps by
 *     one on every successful create/update and is unrelated to any grant
 *     `policyVersion`.
 *
 * This is persistence only. It neither compiles a profile into authority nor
 * decides whether a compiled grant may be enforced.
 */

import {
  parseWorkstationProfile,
  type WorkstationProfile,
} from "@nautilo/workstation-profiles";
import {
  createWorkstationProfileStorage,
  type WorkstationProfileStorage,
  type WorkstationProfileStorageDependencies,
} from "./storage.ts";

const STORE_VERSION = 1 as const;

export interface WorkstationProfileStoreEnvelope {
  version: typeof STORE_VERSION;
  instanceId: string;
  revision: number;
  profiles: WorkstationProfile[];
  updatedAt: string;
}

export type WorkstationProfileStoreErrorCode =
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  | "invalid_profile"
  | "profile_not_found"
  | "profile_revision_conflict"
  | "profile_id_mismatch";

export type WorkstationProfileStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: WorkstationProfileStoreErrorCode; message: string };

export interface WorkstationProfileStoreOptions {
  instanceId: string;
  filePath: string;
  clock?: () => Date;
  storage?: WorkstationProfileStorage;
  storageDependencies?: WorkstationProfileStorageDependencies;
}

function resultError<T>(
  code: WorkstationProfileStoreErrorCode,
  message: string,
): WorkstationProfileStoreResult<T> {
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

export class WorkstationProfileStore {
  private readonly instanceId: string;
  private readonly clock: () => Date;
  private readonly storage: WorkstationProfileStorage;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: WorkstationProfileStoreOptions) {
    this.instanceId = options.instanceId;
    this.clock = options.clock ?? (() => new Date());
    this.storage =
      options.storage ??
      createWorkstationProfileStorage(options.filePath, options.storageDependencies);
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

  private validateEnvelope(
    value: unknown,
  ): WorkstationProfileStoreResult<WorkstationProfileStoreEnvelope> {
    if (!isRecord(value)) {
      return resultError("store_corrupt", "workstation profile store must be a JSON object");
    }
    const keys = Object.keys(value);
    const expected = new Set(["version", "instanceId", "revision", "profiles", "updatedAt"]);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      return resultError(
        "store_corrupt",
        "workstation profile store has an unsupported envelope shape",
      );
    }
    if (value["version"] !== STORE_VERSION) {
      return resultError(
        "store_corrupt",
        "workstation profile store has an unsupported future version",
      );
    }
    // `resolveInstance()` represents the default instance as the empty string.
    // It is a valid, durable owner identity — reject only non-string values.
    if (typeof value["instanceId"] !== "string") {
      return resultError("store_corrupt", "workstation profile store has an invalid instance id");
    }
    if (value["instanceId"] !== this.instanceId) {
      return resultError(
        "store_instance_mismatch",
        "workstation profile store belongs to another instance",
      );
    }
    if (
      typeof value["revision"] !== "number" ||
      !Number.isSafeInteger(value["revision"]) ||
      value["revision"] < 0
    ) {
      return resultError("store_corrupt", "workstation profile store has an invalid revision");
    }
    if (!Array.isArray(value["profiles"]) || !isUtcIso(value["updatedAt"])) {
      return resultError(
        "store_corrupt",
        "workstation profile store has invalid profiles or updatedAt",
      );
    }

    const profiles: WorkstationProfile[] = [];
    const seenIds = new Set<string>();
    for (const entry of value["profiles"]) {
      const parsed = parseWorkstationProfile(entry, { now: this.clock() });
      if (!parsed.ok) {
        return resultError(
          "store_corrupt",
          `workstation profile store contains an invalid profile: ${parsed.error.code}`,
        );
      }
      if (seenIds.has(parsed.profile.id)) {
        return resultError(
          "store_corrupt",
          "workstation profile store contains a duplicate profile id",
        );
      }
      seenIds.add(parsed.profile.id);
      profiles.push(parsed.profile);
    }
    return {
      ok: true,
      data: {
        version: STORE_VERSION,
        instanceId: value["instanceId"],
        revision: value["revision"],
        profiles,
        updatedAt: value["updatedAt"],
      },
    };
  }

  private async readEnvelope(): Promise<WorkstationProfileStoreResult<WorkstationProfileStoreEnvelope>> {
    let raw: string | null;
    try {
      raw = await this.storage.read();
    } catch (error) {
      return resultError(
        "store_unavailable",
        `could not read workstation profile store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null) {
      const now = this.clock();
      if (Number.isNaN(now.getTime())) {
        return resultError("store_unavailable", "workstation profile store clock is invalid");
      }
      return {
        ok: true,
        data: {
          version: STORE_VERSION,
          instanceId: this.instanceId,
          revision: 0,
          profiles: [],
          updatedAt: now.toISOString(),
        },
      };
    }
    try {
      return this.validateEnvelope(JSON.parse(raw) as unknown);
    } catch {
      return resultError("store_corrupt", "workstation profile store contains invalid JSON");
    }
  }

  private async persist(
    envelope: WorkstationProfileStoreEnvelope,
  ): Promise<WorkstationProfileStoreResult<WorkstationProfileStoreEnvelope>> {
    try {
      await this.storage.writeAtomic(`${JSON.stringify(envelope, null, 2)}\n`);
      return { ok: true, data: envelope };
    } catch (error) {
      return resultError(
        "store_unavailable",
        `could not persist workstation profile store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(): Promise<
    WorkstationProfileStoreResult<{ profiles: WorkstationProfile[]; revision: number }>
  > {
    return this.serialized(async () => {
      const current = await this.readEnvelope();
      if (!current.ok) return current;
      return {
        ok: true,
        data: { profiles: current.data.profiles, revision: current.data.revision },
      };
    });
  }

  async get(input: {
    profileId: string;
  }): Promise<WorkstationProfileStoreResult<{ profile: WorkstationProfile }>> {
    return this.serialized(async () => {
      const current = await this.readEnvelope();
      if (!current.ok) return current;
      const profile = current.data.profiles.find((candidate) => candidate.id === input.profileId);
      if (profile === undefined) {
        return resultError("profile_not_found", "profile not found in this instance store");
      }
      return { ok: true, data: { profile } };
    });
  }

  async create(input: {
    profile: WorkstationProfile;
  }): Promise<
    WorkstationProfileStoreResult<{ profile: WorkstationProfile; revision: number }>
  > {
    return this.serialized(async () => {
      const now = this.clock();
      const parsed = parseWorkstationProfile(input.profile, { now });
      if (!parsed.ok) {
        return resultError("invalid_profile", `profile rejected: ${parsed.error.code}`);
      }

      const current = await this.readEnvelope();
      if (!current.ok) return current;
      if (current.data.profiles.some((candidate) => candidate.id === parsed.profile.id)) {
        return resultError("invalid_profile", "profile id already exists in this instance store");
      }
      const next: WorkstationProfileStoreEnvelope = {
        version: STORE_VERSION,
        instanceId: this.instanceId,
        revision: current.data.revision + 1,
        profiles: [...current.data.profiles, parsed.profile],
        updatedAt: now.toISOString(),
      };
      const written = await this.persist(next);
      return written.ok
        ? { ok: true, data: { profile: parsed.profile, revision: written.data.revision } }
        : written;
    });
  }

  async update(input: {
    profileId: string;
    /** The stored profile revision the caller believes it is replacing. */
    expectedRevision: number;
    /** The next profile payload. Its id must match profileId and its revision must be exactly expectedRevision + 1. */
    profile: WorkstationProfile;
  }): Promise<
    WorkstationProfileStoreResult<{ profile: WorkstationProfile; revision: number }>
  > {
    return this.serialized(async () => {
      const now = this.clock();
      const parsed = parseWorkstationProfile(input.profile, { now });
      if (!parsed.ok) {
        return resultError("invalid_profile", `profile rejected: ${parsed.error.code}`);
      }
      if (parsed.profile.id !== input.profileId) {
        return resultError(
          "profile_id_mismatch",
          "update payload id must match the targeted profile id",
        );
      }
      if (
        typeof input.expectedRevision !== "number" ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1
      ) {
        return resultError("invalid_profile", "expectedRevision must be a positive safe integer");
      }
      if (parsed.profile.revision !== input.expectedRevision + 1) {
        return resultError(
          "invalid_profile",
          "profile revision must increment by exactly one on update",
        );
      }

      const current = await this.readEnvelope();
      if (!current.ok) return current;
      const stored = current.data.profiles.find(
        (candidate) => candidate.id === input.profileId,
      );
      if (stored === undefined) {
        return resultError("profile_not_found", "profile not found in this instance store");
      }
      if (stored.revision !== input.expectedRevision) {
        return resultError(
          "profile_revision_conflict",
          `profile revision is ${stored.revision}, not the expected ${input.expectedRevision}`,
        );
      }
      const next: WorkstationProfileStoreEnvelope = {
        version: STORE_VERSION,
        instanceId: this.instanceId,
        revision: current.data.revision + 1,
        profiles: current.data.profiles.map((candidate) =>
          candidate.id === parsed.profile.id ? parsed.profile : candidate,
        ),
        updatedAt: now.toISOString(),
      };
      const written = await this.persist(next);
      return written.ok
        ? { ok: true, data: { profile: parsed.profile, revision: written.data.revision } }
        : written;
    });
  }
}
