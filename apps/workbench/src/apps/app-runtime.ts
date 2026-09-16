import { apiClient } from "../lib/api";
import type { MiniAppRuntimeResponse } from "@nautilo/api-client/browser";

export async function loadMiniAppRuntime(appId: string): Promise<MiniAppRuntimeResponse> {
  return apiClient.getMiniAppRuntime(appId);
}
