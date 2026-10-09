import type { UsageFundingProvenance } from "@nautilo/agent";
import type { DurableServiceFundingBinding } from "@nautilo/types";

import { BrowserUseCloudAdapter } from "../browser-use/browser-use-cloud";
import {
  admitDurableServiceFunding,
  admitLegacyServerServiceFunding,
  runWithDurableServiceFunding,
} from "../lib/service-funding";

export interface ConnectedWebBrowserFunding {
  admit(
    humanUserId: string,
    prior?: DurableServiceFundingBinding,
  ): Promise<DurableServiceFundingBinding>;
  admitLegacyServer(humanUserId: string): Promise<DurableServiceFundingBinding>;
  run<T>(
    binding: DurableServiceFundingBinding,
    intent: "spend" | "recover",
    callback: (attempt: {
      readonly apiKey: string;
      readonly usageFunding: UsageFundingProvenance;
    }) => Promise<T>,
  ): Promise<T>;
}

export const connectedWebBrowserFunding: ConnectedWebBrowserFunding = {
  admit: (humanUserId, prior) => admitDurableServiceFunding(
    humanUserId,
    "browser-use",
    prior,
  ),
  admitLegacyServer: (humanUserId) => admitLegacyServerServiceFunding(
    humanUserId,
    "browser-use",
  ),
  run: (binding, intent, callback) => runWithDurableServiceFunding(
    binding,
    intent,
    callback,
  ),
};

/** Secret-bearing adapter scope exists only inside the funding callback. */
export function withFundedBrowserUse<T>(
  funding: ConnectedWebBrowserFunding,
  provider: BrowserUseCloudAdapter,
  binding: DurableServiceFundingBinding,
  intent: "spend" | "recover",
  callback: (provider: BrowserUseCloudAdapter, usageFunding: UsageFundingProvenance) => Promise<T>,
): Promise<T> {
  return funding.run(binding, intent, ({ apiKey, usageFunding }) => callback(
    provider.withRequestCredential({ apiKey, usageFunding }),
    usageFunding,
  ));
}
