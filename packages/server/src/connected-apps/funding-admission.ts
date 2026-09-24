import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
} from "@nautilo/trust";

/** Local OpenConnector uses the connected account; hosted execution spends the instance key. */
export async function assertConnectedAppExecutionFunding(
  input: { hosted: boolean; causalHumanUserId: string },
  assertServerFunding: typeof assertCanUseServerProviderCredentials = assertCanUseServerProviderCredentials,
): Promise<void> {
  if (input.hosted) {
    if (!input.causalHumanUserId.trim()) {
      throw new ServerProviderCredentialsDeniedError("", "connected_app_execute");
    }
    await assertServerFunding(input.causalHumanUserId, "connected_app_execute");
  }
}
