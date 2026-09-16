/** Display-only projection for the opaque paired-filesystem directory picker. */
export function pairedFilesystemDisplayPath(relativePath: string, locationLabel?: string): string {
  const segments = relativePath.split("/").filter(Boolean);
  const label = safePairedFilesystemLocationLabel(locationLabel);
  if (segments.length === 0) return label;
  const remainder = segments.slice(1);
  return remainder.length === 0 ? label : `${label} / ${remainder.join(" / ")}`;
}

function safePairedFilesystemLocationLabel(value: string | undefined): string {
  const normalized = typeof value === "string"
    ? [...value].filter((character) => character.codePointAt(0)! >= 0x20).join("").trim().slice(0, 120)
    : "";
  // Direct navigation/deep links can carry a token without the preceding root
  // list. Fall back to a truthful generic label instead of displaying it.
  return normalized && !/^loc_[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "This Mac";
}
