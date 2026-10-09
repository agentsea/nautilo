import { AsyncLocalStorage } from "node:async_hooks";
import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
} from "@nautilo/trust";
import type { TaskFundingBinding } from "@nautilo/types";
import { getUsageContext } from "../../../usage/usage-context";
import type { DeepResearchFundingLane } from "./task-metadata";

export interface DeepResearchFundingBindings {
  readonly modelFunding: Readonly<Record<DeepResearchFundingLane, TaskFundingBinding>>;
  readonly tavilyFunding: TaskFundingBinding;
}

const admittedFunding = new AsyncLocalStorage<DeepResearchFundingBindings>();

/** Safe bindings only. Live Human authority and decrypted credentials remain in capability funding. */
export function runWithDeepResearchFunding<T>(
  bindings: DeepResearchFundingBindings | undefined,
  run: () => T,
): T {
  return bindings ? admittedFunding.run(bindings, run) : admittedFunding.exit(run);
}

export function getDeepResearchFunding(): DeepResearchFundingBindings | undefined {
  return admittedFunding.getStore();
}

/** Resolve the exact initiating Human from the trusted background usage scope. */
export async function assertDeepResearchServerFunding(origin: string): Promise<void> {
  const humanUserId = getUsageContext()?.userId?.trim() ?? "";
  if (!humanUserId) {
    throw new ServerProviderCredentialsDeniedError("", origin);
  }
  await assertCanUseServerProviderCredentials(humanUserId, origin);
}
