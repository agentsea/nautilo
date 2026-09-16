import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveNautiloRuntimePaths } from "@nautilo/config";

/**
 * Version tag embedded in every cached preview filename.
 *
 * Single source of truth for the `voices` route and the `find_voice`
 * agent tool — bumping this invalidates every cached preview in one
 * place instead of requiring a coordinated change across files.
 */
export const VOICE_PREVIEW_SCRIPT_VERSION = "v2";

/**
 * Resolve the on-disk path for the default preview of a voice.
 *
 * Path: `{data/voice-previews}/{voiceId}_{version}.mp3`
 *
 * The data zone (D049) is internal to the server — never exposed to a
 * relay adapter. `resolveNautiloRuntimePaths()` follows the process
 * environment and default `~/.nautilo` instance layout (M071 — no
 * `NAUTILO_HOME` root override).
 */
export function voicePreviewPath(voiceId: string): string {
  return join(
    resolveNautiloRuntimePaths().voiceCacheDir,
    `${voiceId}_${VOICE_PREVIEW_SCRIPT_VERSION}.mp3`,
  );
}

/**
 * Resolve the on-disk path for a custom-text preview of a voice.
 *
 * Content-addressed via a truncated SHA-256 of the custom text so the
 * same (voiceId, text) pair always maps to the same file, enabling
 * cache hits without leaking the plaintext in the filename.
 */
export function voicePreviewPathForCustomText(
  voiceId: string,
  text: string,
): string {
  const hash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
  return join(
    resolveNautiloRuntimePaths().voiceCacheDir,
    `${voiceId}_t_${hash}.mp3`,
  );
}
