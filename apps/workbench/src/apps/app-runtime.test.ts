import { describe, expect, mock, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";

const getMiniAppRuntime = mock(async (appId: string) => ({
  appId,
  sourceHash: "c".repeat(64),
  srcDoc: "<html><body>ok</body></html>",
  manifest: {
    id: appId,
    name: "Sample App",
    version: "0.1.0",
    fileAssociations: { extensions: [".xlsx"] },
    capabilities: {},
  },
}));

mock.module("../lib/api", () => ({
  apiClient: { getMiniAppRuntime },
}));

const { loadMiniAppRuntime } = await import("./app-runtime");

describe("loadMiniAppRuntime", () => {
  test("delegates to apiClient.getMiniAppRuntime", async () => {
    getMiniAppRuntime.mockClear();
    const out = await loadMiniAppRuntime("sample-app");
    expect(getMiniAppRuntime).toHaveBeenCalledTimes(1);
    expect(getMiniAppRuntime).toHaveBeenCalledWith("sample-app");
    expect(out.appId).toBe("sample-app");
    expect(out.srcDoc).toContain("ok");
  });

  test("propagates ApiError from the client", async () => {
    getMiniAppRuntime.mockImplementationOnce(async () => {
      throw new ApiError(409, "App dependencies are not installed.");
    });
    await expect(loadMiniAppRuntime("sample-app")).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "App dependencies are not installed.",
    });
  });
});
