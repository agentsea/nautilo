const HERMES_ACP_HARNESS_UNAVAILABLE_GUIDANCE =
  "Hermes is unavailable on a paired Nautilo desktop. Open Nautilo Desktop, finish Hermes setup, then try again.";

const HERMES_ACP_HARNESS_FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  ACP_HARNESS_UNAVAILABLE: HERMES_ACP_HARNESS_UNAVAILABLE_GUIDANCE,
  ACP_SOURCE_FORBIDDEN:
    "Hermes can be used only by the user's own Genie in the active Room.",
  ACP_ROOM_UNAVAILABLE:
    "Hermes needs an active Room with this Genie. Return to the conversation and try again.",
};

/** Fixed fallback for every Hermes-selected failure which is not one of the
 * server's bounded admission codes. It must never reflect a database, relay,
 * path, or other private implementation error back into the conversation. */
export const hermesAcpHarnessUnavailableGuidance =
  HERMES_ACP_HARNESS_UNAVAILABLE_GUIDANCE;

/** Turn the server's bounded Hermes admission failures into safe guidance. */
export function hermesAcpHarnessFailureGuidance(error: unknown): string | null {
  const code = error instanceof Error ? error.message : String(error);
  return HERMES_ACP_HARNESS_FAILURE_GUIDANCE[code] ?? null;
}
