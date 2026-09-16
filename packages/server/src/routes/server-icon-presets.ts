import { join } from "node:path";
import {
  LEGACY_SERVER_ICON_PRESET_ID,
  SERVER_ICON_PRESET_IDS,
  type ServerIconPresetId,
} from "@nautilo/types";

export const PRESET_IDS = SERVER_ICON_PRESET_IDS;

const presetIds = new Set<string>(PRESET_IDS);
const LEGACY_ALIAS_TARGET: ServerIconPresetId = "preset-orbit";

/**
 * Resolve only canonical preset IDs plus the serving-only legacy alias.
 * Unknown values fail closed instead of becoming filesystem path segments.
 */
export function presetAssetPath(id: string): string | null {
  const resolvedId =
    id === LEGACY_SERVER_ICON_PRESET_ID
      ? LEGACY_ALIAS_TARGET
      : presetIds.has(id)
        ? (id as ServerIconPresetId)
        : null;
  return resolvedId
    ? join(import.meta.dir, "..", "onboarding", "images", "server", `${resolvedId}.png`)
    : null;
}
