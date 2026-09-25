/** Shared existing Admin directory page policy. */
export function normalizeAdminDirectoryLimit(raw: number | string | undefined): number | null {
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 50;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return null;
  return parsed;
}
