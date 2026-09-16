import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import {
  CodexHostError,
  type HostFilesystem,
  type OpaqueHandle,
  type ProfileHome,
  type ProfileIdentity,
  type ProfileHomeRemovalContext,
  type ProfileHomeRemovalFilesystem,
  type ProfileHomeRemovalGate,
} from "./contracts";

const DIRECTORY_MODE = 0o700;
const MARKER_MODE = 0o600;
const MARKER_NAME = ".nautilo-codex-profile.json";

interface HomeRecord { readonly home: ProfileHome; readonly path: string; }
interface HomeMarker {
  readonly schemaVersion: 1;
  readonly actorId: string;
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly homeIdentityFingerprint: string;
}

export interface ProfileHomeRegistryOptions {
  readonly rootPath: string;
  readonly trustedParentPath: string;
  readonly filesystem: HostFilesystem;
  readonly currentUid: () => number;
  /** Optional until profile-removal orchestration is wired; never a general fs port. */
  readonly removalFilesystem?: ProfileHomeRemovalFilesystem | undefined;
}

/** Private CODEX_HOME allocation, not an OS sandbox or same-UID confidentiality claim. */
export class CodexProfileHomeRegistry {
  private readonly homes = new Map<OpaqueHandle, HomeRecord>();

  constructor(private readonly options: ProfileHomeRegistryOptions) {}

  async ensure(identity: ProfileIdentity): Promise<ProfileHome> {
    const parent = await this.verifyExistingDirectory(this.options.trustedParentPath, undefined);
    if (dirname(this.options.rootPath) !== parent.path) throw invalid("Profile root must be an immediate child of its trusted parent");
    const root = await this.ensureSecureDirectory(this.options.rootPath, parent.path, false);
    const path = resolve(root.path, digestSegment(identity));
    if (!isWithin(root.path, path)) throw invalid("Derived profile home escaped its root");
    const stat = await this.ensureSecureDirectory(path, root.path, false);
    const fingerprint = identityFingerprint(stat.dev, stat.ino);
    const markerPath = resolve(path, MARKER_NAME);
    await this.ensureMarker(markerPath, identity, fingerprint);
    const home: ProfileHome = Object.freeze({
      identity,
      handle: (`profile-home:${digestSegment(identity)}`) as OpaqueHandle,
      identityFingerprint: fingerprint,
    });
    this.homes.set(home.handle, { home, path });
    return home;
  }

  async resolveForLaunch(home: ProfileHome): Promise<string> {
    const known = this.homes.get(home.handle);
    if (!known || !sameHome(known.home, home)) throw invalid("Profile home handle is unknown or altered");
    const parent = await this.verifyExistingDirectory(this.options.trustedParentPath, undefined);
    if (dirname(this.options.rootPath) !== parent.path) throw invalid("Profile root must be an immediate child of its trusted parent");
    const root = await this.ensureSecureDirectory(this.options.rootPath, parent.path, false);
    const stat = await this.verifyExistingDirectory(known.path, root.path);
    const fingerprint = identityFingerprint(stat.dev, stat.ino);
    if (fingerprint !== home.identityFingerprint) throw invalid("Profile home identity changed");
    await this.assertMarker(resolve(known.path, MARKER_NAME), home.identity, fingerprint);
    return known.path;
  }

  async resolveRootForSafety(): Promise<string> {
    const parent = await this.verifyExistingDirectory(this.options.trustedParentPath, undefined);
    if (dirname(this.options.rootPath) !== parent.path) throw invalid("Profile root must be an immediate child of its trusted parent");
    return (await this.ensureSecureDirectory(this.options.rootPath, parent.path, false)).path;
  }

