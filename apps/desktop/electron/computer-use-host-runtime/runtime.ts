import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ComputerUseHostFailureCode,
  ComputerUseHostLease,
  ComputerUseHostMember,
  ComputerUseHostRecord,
  ComputerUseHostRelease,
  ComputerUseHostRuntimeOptions,
  ComputerUseHostSource,
  ComputerUseHostStagedArtifact,
  ComputerUseHostState,
} from "./contracts.ts";

const HEX = /^[a-f0-9]{64}$/;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const MAX_MEMBERS = 512;
const MAX_MEMBER_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export interface ComputerUseHostRuntimeLaunch {
  readonly entrypoint: string;
  readonly release: ComputerUseHostRelease;
  readonly generation: number;
  readonly lease: ComputerUseHostLease;
}

function sameHex(left: string, right: string): boolean {
  if (!HEX.test(left) || !HEX.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function isSafeMemberPath(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, "utf8") <= 1024
    && !value.includes("\0")
    && !value.startsWith("/")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function sameHttpsOrigin(left: string, right: string): boolean {
  try {
    const candidate = new URL(left);
    const pointer = new URL(right);
    return candidate.protocol === "https:" && pointer.protocol === "https:" && candidate.origin === pointer.origin;
  } catch { return false; }
}

function releaseFailure(release: ComputerUseHostRelease, code: ComputerUseHostFailureCode): ComputerUseHostState {
  // Keep the release itself private: status must never disclose native paths,
  // archive URLs, hashes, or signing information to a Genie.
  void release;
  return { state: "unavailable", code };
}

function recordFor(release: ComputerUseHostRelease, generation: number, source: "bundled" | "managed"): ComputerUseHostRecord {
  return {
    schemaVersion: 1,
    generation,
    source,
    releaseId: release.releaseId,
    version: release.version,
    archiveSha256: release.archive.sha256,
    releaseSha256: createHash("sha256").update(JSON.stringify(release)).digest("hex"),
  };
}

function releaseMatchesRecord(release: ComputerUseHostRelease, record: ComputerUseHostRecord): boolean {
  return record.schemaVersion === 1
    && Number.isSafeInteger(record.generation)
    && record.generation > 0
    && (record.source === "bundled" || record.source === "managed")
    && record.releaseId === release.releaseId
    && record.version === release.version
    && sameHex(record.archiveSha256, release.archive.sha256)
    && sameHex(record.releaseSha256, createHash("sha256").update(JSON.stringify(release)).digest("hex"));
}

function compareVersion(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?(?:\+[A-Za-z0-9.-]+)?$/u.exec(value)!;
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], suffix: match[4] };
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const order = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (order !== 0) return Math.sign(order);
  }
  if (a.suffix === b.suffix) return 0;
  if (a.suffix === undefined) return 1;
  if (b.suffix === undefined) return -1;
  const leftParts = a.suffix.split("."); const rightParts = b.suffix.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index]; const y = rightParts[index];
    if (x === undefined) return -1; if (y === undefined) return 1; if (x === y) continue;
    const xNumber = /^\d+$/u.test(x); const yNumber = /^\d+$/u.test(y);
    if (xNumber && yNumber) return Number(x) < Number(y) ? -1 : 1;
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x.localeCompare(y);
  }
  return 0;
}

/**
 * A deliberately narrow managed runtime model based on codex-runtime's
 * acquire → verify → health → atomic-active/rollback flow. Launch is exposed
 * only after an immutable, attested release has become active.
 */
