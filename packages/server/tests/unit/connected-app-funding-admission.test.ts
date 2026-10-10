import { expect, mock, test } from "bun:test";
import { assertConnectedAppExecutionFunding } from "../../src/connected-apps/funding-admission";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import {
  runWithCapabilityFundingSession,
  type CapabilityFundingSession,
} from "@nautilo/agent";

function capabilityFunding(parentFundingKind: "personal" | "server"): CapabilityFundingSession {
  return {
    humanUserId: "caller",
    parentFundingKind,
    async resolveModel() { throw new Error("unused"); },
    async openModel() { throw new Error("unused"); },
    async openService() { throw new Error("unused"); },
  };
}

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

test("personal capability scope rejects hosted execution before server funding or dispatch", async () => {
  const assertServerFunding = mock(async (_humanUserId: string, _origin?: string) => {});
  const error = await runWithCapabilityFundingSession(capabilityFunding("personal"), () =>
    assertConnectedAppExecutionFunding({
      hosted: true,
      causalHumanUserId: "caller",
    }, assertServerFunding)).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ServerProviderCredentialsDeniedError);
  expect(error).toMatchObject({
    humanUserId: "caller",
    origin: "connected_app_execute",
  });
  expect(assertServerFunding).not.toHaveBeenCalled();
});

test("server-funded capability scope preserves hosted and local legacy admission", async () => {
  const assertServerFunding = mock(async (_humanUserId: string, _origin?: string) => {});
  await runWithCapabilityFundingSession(capabilityFunding("server"), async () => {
    await assertConnectedAppExecutionFunding({
      hosted: true,
      causalHumanUserId: "caller",
    }, assertServerFunding);
    await assertConnectedAppExecutionFunding({
      hosted: false,
      causalHumanUserId: "",
    }, assertServerFunding);
  });

  expect(assertServerFunding).toHaveBeenCalledTimes(1);
  expect(assertServerFunding).toHaveBeenCalledWith("caller", "connected_app_execute");
});