  /**
   * Deletes only an exact registry-owned, marker-and-identity revalidated home
   * after the removal coordinator has drained its exact profile child. Runtime
   * and service directories are neither accepted nor derivable here.
   */
  async removeAfterDrain(home: ProfileHome, context: ProfileHomeRemovalContext, gate: ProfileHomeRemovalGate): Promise<void> {
    const removal = this.options.removalFilesystem;
    if (!removal) throw invalid("Profile home removal is unavailable");
    const known = this.homes.get(home.handle);
    if (!known || !sameHome(known.home, home)) throw invalid("Profile home handle is unknown or altered");
    if (!sameProfile(context.drainedChild.profile, home.identity)) throw invalid("Drain authority belongs to another profile generation");
    await gate.assertDrained(context.drainedChild);
    const parent = await this.verifyExistingDirectory(this.options.trustedParentPath, undefined);
    if (dirname(this.options.rootPath) !== parent.path) throw invalid("Profile root must be an immediate child of its trusted parent");
    const root = await this.ensureSecureDirectory(this.options.rootPath, parent.path, false);
    if (!isWithin(root.path, known.path) || known.path === root.path) throw invalid("Profile home escaped its root");
    const stat = await this.verifyExistingDirectory(known.path, root.path);
    const fingerprint = identityFingerprint(stat.dev, stat.ino);
    if (fingerprint !== home.identityFingerprint) throw invalid("Profile home identity changed");
    await this.assertMarker(resolve(known.path, MARKER_NAME), home.identity, fingerprint);
    for (const protectedPath of [context.serviceDirectoryPath, ...context.runtimeCanonicalPaths]) {
      if (!protectedPath || resolve(protectedPath) !== protectedPath || overlaps(known.path, protectedPath)) throw invalid("Profile home overlaps protected host storage");
    }
    // A custom removal adapter is trusted only with a revocable capability,
    // never with authority to unregister the home by merely returning. It
    // must make the explicit synchronous commit while this exact gate holds.
    let committed = false;
    await removal.removeOwnedProfileHome({
      path: known.path,
      containmentRoot: root.path,
      expectedDevice: stat.dev,
      expectedInode: stat.ino,
      expectedIdentity: home.identity,
      expectedIdentityFingerprint: fingerprint,
      markerName: MARKER_NAME,
      expectedMarker: {
        schemaVersion: 1,
        actorId: home.identity.actorId,
        profileHandle: home.identity.profileHandle,
        profileGeneration: home.identity.profileGeneration,
        homeIdentityFingerprint: fingerprint,
      },
      assertAuthorized: async () => { await gate.assertDrained(context.drainedChild); },
      assertAuthorizedNow: () => { gate.assertDrainedNow(context.drainedChild); },
      commitDestruction: () => {
        if (committed) throw invalid("Profile home deletion committed more than once");
        gate.assertDrainedNow(context.drainedChild);
        gate.commitDestruction();
        committed = true;
      },
    });
    if (!committed) throw invalid("Profile home deletion adapter returned without committing");
    await gate.assertDrained(context.drainedChild);
    this.homes.delete(home.handle);
  }

