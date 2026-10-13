import type { UsageFundingProvenance } from "@nautilo/agent";
import type { DurableServiceFundingBinding, PaidServiceProvider } from "@nautilo/types";
import {
  admitDurableServiceFunding,
  runWithDurableServiceFunding,
} from "../lib/service-funding";

export type VoiceServiceFundingAttempt = Readonly<{
  apiKey: string;
  usageFunding: UsageFundingProvenance;
}>;

/** Server-owned secret boundary for direct voice and transcription services. */
export interface VoiceServiceFunding {
  admit(
    humanUserId: string,
    provider: PaidServiceProvider,
    prior?: DurableServiceFundingBinding,
  ): Promise<DurableServiceFundingBinding>;
  run<T>(
    binding: DurableServiceFundingBinding,
    intent: "spend" | "recover",
    callback: (attempt: VoiceServiceFundingAttempt) => Promise<T>,
  ): Promise<T>;
}

export const directVoiceServiceFunding: VoiceServiceFunding = Object.freeze({
  admit: (
    humanUserId: string,
    provider: PaidServiceProvider,
    prior?: DurableServiceFundingBinding,
  ): Promise<DurableServiceFundingBinding> =>
    admitDurableServiceFunding(humanUserId, provider, prior),
  run: <T>(
    binding: DurableServiceFundingBinding,
    intent: "spend" | "recover",
    callback: (attempt: VoiceServiceFundingAttempt) => Promise<T>,
  ): Promise<T> =>
    runWithDurableServiceFunding(binding, intent, callback),
});

/** Stable, non-secret key for account-local queues and in-memory caches. */
export function voiceFundingAccountKey(binding: DurableServiceFundingBinding): string {
  return `${binding.provider}:${binding.credentialFingerprint}`;
}
