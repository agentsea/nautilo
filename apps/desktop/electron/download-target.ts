import path from "node:path";

/**
 * Reduce an OS-suggested download filename to a safe basename: strip any
 * directory components, replace path-hostile / control characters, drop a
 * leading-dot "hidden file" prefix, and fall back to "download" when nothing
 * usable remains. Pure — no fs access.
 */
export function sanitizeDownloadFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "download";
}

/**
 * Resolve a non-colliding absolute save path for `filename` inside `dir`.
 * `exists` reports whether a candidate absolute path is already taken; on a
 * collision we insert " (n)" before the extension (n = 1, 2, …). Pure apart
 * from the injected `exists` probe, so it is fully unit-testable.
 */
export function resolveDownloadTarget(
  dir: string,
  filename: string,
  exists: (candidate: string) => boolean,
): string {
  const safe = sanitizeDownloadFilename(filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = path.join(dir, safe);
  let n = 1;
  while (exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}
