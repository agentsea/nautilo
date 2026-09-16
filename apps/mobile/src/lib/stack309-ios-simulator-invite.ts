/**
 * Stack 309 local iOS-Simulator acceptance-only invite custody.
 *
 * This is intentionally a tiny transport seam, not another invite parser:
 * the staged locator is accepted only through the normal InviteIntake path,
 * which commits SecureStore custody before navigation.  The caller gates it
 * behind __DEV__, iOS, and the Simulator; release and physical devices never
 * invoke it.
 */
import { parseDeepLink } from "@/lib/deep-link";
import type { InviteIntakeResult } from "@/features/invite-redemption/invite-intake";

export const STACK309_IOS_SIMULATOR_STAGED_INVITE = ".stack309-invite.staged";
const STACK309_IOS_SIMULATOR_MAX_LOCATOR_BYTES = 8_192;

export type Stack309StagedInviteFile = Readonly<{
  readonly exists: boolean;
  text(): Promise<string>;
  delete(): void;
}>;

export type Stack309InviteStagingOutcome = "none" | "consumed" | "discarded-invalid" | "retained";

/**
 * Read one Simulator-private staged locator and hand it directly to the
 * canonical intake.  The source file remains when SecureStore custody could
 * not commit, so an interrupted app launch can retry safely.  Invalid bytes
 * are deleted because they can never become an invite.
 */
export async function consumeStack309IosSimulatorInvite(
  file: Stack309StagedInviteFile,
  accept: (rawLocator: string) => Promise<InviteIntakeResult>,
): Promise<Stack309InviteStagingOutcome> {
  if (!file.exists) return "none";

  let rawLocator: string;
  try {
    rawLocator = await file.text();
  } catch {
    return "retained";
  }

  if (
    new TextEncoder().encode(rawLocator).byteLength > STACK309_IOS_SIMULATOR_MAX_LOCATOR_BYTES
    || parseDeepLink(rawLocator).kind !== "invite"
  ) {
    try {
      file.delete();
    } catch {
      return "retained";
    }
    return "discarded-invalid";
  }

  let result: InviteIntakeResult;
  try {
    result = await accept(rawLocator);
  } catch {
    return "retained";
  }

  // Both results mean a canonical handoff already owns this exact locator.
  // Any other result must retain the private staged bytes for an explicit
  // restart/retry rather than losing a one-use invite between app launch and
  // durable custody.
  if (result.kind !== "accepted" && result.kind !== "duplicate") return "retained";
  try {
    file.delete();
  } catch {
    // The handoff is safe, but retaining the staged duplicate is preferable
    // to reporting a successful one-shot transfer we could not erase.
    return "retained";
  }
  return "consumed";
}

export function stack309IosSimulatorHarnessEnabled(input: {
  readonly isDevelopment: boolean;
  readonly platform: string;
  readonly isPhysicalDevice: boolean;
}): boolean {
  return input.isDevelopment && input.platform === "ios" && !input.isPhysicalDevice;
}
