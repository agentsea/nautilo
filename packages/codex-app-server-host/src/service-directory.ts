import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import {
  CodexHostError,
  type HostFilesystem,
  type OpaqueHandle,
  type ServiceDirectory,
} from "./contracts";

const DIRECTORY_MODE = 0o700;
const MARKER_MODE = 0o600;
const MARKER_NAME = ".nautilo-codex-service.json";

interface ServiceMarker {
  readonly schemaVersion: 1;
  readonly directoryIdentityFingerprint: string;
}

export interface CodexServiceDirectoryOptions {
  /** Host configuration only; never accepted from relay or browser messages. */
  readonly path: string;
  /** Existing owner-only parent that directly owns path. */
  readonly trustedParentPath: string;
  readonly filesystem: HostFilesystem;
  readonly currentUid: () => number;
}

/**
 * Private account-only cwd for a Codex profile child. This deliberately has no
 * relationship to CODEX_HOME, a runtime install, or the selected workspace.
 */
export class CodexServiceDirectory {
  private directory: ServiceDirectory | undefined;
  private path: string | undefined;
  private ensuring: Promise<ServiceDirectory> | undefined;

  constructor(private readonly options: CodexServiceDirectoryOptions) {}

  async ensure(): Promise<ServiceDirectory> {
    if (this.ensuring) return this.ensuring;
    const work = this.ensureInternal();
    this.ensuring = work;
    try { return await work; }
    finally { if (this.ensuring === work) this.ensuring = undefined; }
  }

  private async ensureInternal(): Promise<ServiceDirectory> {
    const parent = await this.verifyExistingDirectory(this.options.trustedParentPath);
    if (this.options.path === parent.path || dirname(this.options.path) !== parent.path) throw unavailable("Service directory must be an immediate child of its trusted parent");
    const directory = await this.ensureSecureDirectory(this.options.path);
    const fingerprint = identityFingerprint(directory.dev, directory.ino);
    await this.ensureMarker(resolve(directory.path, MARKER_NAME), fingerprint);
    const result: ServiceDirectory = Object.freeze({
      handle: (`codex-service:${fingerprint}`) as OpaqueHandle,
      identityFingerprint: fingerprint,
    });
    this.directory = result;
    this.path = directory.path;
    return result;
  }

  async resolveForLaunch(directory: ServiceDirectory, forbiddenCanonicalPaths: readonly string[]): Promise<string> {
    if (!this.directory || !this.path || directory.handle !== this.directory.handle || directory.identityFingerprint !== this.directory.identityFingerprint) {
      throw unavailable("Service directory handle is unknown or altered");
    }
    const parent = await this.verifyExistingDirectory(this.options.trustedParentPath);
    if (this.options.path === parent.path || dirname(this.options.path) !== parent.path) throw unavailable("Service directory must be an immediate child of its trusted parent");
    const current = await this.verifyExistingDirectory(this.path);
    const fingerprint = identityFingerprint(current.dev, current.ino);
    if (fingerprint !== directory.identityFingerprint) throw unavailable("Service directory identity changed");
    await this.assertMarker(resolve(current.path, MARKER_NAME), fingerprint);
    this.assertDisjoint(current.path, forbiddenCanonicalPaths);
    return current.path;
  }

  /** All inputs must already be host-resolved canonical paths. */
  assertDisjoint(canonicalPath: string, forbiddenCanonicalPaths: readonly string[]): void {
    if (!canonicalPath || resolve(canonicalPath) !== canonicalPath) throw unavailable("Service directory path is not canonical");
    for (const forbidden of forbiddenCanonicalPaths) {
      if (!forbidden || resolve(forbidden) !== forbidden || overlaps(canonicalPath, forbidden)) throw unavailable("Service directory overlaps protected host storage");
    }
  }

  private async ensureSecureDirectory(path: string): Promise<{ readonly path: string; readonly dev: number; readonly ino: number }> {
    try {
      return await this.verifyExistingDirectory(path);
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof CodexHostError) throw error;
        throw unavailable("Service directory is unavailable");
      }
    }
    const created = await this.options.filesystem.mkdir(path, { recursive: false, mode: DIRECTORY_MODE });
    if (!created) throw unavailable("Service directory was concurrently created");
    return this.verifyExistingDirectory(path);
  }

  private async verifyExistingDirectory(path: string): Promise<{ readonly path: string; readonly dev: number; readonly ino: number }> {
    const lstat = await this.options.filesystem.lstat(path);
    if (lstat.isSymbolicLink) throw unavailable("Service directory is a symlink");
    const real = await this.options.filesystem.realpath(path);
    const stat = await this.options.filesystem.stat(real);
    if (lstat.isSymbolicLink || stat.isSymbolicLink || !stat.isDirectory || stat.uid !== this.options.currentUid() || (stat.mode & 0o077) !== 0 || real !== path) {
      throw unavailable("Service directory must be an owner-only non-symlink directory");
    }
    return { path: real, dev: stat.dev, ino: stat.ino };
  }

  private async ensureMarker(path: string, fingerprint: string): Promise<void> {
    const marker: ServiceMarker = { schemaVersion: 1, directoryIdentityFingerprint: fingerprint };
    try {
      await this.options.filesystem.writeFile(path, JSON.stringify(marker), { mode: MARKER_MODE, flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw unavailable("Could not create service directory marker");
      await this.assertMarker(path, fingerprint);
    }
  }

  private async assertMarker(path: string, fingerprint: string): Promise<void> {
    const stat = await this.options.filesystem.lstat(path);
    if (stat.isSymbolicLink || stat.uid !== this.options.currentUid() || (stat.mode & 0o077) !== 0) throw unavailable("Service directory marker is unsafe");
    let marker: Partial<ServiceMarker>;
    try { marker = JSON.parse(await this.options.filesystem.readFile(path)) as Partial<ServiceMarker>; }
    catch { throw unavailable("Service directory marker is unavailable"); }
    if (marker.schemaVersion !== 1 || marker.directoryIdentityFingerprint !== fingerprint) throw unavailable("Service directory marker identity changed");
  }
}

function identityFingerprint(dev: number, ino: number): string { return createHash("sha256").update(`${dev}:${ino}`).digest("hex"); }
function overlaps(left: string, right: string): boolean {
  const relativeLeft = resolve(left);
  const relativeRight = resolve(right);
  return within(relativeLeft, relativeRight) || within(relativeRight, relativeLeft);
}
function within(root: string, candidate: string): boolean { return root === sep ? candidate.startsWith(sep) : candidate === root || candidate.startsWith(`${root}${sep}`); }
function isMissing(error: unknown): boolean { return code(error) === "ENOENT"; }
function isAlreadyExists(error: unknown): boolean { return code(error) === "EEXIST"; }
function code(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : undefined; }
function unavailable(message: string): CodexHostError { return new CodexHostError("SUPERVISOR_UNAVAILABLE", message); }
