import type { BrowserUseCloudAdapter } from "../browser-use/browser-use-cloud";
import type { ConnectedWebOperationSecrets } from "./operation-secrets";
import type { ConnectedWebOperation } from "./store";

/** Only call after an irreversible durable cleanup claim. No run cancellation. */
export async function stopIdleConnectedWebBrowser(input: {
  readonly operation: Pick<ConnectedWebOperation, "id" | "ownerUserId" | "accountId" | "sealedProviderRefs" | "lifecycle" | "browserCleanupStartedAt">;
  readonly secrets: ConnectedWebOperationSecrets;
  readonly provider: Pick<BrowserUseCloudAdapter, "findHostedBrowsers" | "stopBrowser">;
}): Promise<boolean> {
  if (!input.operation.browserCleanupStartedAt || input.operation.lifecycle !== "terminal") return false;
  try {
    const coordinates = input.secrets.unsealProviderReferences({
      context: { operationId: input.operation.id, ownerUserId: input.operation.ownerUserId, accountId: input.operation.accountId },
      references: input.operation.sealedProviderRefs,
    });
    if (!coordinates.sessionId && !coordinates.browserId) return true;
    const discovered = coordinates.sessionId
      ? await input.provider.findHostedBrowsers({ agentSessionId: coordinates.sessionId })
      : [];
    if (!Array.isArray(discovered)) return false;
    const browsers = new Map<string, { readonly browserId: string; readonly status: string }>(discovered.map((browser: { readonly browserId: string; readonly status: string }) => [browser.browserId, browser]));
    if (coordinates.browserId && !browsers.has(coordinates.browserId)) {
      browsers.set(coordinates.browserId, { browserId: coordinates.browserId, status: "active" });
    }
    for (const browser of browsers.values()) {
      if (browser.status === "stopped") continue;
      const stopped = await input.provider.stopBrowser(browser.browserId);
      if ("kind" in stopped) {
        if (stopped.code !== "resource_not_found") return false;
      } else if (stopped.browserId !== browser.browserId || stopped.status !== "stopped") return false;
    }
    return true;
  } catch {
    // Provider coordinates/errors never become UI, model text, or logs.
    return false;
  }
}
