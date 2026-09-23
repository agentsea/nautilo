import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
} from "@nautilo/trust";
import { getUsageContext } from "../../../usage/usage-context";

/** Resolve the exact initiating Human from the trusted background usage scope. */
export async function assertDeepResearchServerFunding(origin: string): Promise<void> {
  const humanUserId = getUsageContext()?.userId?.trim() ?? "";
  if (!humanUserId) {
    throw new ServerProviderCredentialsDeniedError("", origin);
  }
  await assertCanUseServerProviderCredentials(humanUserId, origin);
}
