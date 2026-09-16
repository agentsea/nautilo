import {
  createOwnerClaimBrowserHandoff, OwnerClaimHandoffError, type OwnerClaimBrowserHandoff,
} from "./owner-claim-handoff.ts";
import type { ServerFinishMode } from "./server-completion.ts";

export type RailwayOwnerClaimBrowserHandoff = OwnerClaimBrowserHandoff;
function railwayTargetUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("Railway owner handoff target is invalid");
  return url;
}
export async function createRailwayOwnerClaimBrowserHandoff(input: {
  readonly targetUrl: string; readonly claim: string; readonly finish: ServerFinishMode; readonly nonce?: string;
}): Promise<RailwayOwnerClaimBrowserHandoff> {
  railwayTargetUrl(input.targetUrl);
  if (!/^inv_[A-Za-z0-9_-]{32}$/.test(input.claim)) throw new Error("Railway owner handoff claim is invalid");
  if (input.nonce !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(input.nonce)) throw new Error("Railway owner handoff nonce is invalid");
  try {
    return await createOwnerClaimBrowserHandoff({ ...input, transport: { validateTargetUrl: railwayTargetUrl } });
  } catch (error) {
    if (error instanceof OwnerClaimHandoffError && error.failure === "listener-unavailable") {
      throw new Error("Railway owner handoff listener is unavailable");
    }
    throw error;
  }
}
