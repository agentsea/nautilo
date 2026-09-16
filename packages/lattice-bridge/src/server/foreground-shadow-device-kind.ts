/**
 * Device kinds that can currently own foreground Shadow-encryption custody.
 *
 * Keep this closed: Mobile and TUI enrollment do not yet implement the
 * foreground Message controller contract.
 */
export type ForegroundShadowDeviceKind = "browser" | "electron";

export function isForegroundShadowDeviceKind(
  value: unknown,
): value is ForegroundShadowDeviceKind {
  return value === "browser" || value === "electron";
}
