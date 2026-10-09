import type { BrowserUseBrowserSession, BrowserUseCloudAdapter, BrowserUseHostedBrowserSession } from "../browser-use/browser-use-cloud";
import type { ConnectedWebOperationSecrets } from "./operation-secrets";
import type { ConnectedWebOperation } from "./store";

/** Only call after an irreversible durable cleanup claim. No run cancellation. */
export async function stopIdleConnectedWebBrowser(input: {
  readonly operation: Pick<ConnectedWebOperation, "id" | "ownerUserId" | "accountId" | "sealedProviderRefs" | "lifecycle" | "browserCleanupStartedAt">;
  readonly secrets: ConnectedWebOperationSecrets;
  readonly provider: Pick<BrowserUseCloudAdapter, "findHostedBrowsers" | "stopBrowser">;
  readonly settleBrowserCost?: (input: {
    readonly identity: string;
    readonly workload: string;
    readonly estimatedCostUsd: string | null;
    readonly evidenceState: "estimated" | "unknown";
  }) => Promise<void>;
}): Promise<boolean> {
  if (!input.operation.browserCleanupStartedAt || input.operation.lifecycle !== "terminal") return false;
  try {
    const coordinates = input.secrets.unsealProviderReferences({
      context: { operationId: input.operation.id, ownerUserId: input.operation.ownerUserId, accountId: input.operation.accountId },
      references: input.operation.sealedProviderRefs,
    });
    if (!coordinates.sessionId && !coordinates.browserId) {
      if (coordinates.browserCost && input.settleBrowserCost) {
        await input.settleBrowserCost({ ...coordinates.browserCost, estimatedCostUsd: null, evidenceState: "unknown" });
      }
      return true;
    }
    const discovered = coordinates.sessionId
      ? await input.provider.findHostedBrowsers({ agentSessionId: coordinates.sessionId })
      : [];
    if (!Array.isArray(discovered)) return false;
    const browsers = new Map<string, Pick<BrowserUseBrowserSession, "browserId" | "status" | "costEvidence">>(
      discovered.map((browser: BrowserUseHostedBrowserSession) => [browser.browserId, browser]),
    );
    if (coordinates.browserId && !browsers.has(coordinates.browserId)) {
      browsers.set(coordinates.browserId, { browserId: coordinates.browserId, status: "active" });
    }
    let completeEstimate = browsers.size > 0;
    let total = 0;
    for (const browser of browsers.values()) {
      const stopped = browser.status === "stopped"
        ? browser
        : await input.provider.stopBrowser(browser.browserId);
      if ("kind" in stopped) {
        if (stopped.code !== "resource_not_found") return false;
        completeEstimate = false;
      } else if (stopped.browserId !== browser.browserId || stopped.status !== "stopped") return false;
      else if (stopped.costEvidence?.evidenceState === "estimated" && stopped.costEvidence.estimatedCostUsd !== null) {
        const amount = Number(stopped.costEvidence.estimatedCostUsd);
        if (!Number.isFinite(amount) || amount < 0) completeEstimate = false;
        else total += amount;
      } else completeEstimate = false;
    }
    if (coordinates.browserCost && input.settleBrowserCost) {
      await input.settleBrowserCost({
        ...coordinates.browserCost,
        estimatedCostUsd: completeEstimate ? total.toFixed(8) : null,
        evidenceState: completeEstimate ? "estimated" : "unknown",
      });
    }
    return true;
  } catch {
    // Provider coordinates/errors never become UI, model text, or logs.
    return false;
  }
}
