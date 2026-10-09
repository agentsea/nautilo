import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
} from "@nautilo/trust";
import { getCapabilityFundingSession } from "@nautilo/agent";

/** Local OpenConnector uses the connected account; hosted execution spends the instance key. */
export async function assertConnectedAppExecutionFunding(
  input: { hosted: boolean; causalHumanUserId: string },
  assertServerFunding: typeof assertCanUseServerProviderCredentials = assertCanUseServerProviderCredentials,
): Promise<void> {
  if (input.hosted) {
    if (!input.causalHumanUserId.trim()) {
      throw new ServerProviderCredentialsDeniedError("", "connected_app_execute");
    }
    const capabilityFunding = getCapabilityFundingSession();
    if (capabilityFunding && capabilityFunding.humanUserId !== input.causalHumanUserId) {
      throw new ServerProviderCredentialsDeniedError(
        input.causalHumanUserId,
        "connected_app_execute",
      );
    }
    await assertServerFunding(input.causalHumanUserId, "connected_app_execute");
  }
}
