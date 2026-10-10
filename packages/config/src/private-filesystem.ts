import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Windows has no POSIX owner/mode bits. Use the OS security descriptor, from
// both Bun and Node/Electron, without adding a runtime-specific native addon.
// Paths and file contents travel only over stdin, never through shell text.
const WINDOWS_PRIVATE_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($null -ne ($requestLine = [Console]::ReadLine())) {
try {
  $request = $requestLine | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $path = [string]$request.path
  $operation = [string]$request.operation
  $directory = [bool]$request.directory
  if ($directory) {
    $item = [System.IO.DirectoryInfo]::new($path)
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    $item = [System.IO.FileInfo]::new($path)
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  if ($operation -in @('create', 'protect')) {
    # Restricting an existing DACL must not request WRITE_OWNER privileges.
    if ($operation -eq 'create') { $security.SetOwner($sid) }
    $security.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
    if ($operation -eq 'protect') {
      $attributes = [System.IO.File]::GetAttributes($path)
      if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
      $existing = [System.IO.FileSystemAclExtensions]::GetAccessControl($item)
      if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Foreign owner' }
      [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
    } elseif ($directory) {
      # DirectoryInfo.Create accepts an existing directory. A lock requires
      # exclusive creation with its protected DACL already in place.
      if (-not ('NautiloPrivateDirectory' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NautiloPrivateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int length;
    public IntPtr descriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool inherit;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
  public static int Create(string path, byte[] descriptor) {
    var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var attributes = new SecurityAttributes {
        length=Marshal.SizeOf<SecurityAttributes>(), descriptor=pinned.AddrOfPinnedObject(), inherit=false
      };
      return CreateDirectoryW(path, ref attributes) ? 0 : Marshal.GetLastWin32Error();
    } finally { pinned.Free(); }
  }
}
'@
      }
      $errorCode = [NautiloPrivateDirectory]::Create($path, $security.GetSecurityDescriptorBinaryForm())
      if ($errorCode -ne 0) {
        $code = if ($errorCode -in @(80,183)) { 'EEXIST' } elseif ($errorCode -in @(2,3)) { 'ENOENT' } else { 'EACCES' }
        [Console]::Out.WriteLine((@{ok=$false;code=$code} | ConvertTo-Json -Compress))
        continue
      }
    } else {
      $stream = [System.IO.FileSystemAclExtensions]::Create($item,
        [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough, $security)
      try {
        $bytes = [Convert]::FromBase64String([string]$request.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
      } catch {
        $stream.Dispose()
        [System.IO.File]::Delete($path)
        throw
      } finally { $stream.Dispose() }
    }
    $item.Refresh()
  }
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      (([bool]($attributes -band [System.IO.FileAttributes]::Directory)) -ne $directory)) {
    throw 'Path must be an existing non-reparse file or directory'
  }
  $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($item)
  $owned = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
  $private = $owned
  $controlled = $owned
  $mutationRights = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  $hasOwnerAccess = $false
  foreach ($entry in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($entry.IdentityReference.Value -eq $sid.Value) { $hasOwnerAccess = $true }
    # SYSTEM and local Administrators already have OS-level recovery authority.
    if ($entry.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $private = $false
      if ($entry.FileSystemRights -band $mutationRights) { $controlled = $false }
    }
  }
  [Console]::Out.WriteLine((@{ok=$true;owned=$owned;controlled=$controlled;private=($private -and $hasOwnerAccess)} | ConvertTo-Json -Compress))
} catch {
  $nativeCode = $_.Exception.GetBaseException().HResult -band 65535
  $code = if ($nativeCode -in @(80,183)) { 'EEXIST' } elseif ($nativeCode -in @(2,3)) { 'ENOENT' } else { 'EACCES' }
  [Console]::Out.WriteLine((@{ok=$false;code=$code} | ConvertTo-Json -Compress))
}
}
`;

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("Private filesystem operation failed"), { code });
}

function windowsRequest(operation: "check" | "create" | "protect", path: string, directory: boolean, contents?: Uint8Array) {
  const programFiles = process.env["ProgramW6432"] ?? process.env["ProgramFiles"] ?? "C:\\Program Files";
  const powershell = join(programFiles, "PowerShell", "7", "pwsh.exe");
  const inherited = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "PROGRAMDATA"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toUpperCase())));
  return { powershell,
    env: { ...env, NODE_ENV: "production" as const, POWERSHELL_TELEMETRY_OPTOUT: "1" },
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_PRIVATE_PATH_SCRIPT, "utf16le").toString("base64")],
    input: JSON.stringify({ operation, path, directory, contents: contents === undefined ? "" : Buffer.from(contents).toString("base64") }) + "\n",
  };
}

type WindowsPathSecurity = { readonly owned: boolean; readonly private: boolean; readonly controlled: boolean };

function parseWindowsResponse(stdout: string): WindowsPathSecurity {
  let response: unknown;
  try { response = JSON.parse(stdout); } catch { throw failure("EACCES"); }
  if (typeof response !== "object" || response === null) throw failure("EACCES");
  if (!("ok" in response) || response.ok !== true) {
    const code = "code" in response && ["EEXIST", "ENOENT"].includes(String(response.code)) ? String(response.code) : "EACCES";
    throw failure(code);
  }
  return {
    owned: "owned" in response && response.owned === true,
    private: "private" in response && response.private === true,
    controlled: "controlled" in response && response.controlled === true,
  };
}

function windowsPathSecurity(operation: "check" | "create" | "protect", path: string, directory: boolean, contents?: Uint8Array): WindowsPathSecurity {
  const request = windowsRequest(operation, path, directory, contents);
  const result = spawnSync(request.powershell, request.args, { input: request.input, env: request.env, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw failure("EACCES");
  return parseWindowsResponse(result.stdout);
}

// Reuse the interpreter across adjacent async filesystem calls. This is an
// idle resource grace period, never a deadline for an in-flight operation.
const WINDOWS_HELPER_IDLE_MS = 250;
type PendingWindowsRequest = { resolve(value: WindowsPathSecurity): void; reject(error: unknown): void };
type WindowsWorker = {
  readonly key: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: PendingWindowsRequest[];
  buffer: string;
  idle: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
};
let windowsWorker: WindowsWorker | undefined;

function stopWindowsWorker(worker: WindowsWorker, failed: boolean): void {
  if (worker.stopped || (!failed && worker.pending.length !== 0)) return;
  worker.stopped = true;
  clearTimeout(worker.idle);
  if (windowsWorker === worker) windowsWorker = undefined;
  for (const pending of worker.pending.splice(0)) pending.reject(failure("EACCES"));
  worker.child.stdin.end();
  if (failed) worker.child.kill();
}

function getWindowsWorker(request: ReturnType<typeof windowsRequest>): WindowsWorker {
  const key = JSON.stringify([request.powershell, request.env]);
  if (windowsWorker?.key === key && !windowsWorker.stopped) return windowsWorker;
  const child = spawn(request.powershell, request.args, {
    env: request.env, windowsHide: true, stdio: "pipe",
  });
  const worker: WindowsWorker = { key, child, pending: [], buffer: "", idle: undefined, stopped: false };
  windowsWorker = worker;
  child.stderr.resume();
  child.stdin.on("error", () => stopWindowsWorker(worker, true));
  child.stdin.on("close", () => stopWindowsWorker(worker, true));
  child.stdout.on("error", () => stopWindowsWorker(worker, true));
  child.stdout.on("end", () => stopWindowsWorker(worker, true));
  child.stdout.on("close", () => stopWindowsWorker(worker, true));
  child.stderr.on("error", () => stopWindowsWorker(worker, true));
  child.on("error", () => stopWindowsWorker(worker, true));
  child.on("close", () => stopWindowsWorker(worker, true));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (worker.stopped) return;
    worker.buffer += chunk;
    let newline: number;
    while ((newline = worker.buffer.indexOf("\n")) !== -1) {
      const line = worker.buffer.slice(0, newline);
      worker.buffer = worker.buffer.slice(newline + 1);
      const pending = worker.pending.shift();
      if (!pending) { stopWindowsWorker(worker, true); return; }
      try { pending.resolve(parseWindowsResponse(line)); }
      catch (error) { pending.reject(error); }
    }
    if (worker.pending.length === 0) {
      worker.idle = setTimeout(() => stopWindowsWorker(worker, false), WINDOWS_HELPER_IDLE_MS);
    }
  });
  return worker;
}

async function windowsPathSecurityAsync(operation: "check" | "create" | "protect", path: string, directory: boolean, contents?: Uint8Array): Promise<WindowsPathSecurity> {
  const request = windowsRequest(operation, path, directory, contents);
  const worker = getWindowsWorker(request);
  clearTimeout(worker.idle);
  return new Promise<WindowsPathSecurity>((resolve, reject) => {
    worker.pending.push({ resolve, reject });
    try { worker.child.stdin.write(request.input); }
    catch { stopWindowsWorker(worker, true); }
  });
}

/** Verify the current owner's private file/directory, rejecting symbolic links. */
export function isPrivateFilesystemPath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const details = lstatSync(path);
  if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) return false;
  if (process.platform === "win32") return windowsPathSecurity("check", path, details.isDirectory()).private;
  return details.uid === process.getuid?.() && (details.mode & 0o077) === 0;
}

export async function isPrivateFilesystemPathAsync(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  const details = await lstat(path);
  if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) return false;
  if (process.platform === "win32") return (await windowsPathSecurityAsync("check", path, details.isDirectory())).private;
  return details.uid === process.getuid?.() && (details.mode & 0o077) === 0;
}

/** Verify ownership without requiring a non-secret managed path to be private. */
export async function isOwnedFilesystemPathAsync(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  const details = await lstat(path);
  if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) return false;
  if (process.platform === "win32") return (await windowsPathSecurityAsync("check", path, details.isDirectory())).owned;
  return details.uid === process.getuid?.();
}

/** An owned parent may permit other readers, but must not permit other writers. */
export async function isOwnerControlledFilesystemPath(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  const details = await lstat(path);
  if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) return false;
  if (process.platform === "win32") return (await windowsPathSecurityAsync("check", path, details.isDirectory())).controlled;
  return details.uid === process.getuid?.() && (details.mode & 0o022) === 0;
}

/** Restrict a managed path owned by the current user; never follow a symlink. */
export function secureFilesystemPathSync(path: string): void {
  if (!isAbsolute(path)) throw failure("EINVAL");
  const details = lstatSync(path);
  if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) throw failure("EACCES");
  if (process.platform === "win32") {
    if (!windowsPathSecurity("protect", path, details.isDirectory()).private) throw failure("EACCES");
  } else {
    if (details.uid !== process.getuid?.()) throw failure("EACCES");
    chmodSync(path, details.isDirectory() ? 0o700 : 0o600);
  }
}

/** Async counterpart that does not block the event loop on the Windows helper. */
export async function secureFilesystemPath(path: string): Promise<void> {
  if (!isAbsolute(path)) throw failure("EINVAL");
  const details = await lstat(path);
  if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) throw failure("EACCES");
  if (process.platform === "win32") {
    if (!(await windowsPathSecurityAsync("protect", path, details.isDirectory())).private) throw failure("EACCES");
  } else {
    if (details.uid !== process.getuid?.()) throw failure("EACCES");
    await chmod(path, details.isDirectory() ? 0o700 : 0o600);
  }
}

/** Exclusive creation: no existing directory is adopted or given new ACLs. */
export function createPrivateDirectorySync(path: string): void {
  if (!isAbsolute(path)) throw failure("EINVAL");
  if (process.platform !== "win32") { mkdirSync(path, { mode: 0o700 }); return; }
  if (existsSync(path)) throw failure("EEXIST");
  if (!windowsPathSecurity("create", path, true).private) throw failure("EACCES");
}

export async function createPrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw failure("EINVAL");
  if (process.platform === "win32") {
    if (!(await windowsPathSecurityAsync("create", path, true)).private) throw failure("EACCES");
  } else await mkdir(path, { mode: 0o700 });
}

/** Create missing managed directories privately without changing existing ancestors. */
function missingDirectories(path: string): string[] {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw failure("ENOENT");
    current = parent;
  }
  return missing.reverse();
}

export function ensurePrivateDirectorySync(path: string): void {
  if (!isAbsolute(path)) throw failure("EINVAL");
  const missing = missingDirectories(path);
  for (const directory of missing) {
    try { createPrivateDirectorySync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isPrivateFilesystemPath(directory)) throw error;
    }
  }
  if (!lstatSync(path).isDirectory()) throw failure("ENOTDIR");
  if (missing.length === 0) secureFilesystemPathSync(path);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw failure("EINVAL");
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try { await lstat(current); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw failure("ENOENT");
    current = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      await createPrivateDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) throw error;
      const privateDirectory = process.platform === "win32"
        ? (await windowsPathSecurityAsync("check", directory, true)).private
        : details.uid === process.getuid?.() && (details.mode & 0o077) === 0;
      if (!privateDirectory) throw error;
    }
  }
  if (!(await lstat(path)).isDirectory()) throw failure("ENOTDIR");
  if (missing.length === 0) await secureFilesystemPath(path);
}

/** Create, write, and fsync an owner-private file without an ACL exposure window. */
export function writePrivateFileExclusiveSync(path: string, contents: Uint8Array): void {
  if (!isAbsolute(path)) throw failure("EINVAL");
  if (process.platform === "win32") {
    if (!windowsPathSecurity("create", path, false, contents).private) throw failure("EACCES");
    return;
  }
  const fd = openSync(path, "wx", 0o600);
  let complete = false;
  try { writeFileSync(fd, contents); fsyncSync(fd); complete = true; }
  finally { closeSync(fd); if (!complete) unlinkSync(path); }
}

/** The asynchronous writer keeps credential persistence off the event loop. */
export async function writePrivateFileExclusive(path: string, contents: Uint8Array): Promise<void> {
  if (!isAbsolute(path)) throw failure("EINVAL");
  if (process.platform === "win32") {
    if (!(await windowsPathSecurityAsync("create", path, false, contents)).private) throw failure("EACCES");
    return;
  }
  const file = await open(path, "wx", 0o600);
  let complete = false;
  try { await file.writeFile(contents); await file.sync(); complete = true; }
  finally { await file.close(); if (!complete) await unlink(path); }
}

/** A sibling in the target directory keeps the final rename on one filesystem. */
function temporarySibling(target: string): string {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
}

export interface PublishPrivateFileOptions {
  /**
   * Runs once the private temporary file is durable and before it replaces
   * the target. Throwing aborts the publication and removes the temporary file.
   */
  readonly beforePublish?: () => void | Promise<void>;
}

/**
 * Replace `target` atomically with owner-private bytes. A relative target is
 * anchored once, so the temporary file and the published path share one
 * directory. The parent directory must already exist.
 */
export async function publishPrivateFileAtomically(target: string, contents: Uint8Array, options: PublishPrivateFileOptions = {}): Promise<void> {
  const destination = resolve(target);
  const temporary = temporarySibling(destination);
  await writePrivateFileExclusive(temporary, contents);
  try {
    await options.beforePublish?.();
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function publishPrivateFileAtomicallySync(target: string, contents: Uint8Array): void {
  const destination = resolve(target);
  const temporary = temporarySibling(destination);
  writePrivateFileExclusiveSync(temporary, contents);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the publication error. */ }
    throw error;
  }
}

/**
 * Persist a directory entry change after a rename or link. Node and Bun cannot
 * flush a Windows directory handle; the file itself was already flushed, so
 * only that refusal is tolerated.
 */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}
