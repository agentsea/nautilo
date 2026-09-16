import type { ComposeDriverProfile } from "./types.ts";

export type HttpsMode = "off" | "letsencrypt";

/**
 * Read the HTTPS mode off a profile. Defaults to "off" so existing
 * pre-M117 profiles (no `https` field) deploy exactly as today.
 *
 * M119 will widen this union to "off" | "internal" | "letsencrypt".
 * Keep the file small — M119's diff should be purely additive.
 */
export function httpsMode(profile: ComposeDriverProfile): HttpsMode {
  return profile.https ?? "off";
}
