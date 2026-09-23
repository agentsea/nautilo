import { expect, mock, test } from "bun:test";
import { assertConnectedAppExecutionFunding } from "../../src/connected-apps/funding-admission";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";

test("hosted connected-app execution charges the initiating Human before dispatch", async () => {
  const assertServerFunding = mock(async (_humanUserId: string, _origin?: string) => {});
  await assertConnectedAppExecutionFunding({
    hosted: true, causalHumanUserId: "caller",
  }, assertServerFunding);
  expect(assertServerFunding).toHaveBeenCalledWith("caller", "connected_app_execute");
  await assertConnectedAppExecutionFunding({
    hosted: false, causalHumanUserId: "",
  }, assertServerFunding);
  expect(assertServerFunding).toHaveBeenCalledTimes(1);
});

test("hosted execution without an exact causal Human fails before capability lookup", async () => {
  const assertServerFunding = mock(async (_humanUserId: string, _origin?: string) => {});
  const error = await assertConnectedAppExecutionFunding({
    hosted: true,
    causalHumanUserId: "",
  }, assertServerFunding).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServerProviderCredentialsDeniedError);
  expect(error).toMatchObject({
    code: "server_provider_credentials_required",
    humanUserId: "",
    origin: "connected_app_execute",
  });
  expect(assertServerFunding).not.toHaveBeenCalled();
});
