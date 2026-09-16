import {
  CLIENT_PROFILE_VAULT_FORMAT_VERSION,
  CLIENT_PROFILE_VAULT_MAX_PROFILES,
  type ClientProfileCoordinates,
  type ClientProfilePublicState,
  type ClientProfileVault,
  type ClientProfileVaultAvailability,
  type InterruptedClientProfileResolution,
  type PublicClientProfile,
  type StageClientProfileInput,
  type StagedClientProfileReceipt,
} from "../client-vault/types.ts";
import {
  assertClientProfileCoordinates,
  assertStageInput,
  coordinatesKey,
} from "../client-vault/validation.ts";

interface MemoryProfile {
  readonly coordinates: ClientProfileCoordinates;
  readonly generation: number;
  readonly profileBytes: Uint8Array;
  readonly publicState: ClientProfilePublicState;
  readonly stageId?: string;
}

interface MemoryProfileSlots {
  active?: MemoryProfile;
  staged?: MemoryProfile;
}

function cloneCoordinates(
  coordinates: ClientProfileCoordinates,
): ClientProfileCoordinates {
  return { ...coordinates };
}

function clonePublicState(
  publicState: ClientProfilePublicState,
): ClientProfilePublicState {
  return { ...publicState };
}

function cloneProfile(profile: MemoryProfile): MemoryProfile {
  return {
    coordinates: cloneCoordinates(profile.coordinates),
    generation: profile.generation,
    profileBytes: profile.profileBytes.slice(),
    publicState: clonePublicState(profile.publicState),
    ...(profile.stageId === undefined ? {} : { stageId: profile.stageId }),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function sameStage(
  existing: MemoryProfile,
  input: StageClientProfileInput,
): boolean {
  return existing.stageId === input.stageId
    && existing.generation === input.generation
    && sameBytes(existing.profileBytes, input.profileBytes)
    && existing.publicState.clientKind === input.publicState.clientKind
    && existing.publicState.publicFingerprint
      === input.publicState.publicFingerprint;
}

export class MemoryClientProfileVault implements ClientProfileVault {
  readonly #profiles = new Map<string, MemoryProfileSlots>();
  #locked = true;

  availability(): Promise<ClientProfileVaultAvailability> {
    return Promise.resolve({
      status: this.#locked ? "locked" : "available",
    });
  }

  unlock(): Promise<ClientProfileVaultAvailability> {
    this.#locked = false;
    return Promise.resolve({ status: "available" });
  }

  lock(): Promise<void> {
    this.#locked = true;
    return Promise.resolve();
  }

  stageProfile(
    input: StageClientProfileInput,
  ): Promise<StagedClientProfileReceipt> {
    try {
      this.#assertUnlocked();
      assertStageInput(input);
      const key = coordinatesKey(input.coordinates);
      const slots = this.#profiles.get(key) ?? {};
      if (
        !this.#profiles.has(key)
        && this.#profiles.size >= CLIENT_PROFILE_VAULT_MAX_PROFILES
      ) {
        throw new RangeError("client profile vault is full");
      }
      if (slots.staged !== undefined) {
        if (!sameStage(slots.staged, input)) {
          throw new Error("another client profile stage is already pending");
        }
        return Promise.resolve(this.#receipt(slots.staged));
      }
      const expectedGeneration = (slots.active?.generation ?? 0) + 1;
      if (input.generation !== expectedGeneration) {
        throw new Error("client profile stage generation is stale");
      }

      slots.staged = cloneProfile({
        coordinates: input.coordinates,
        generation: input.generation,
        profileBytes: input.profileBytes,
        publicState: input.publicState,
        stageId: input.stageId,
      });
      this.#profiles.set(key, slots);
      return Promise.resolve(this.#receipt(slots.staged));
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("vault stage failed"),
      );
    }
  }

  activateProfile(
    coordinates: ClientProfileCoordinates,
    stageId: string,
  ): Promise<void> {
    this.#assertUnlocked();
    const slots = this.#requiredSlots(coordinates);
    if (slots.staged?.stageId !== stageId) {
      throw new Error("client profile stage does not match");
    }
    if (slots.staged.generation !== (slots.active?.generation ?? 0) + 1) {
      throw new Error("client profile activation generation is stale");
    }
    slots.active?.profileBytes.fill(0);
    slots.active = cloneProfile({
      coordinates: slots.staged.coordinates,
      generation: slots.staged.generation,
      profileBytes: slots.staged.profileBytes,
      publicState: slots.staged.publicState,
    });
    slots.staged.profileBytes.fill(0);
    delete slots.staged;
    return Promise.resolve();
  }

  abortStagedProfile(
    coordinates: ClientProfileCoordinates,
    stageId: string,
  ): Promise<void> {
    this.#assertUnlocked();
    const key = coordinatesKey(coordinates);
    const slots = this.#profiles.get(key);
    if (slots?.staged === undefined) return Promise.resolve();
    if (slots.staged.stageId !== stageId) {
      throw new Error("client profile stage does not match");
    }
    slots.staged.profileBytes.fill(0);
    delete slots.staged;
    if (slots.active === undefined) this.#profiles.delete(key);
    return Promise.resolve();
  }

  recoverInterruptedActivation(
    coordinates: ClientProfileCoordinates,
    resolution: InterruptedClientProfileResolution,
  ): Promise<void> {
    return resolution.action === "activate"
      ? this.activateProfile(coordinates, resolution.stageId)
      : this.abortStagedProfile(coordinates, resolution.stageId);
  }

  async withOpenProfile<T>(
    coordinates: ClientProfileCoordinates,
    operation: (profileBytes: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    this.#assertUnlocked();
    const active = this.#requiredSlots(coordinates).active;
    if (active === undefined) {
      throw new Error("active client profile is unavailable");
    }
    const opened = active.profileBytes.slice();
    try {
      return await operation(opened);
    } finally {
      opened.fill(0);
    }
  }

  async withOpenStagedProfile<T>(
    coordinates: ClientProfileCoordinates,
    stageId: string,
    operation: (profileBytes: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    this.#assertUnlocked();
    const staged = this.#requiredSlots(coordinates).staged;
    if (staged === undefined || staged.stageId !== stageId) {
      throw new Error("staged client profile does not match");
    }
    const opened = staged.profileBytes.slice();
    try {
      return await operation(opened);
    } finally {
      opened.fill(0);
    }
  }

  listPublicProfiles(): Promise<readonly PublicClientProfile[]> {
    const profiles: PublicClientProfile[] = [];
    for (const slots of this.#profiles.values()) {
      if (slots.active !== undefined) {
        profiles.push(this.#publicProfile(slots.active, "active"));
      }
      if (slots.staged !== undefined) {
        profiles.push(this.#publicProfile(slots.staged, "staged"));
      }
    }
    profiles.sort((left, right) =>
      coordinatesKey(left.coordinates).localeCompare(
        coordinatesKey(right.coordinates),
      )
      || left.lifecycle.localeCompare(right.lifecycle)
    );
    return Promise.resolve(profiles);
  }

  rotateWrappingMaterial(): Promise<void> {
    this.#assertUnlocked();
    return Promise.resolve();
  }

  forgetProfile(coordinates: ClientProfileCoordinates): Promise<void> {
    this.#assertUnlocked();
    const key = coordinatesKey(coordinates);
    const slots = this.#profiles.get(key);
    slots?.active?.profileBytes.fill(0);
    slots?.staged?.profileBytes.fill(0);
    this.#profiles.delete(key);
    return Promise.resolve();
  }

  #assertUnlocked(): void {
    if (this.#locked) throw new Error("client profile vault is locked");
  }

  #requiredSlots(coordinates: ClientProfileCoordinates): MemoryProfileSlots {
    assertClientProfileCoordinates(coordinates);
    const slots = this.#profiles.get(coordinatesKey(coordinates));
    if (slots === undefined) {
      throw new Error("client profile is unavailable");
    }
    return slots;
  }

  #receipt(profile: MemoryProfile): StagedClientProfileReceipt {
    return {
      formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
      profileId: profile.coordinates.profileId,
      stageId: profile.stageId!,
      generation: profile.generation,
    };
  }

  #publicProfile(
    profile: MemoryProfile,
    lifecycle: "staged" | "active",
  ): PublicClientProfile {
    return {
      coordinates: cloneCoordinates(profile.coordinates),
      generation: profile.generation,
      lifecycle,
      publicState: clonePublicState(profile.publicState),
      ...(profile.stageId === undefined ? {} : { stageId: profile.stageId }),
    };
  }
}

export function createMemoryClientProfileVault(): ClientProfileVault {
  return new MemoryClientProfileVault();
}

export interface ClientProfileVaultConformanceReport {
  readonly checks: readonly string[];
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Client profile vault conformance: ${message}`);
}

const CONFORMANCE_COORDINATES = {
  serverScope: "https://vault.example.test",
  userId: "10000000-0000-4000-8000-000000000001",
  humanActorId: "20000000-0000-4000-8000-000000000001",
  profileId: "profile_conformance",
  deviceId: "device_conformance",
  installationLineageDigest:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
} as const;

const CONFORMANCE_PUBLIC_STATE = {
  clientKind: "browser",
  publicFingerprint:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

export async function runClientProfileVaultConformance(
  factory: () => ClientProfileVault,
): Promise<ClientProfileVaultConformanceReport> {
  const checks: string[] = [];
  const vault = factory();

  assert((await vault.availability()).status === "locked", "starts locked");
  assert((await vault.unlock()).status === "available", "unlocks");
  checks.push("availability");

  const original = new Uint8Array([7, 8, 9]);
  await vault.stageProfile({
    coordinates: CONFORMANCE_COORDINATES,
    stageId: "stage_1",
    generation: 1,
    profileBytes: original,
    publicState: CONFORMANCE_PUBLIC_STATE,
  });
  assert(original[0] === 7, "stage does not mutate caller bytes");
  let opened = false;
  try {
    await vault.withOpenProfile(CONFORMANCE_COORDINATES, () => {
      opened = true;
    });
  } catch {
    // Expected: a staged profile is not active.
  }
  assert(!opened, "staged profile cannot be opened");
  checks.push("stage-is-not-active");

  await vault.activateProfile(CONFORMANCE_COORDINATES, "stage_1");
  const value = await vault.withOpenProfile(
    CONFORMANCE_COORDINATES,
    (bytes) => bytes[1],
  );
  assert(value === 8, "activated profile opens");
  checks.push("activate-and-open");

  let retained: Uint8Array | undefined;
  await vault.withOpenProfile(CONFORMANCE_COORDINATES, (bytes) => {
    retained = bytes;
  });
  assert(retained?.every((byte) => byte === 0) === true, "opened bytes wipe");
  checks.push("opened-bytes-are-wiped");

  const otherServer = {
    ...CONFORMANCE_COORDINATES,
    serverScope: "https://other.example.test",
  };
  let isolated = false;
  try {
    await vault.withOpenProfile(otherServer, () => undefined);
  } catch {
    isolated = true;
  }
  assert(isolated, "server coordinates isolate profiles");
  checks.push("coordinates-isolate");

  const listed = await vault.listPublicProfiles();
  assert(listed.length === 1, "lists one active profile");
  assert(
    !JSON.stringify(listed).includes("7,8,9"),
    "public listing excludes profile bytes",
  );
  checks.push("public-enumeration");

  await vault.stageProfile({
    coordinates: CONFORMANCE_COORDINATES,
    stageId: "stage_abort",
    generation: 2,
    profileBytes: new Uint8Array([10]),
    publicState: CONFORMANCE_PUBLIC_STATE,
  });
  await vault.abortStagedProfile(CONFORMANCE_COORDINATES, "stage_abort");
  assert(
    await vault.withOpenProfile(
      CONFORMANCE_COORDINATES,
      (bytes) => bytes[0] === 7,
    ),
    "abort preserves active profile",
  );
  checks.push("abort-preserves-active");

  await vault.stageProfile({
    coordinates: CONFORMANCE_COORDINATES,
    stageId: "stage_recover",
    generation: 2,
    profileBytes: new Uint8Array([11]),
    publicState: CONFORMANCE_PUBLIC_STATE,
  });
  await vault.recoverInterruptedActivation(CONFORMANCE_COORDINATES, {
    stageId: "stage_recover",
    action: "activate",
  });
  assert(
    await vault.withOpenProfile(
      CONFORMANCE_COORDINATES,
      (bytes) => bytes[0] === 11,
    ),
    "interrupted activation resolves exactly",
  );
  checks.push("interrupted-activation");

  await vault.rotateWrappingMaterial();
  assert(
    await vault.withOpenProfile(
      CONFORMANCE_COORDINATES,
      (bytes) => bytes[0] === 11,
    ),
    "wrapping-key rotation preserves profile",
  );
  checks.push("wrapping-key-rotation");

  await vault.lock();
  let locked = false;
  try {
    await vault.withOpenProfile(CONFORMANCE_COORDINATES, () => undefined);
  } catch {
    locked = true;
  }
  assert(locked, "locked vault cannot open");
  await vault.unlock();
  assert(
    await vault.withOpenProfile(
      CONFORMANCE_COORDINATES,
      (bytes) => bytes[0] === 11,
    ),
    "unlock restores access",
  );
  checks.push("lock-and-unlock");

  await vault.forgetProfile(CONFORMANCE_COORDINATES);
  assert((await vault.listPublicProfiles()).length === 0, "forget removes");
  checks.push("forget");

  return { checks };
}
