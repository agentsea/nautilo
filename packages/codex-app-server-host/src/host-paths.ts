import { isAbsolute, relative, sep } from "node:path";

/** Native filesystem containment, including drive roots and sibling prefixes. */
export function containsHostPath(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