  /** Never chmods a pre-existing path: verify first, or fail closed. */
  private async ensureSecureDirectory(path: string, containmentRoot: string | undefined, recursive: boolean): Promise<{ readonly path: string; readonly dev: number; readonly ino: number }> {
    try {
      return await this.verifyExistingDirectory(path, containmentRoot);
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof CodexHostError) throw error;
        throw invalid("Profile directory is unavailable");
      }
    }
    const created = await this.options.filesystem.mkdir(path, { recursive, mode: DIRECTORY_MODE });
    // A racing creator is pre-existing from our security perspective. Do not chmod it.
    const stat = await this.verifyNewDirectory(path, containmentRoot);
    if (created) return this.verifyExistingDirectory(path, containmentRoot);
    return stat;
  }

  private async verifyNewDirectory(path: string, containmentRoot: string | undefined): Promise<{ readonly path: string; readonly dev: number; readonly ino: number }> {
    const lstat = await this.options.filesystem.lstat(path);
    if (lstat.isSymbolicLink) throw invalid("New profile directory is a symlink");
    const real = await this.options.filesystem.realpath(path);
    const stat = await this.options.filesystem.stat(real);
    if (lstat.isSymbolicLink || stat.isSymbolicLink || !stat.isDirectory || stat.uid !== this.options.currentUid() || (stat.mode & 0o077) !== 0 || real !== path || (containmentRoot !== undefined && !isWithin(containmentRoot, real))) {
      throw invalid("New profile directory is unsafe");
    }
    return { path: real, dev: stat.dev, ino: stat.ino };
  }

  private async verifyExistingDirectory(path: string, containmentRoot: string | undefined): Promise<{ readonly path: string; readonly dev: number; readonly ino: number }> {
    const lstat = await this.options.filesystem.lstat(path);
    if (lstat.isSymbolicLink) throw invalid("Profile directory is a symlink");
    const real = await this.options.filesystem.realpath(path);
    const stat = await this.options.filesystem.stat(real);
    if (lstat.isSymbolicLink || stat.isSymbolicLink || !stat.isDirectory || stat.uid !== this.options.currentUid() || (stat.mode & 0o077) !== 0 || real !== path || (containmentRoot !== undefined && !isWithin(containmentRoot, real))) {
      throw invalid("Profile directory must be an owner-only non-symlink directory");
    }
    return { path: real, dev: stat.dev, ino: stat.ino };
  }

  private async ensureMarker(path: string, identity: ProfileIdentity, fingerprint: string): Promise<void> {
    const marker: HomeMarker = { schemaVersion: 1, actorId: identity.actorId, profileHandle: identity.profileHandle, profileGeneration: identity.profileGeneration, homeIdentityFingerprint: fingerprint };
    try {
      await this.options.filesystem.writeFile(path, JSON.stringify(marker), { mode: MARKER_MODE, flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw invalid("Could not create profile home marker");
      const current = await this.readMarker(path, identity, fingerprint);
      if (current.profileGeneration > identity.profileGeneration) throw invalid("Profile home marker generation moved backward");
      if (current.profileGeneration < identity.profileGeneration) await this.replaceMarker(path, marker);
    }
  }
  private async replaceMarker(path: string, marker: HomeMarker): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    await this.options.filesystem.writeFile(temp, JSON.stringify(marker), { mode: MARKER_MODE, flag: "wx" });
    const stat = await this.options.filesystem.lstat(temp);
    if (stat.isSymbolicLink || stat.uid !== this.options.currentUid() || (stat.mode & 0o077) !== 0) throw invalid("Profile marker upgrade temp is unsafe");
    await this.options.filesystem.rename(temp, path);
    await this.readMarker(path, { actorId: marker.actorId, profileHandle: marker.profileHandle as OpaqueHandle, profileGeneration: marker.profileGeneration }, marker.homeIdentityFingerprint);
  }

  private async assertMarker(path: string, identity: ProfileIdentity, fingerprint: string): Promise<void> {
    try {
      const marker = await this.readMarker(path, identity, fingerprint);
      if (marker.schemaVersion !== 1 || marker.actorId !== identity.actorId || marker.profileHandle !== identity.profileHandle || marker.profileGeneration !== identity.profileGeneration || marker.homeIdentityFingerprint !== fingerprint) throw invalid("Profile home marker belongs to another profile");
    } catch (error) {
      if (error instanceof CodexHostError) throw error;
      throw invalid("Profile home marker is unavailable");
    }
  }
  private async readMarker(path: string, identity: ProfileIdentity, fingerprint: string): Promise<HomeMarker> {
    const stat = await this.options.filesystem.lstat(path);
    if (stat.isSymbolicLink || stat.uid !== this.options.currentUid() || (stat.mode & 0o077) !== 0) throw invalid("Profile home marker is unsafe");
    const marker = JSON.parse(await this.options.filesystem.readFile(path)) as Partial<HomeMarker>;
    if (marker.schemaVersion !== 1 || marker.actorId !== identity.actorId || marker.profileHandle !== identity.profileHandle || marker.homeIdentityFingerprint !== fingerprint || typeof marker.profileGeneration !== "number") throw invalid("Profile home marker belongs to another profile");
    return marker as HomeMarker;
  }
}

function digestSegment(identity: ProfileIdentity): string {
  return createHash("sha256").update(identity.actorId).update("\u0000").update(identity.profileHandle).digest("hex");
}
function identityFingerprint(dev: number, ino: number): string { return createHash("sha256").update(`${dev}:${ino}`).digest("hex"); }
function isWithin(root: string, path: string): boolean { return root === sep ? path.startsWith(sep) : path === root || path.startsWith(`${root}${sep}`); }
function sameHome(left: ProfileHome, right: ProfileHome): boolean { return left.handle === right.handle && left.identityFingerprint === right.identityFingerprint && left.identity.actorId === right.identity.actorId && left.identity.profileHandle === right.identity.profileHandle && left.identity.profileGeneration === right.identity.profileGeneration; }
function sameProfile(left: ProfileIdentity, right: ProfileIdentity): boolean { return left.actorId === right.actorId && left.profileHandle === right.profileHandle && left.profileGeneration === right.profileGeneration; }
function overlaps(left: string, right: string): boolean { return left === right || isWithin(left, right) || isWithin(right, left); }
function isMissing(error: unknown): boolean { return code(error) === "ENOENT"; }
function isAlreadyExists(error: unknown): boolean { return code(error) === "EEXIST"; }
function code(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : undefined; }
function invalid(message: string): CodexHostError { return new CodexHostError("PROFILE_HOME_INVALID", message); }