export class ComputerUseHostRuntime {
  private readonly leases = new Map<number, number>();
  private active: Readonly<{ release: ComputerUseHostRelease; generation: number; entrypoint: string; source: ComputerUseHostSource }> | null = null;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly options: ComputerUseHostRuntimeOptions) {}

  async bootstrap(signal?: AbortSignal): Promise<ComputerUseHostState> {
    return await this.serialized(async () => {
      if (!(await this.options.storage.ensurePrivateRoot())) return { state: "unavailable", code: "host_root_unsafe" };
      await this.options.storage.recoverStaging();
      const active = await this.activateRecord("active", signal);
      if (active !== null) {
        if (compareVersion(active.release.version, this.options.bundledRelease.version) >= 0) return active;
        const bundled = await this.stageVerifyHealthActivate(this.options.bundledRelease, "bundled", false, signal);
        return bundled.state === "ready" ? bundled : active;
      }
      const rollback = await this.activateRecord("rollback", signal);
      if (rollback !== null) {
        if (compareVersion(rollback.release.version, this.options.bundledRelease.version) >= 0) return rollback;
        const bundled = await this.stageVerifyHealthActivate(this.options.bundledRelease, "bundled", false, signal);
        return bundled.state === "ready" ? bundled : rollback;
      }
      return await this.stageVerifyHealthActivate(this.options.bundledRelease, "bundled", false, signal);
    });
  }

  /** Downloads only from the compiled official pointer authority. */
  async updateFromOfficialPointer(signal?: AbortSignal): Promise<ComputerUseHostState> {
    return await this.serialized(async () => {
      if (!(await this.options.storage.ensurePrivateRoot())) return { state: "unavailable", code: "host_root_unsafe" };
      const authority = this.options.releaseAuthority;
      if (authority === undefined) return { state: "unavailable", code: "host_pointer_untrusted" };
      let release: ComputerUseHostRelease;
      try {
        release = await authority.resolveOfficialRelease(this.options.officialPointerUrl, signal);
      } catch {
        return { state: "unavailable", code: "host_pointer_untrusted" };
      }
      if (!this.releaseShapeIsAllowed(release) || release.pointerUrl !== this.options.officialPointerUrl)
        return releaseFailure(release, "host_release_invalid");
      return await this.stageVerifyHealthActivate(release, "managed", true, signal);
    });
  }

  snapshot(): ComputerUseHostState {
    const active = this.active;
    return active === null
      ? { state: "unavailable", code: "host_unavailable" }
      : { state: "ready", source: active.source, release: active.release, generation: active.generation };
  }

  acquireLaunch(): ComputerUseHostRuntimeLaunch | null {
    const active = this.active;
    if (active === null) return null;
    this.leases.set(active.generation, (this.leases.get(active.generation) ?? 0) + 1);
    let released = false;
    return {
      entrypoint: active.entrypoint,
      release: active.release,
      generation: active.generation,
      lease: {
        generation: active.generation,
        release: () => {
          if (released) return;
          released = true;
          const count = this.leases.get(active.generation) ?? 0;
          if (count <= 1) this.leases.delete(active.generation);
          else this.leases.set(active.generation, count - 1);
        },
      },
    };
  }

  leaseCount(generation: number): number {
    return this.leases.get(generation) ?? 0;
  }

  private async activateRecord(
    kind: "active" | "rollback",
    signal?: AbortSignal,
  ): Promise<Extract<ComputerUseHostState, { state: "ready" }> | null> {
    const record = await this.options.storage.readRecord(kind);
    if (record === null) return null;
    const release = await this.options.storage.findRelease(record);
    if (release === null || !this.releaseShapeIsAllowed(release) || !releaseMatchesRecord(release, record)) return null;
    let staged: ComputerUseHostStagedArtifact;
    try { staged = await this.options.storage.openInstalled(release); } catch { return null; }
    const verified = this.verifyStaged(release, staged, signal);
    if (verified === null) return null;
    let signed = false;
    let healthy = false;
    try {
      signed = await this.options.attestor.verifyMacosRelease(verified, release, this.options.expectedArchitectures, signal);
      healthy = signed && await this.options.attestor.health(verified, release, signal);
    } catch { /* installed bytes are still untrusted until both checks pass */ }
    if (!signed || !healthy) return null;
    const source: ComputerUseHostSource = kind === "rollback" ? "rollback" : record.source;
    let generation = record.generation;
    if (kind === "rollback") {
      const active = await this.options.storage.readRecord("active");
      generation = Math.max(active?.generation ?? 0, record.generation) + 1;
      if (!Number.isSafeInteger(generation)) return null;
      try {
        await this.options.storage.writeRecord("active", recordFor(release, generation, record.source));
      } catch { return null; }
    }
    this.active = { release, generation, entrypoint: verified, source };
    return { state: "ready", source, release, generation };
  }

  private async stageVerifyHealthActivate(
    release: ComputerUseHostRelease,
    source: ComputerUseHostSource,
    remote: boolean,
    signal?: AbortSignal,
  ): Promise<ComputerUseHostState> {
    if (!this.releaseShapeIsAllowed(release)) return releaseFailure(release, "host_release_invalid");
    const priorActive = await this.options.storage.readRecord("active");
    const priorRollback = await this.options.storage.readRecord("rollback");
    const durableRecords = [priorActive, priorRollback].filter((record): record is ComputerUseHostRecord => record !== null);
    const floor = durableRecords
      .sort((left, right) => compareVersion(right.version, left.version))[0];
    if (floor !== undefined) {
      const order = compareVersion(release.version, floor.version);
      // The sealed bundle and the official catalogue intentionally package the
      // same Host version differently (bare Mach-O versus tar.gz), so their
      // archive digests cannot match. Permit that one bundled -> managed
      // transition. Once any managed record exists at this version, retain the
      // anti-equivocation rule and reject a different same-version payload.
      const conflictsWithManagedRelease = durableRecords.some((record) => record.source === "managed"
        && compareVersion(release.version, record.version) === 0
        && !sameHex(release.archive.sha256, record.archiveSha256));
      if (order < 0 || conflictsWithManagedRelease) {
        return releaseFailure(release, "host_release_invalid");
      }
      if (priorActive !== null && releaseMatchesRecord(release, priorActive) && this.active !== null) return this.snapshot();
    }
    let staged: ComputerUseHostStagedArtifact;
    try {
      staged = remote
        ? await this.options.storage.downloadAndStage(release, signal)
        : await this.options.storage.stageBundled(release);
    } catch {
      return releaseFailure(release, "host_archive_invalid");
    }
    const entrypoint = this.verifyStaged(release, staged, signal);
    if (entrypoint === null) return releaseFailure(release, "host_members_invalid");
    let signed = false;
    let healthy = false;
    try {
      signed = await this.options.attestor.verifyMacosRelease(entrypoint, release, this.options.expectedArchitectures, signal);
      healthy = signed && await this.options.attestor.health(entrypoint, release, signal);
    } catch { /* attestation and health are mandatory */ }
    if (!signed) return releaseFailure(release, "host_signature_invalid");
    if (!healthy) return releaseFailure(release, "host_health_failed");
    try {
      const installed = await this.options.storage.publish(staged, release);
      const installedEntrypoint = this.verifyStaged(release, installed, signal);
      if (installedEntrypoint === null) throw new Error("published release changed");
      const prior = priorActive;
      const generation = Math.max(prior?.generation ?? 0, priorRollback?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("generation exhausted");
      if (prior !== null) await this.options.storage.writeRecord("rollback", prior);
      await this.options.storage.writeRecord("active", recordFor(release, generation, source === "bundled" ? "bundled" : "managed"));
      this.active = { release, generation, entrypoint: installedEntrypoint, source };
      return { state: "ready", source, release, generation };
    } catch {
      return releaseFailure(release, "host_activation_failed");
    }
  }

  private verifyStaged(release: ComputerUseHostRelease, staged: ComputerUseHostStagedArtifact, signal?: AbortSignal): string | null {
    if (signal?.aborted || staged.archiveBytes !== release.archive.bytes || !sameHex(staged.archiveSha256, release.archive.sha256)) return null;
    const expected = new Map(release.members.map((member) => [member.path, member]));
    if (staged.members.length !== expected.size) return null;
    for (const actual of staged.members) {
      const expectedMember = expected.get(actual.path);
      if (expectedMember === undefined || actual.bytes !== expectedMember.bytes || !sameHex(actual.sha256, expectedMember.sha256)
        || actual.executable !== expectedMember.executable) return null;
    }
    const entry = expected.get(release.entrypoint);
    return entry?.executable === true ? `${staged.root}/${release.entrypoint}` : null;
  }

  private releaseShapeIsAllowed(release: ComputerUseHostRelease): boolean {
    if (release.schemaVersion !== 1 || !RELEASE_ID.test(release.releaseId) || !VERSION.test(release.version)
      || release.pointerUrl !== this.options.officialPointerUrl || (release.archive.format !== "bare" && release.archive.format !== "tar.gz")
      || !Number.isSafeInteger(release.archive.bytes)
      || release.archive.bytes <= 0 || release.archive.bytes > MAX_ARCHIVE_BYTES || !sameHex(release.archive.sha256, release.archive.sha256)
      || !sameHttpsOrigin(release.archive.url, this.options.officialPointerUrl) || release.members.length < 1 || release.members.length > MAX_MEMBERS
      || release.architectures.length !== this.options.expectedArchitectures.length
      || !this.options.expectedArchitectures.every((architecture) => release.architectures.includes(architecture))
      || !release.members.every((member) => this.memberShapeIsAllowed(member))
      || new Set(release.members.map((member) => member.path)).size !== release.members.length
      || !release.members.some((member) => member.path === release.entrypoint && member.executable === true)
      || !/^[A-Z0-9]{10}$/.test(release.signature.teamId)
      || release.signature.notarized !== true || release.signature.designatedRequirement.length < 1) return false;
    return true;
  }

  private memberShapeIsAllowed(member: ComputerUseHostMember): boolean {
    return isSafeMemberPath(member.path) && ![".nautilo-computer-use-host-release", "release.json"].includes(member.path.split("/")[0]!)
      && Number.isSafeInteger(member.bytes) && member.bytes >= 0
      && member.bytes <= MAX_MEMBER_BYTES && sameHex(member.sha256, member.sha256)
      && (member.executable === undefined || member.executable === true);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutation;
    let complete!: () => void;
    this.mutation = new Promise<void>((resolve) => { complete = resolve; });
    await prior.catch(() => undefined);
    try { return await operation(); } finally { complete(); }
  }
}
