import { posix, win32, type PlatformPath } from "node:path";

/** Path syntax belongs to the remote device, not the process reading its wire message. */
export function pathApiForRelayPath(value: string): PlatformPath {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") ? win32 : posix;
}

/** Lexical containment for paths belonging to the same remote filesystem. */
export function isRelayPathWithinRoot(root: string, candidate: string): boolean {
  const paths = pathApiForRelayPath(root);
  if (paths !== pathApiForRelayPath(candidate) || !paths.isAbsolute(root) || !paths.isAbsolute(candidate)) return false;
  const child = paths.relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${paths.sep}`) && !paths.isAbsolute(child);
}
