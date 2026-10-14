import { describe, expect, test } from "bun:test";
import { ChatGPTSubscriptionError, findChatGPTSubscriptionError, subscriptionFailure } from "../../src/providers/chatgpt-plan-errors";
import { toFriendlyError } from "../../src/utils/friendly-errors";
import { PersonalAttemptInvocationError, classifyPersonalAttemptFailure } from "../../src/usage/personal-llm-attempt";

describe("ChatGPT recovery", () => {
  test("limit errors remain actionable through wrappers without leaking upstream content or inventing reset times", () => {
    const failure = new ChatGPTSubscriptionError("subscription_limit");
    const wrapped = new Error("synthetic secret response", { cause: new PersonalAttemptInvocationError("terminal_unknown", failure) });
    const friendly = toFriendlyError(wrapped);
    expect(friendly.category).toBe("rate_limit");
    expect(friendly.message).toContain("Check usage in ChatGPT");
    expect(friendly.message).toContain("explicitly");
    expect(JSON.stringify(friendly)).not.toContain("synthetic secret");
    expect(friendly.message).not.toMatch(/minute|hour|reset at/i);
    expect(classifyPersonalAttemptFailure(failure, false, true).disposition).toBe("terminal_unknown");
  });
  test("structured HTTP refusals and stream codes use the same closed errors", () => {
    expect(subscriptionFailure({ code: "subscription_sharing_usage_limit_exceeded", status: 429 })).toBe("subscription_limit");
    expect(subscriptionFailure({ code: "subscription_sharing_usage_unavailable" })).toBe("subscription_unavailable");
    expect(subscriptionFailure({ status: 401, message: "secret" })).toBe("reconnect_required");
    expect(subscriptionFailure({ message: "subscription_sharing_usage_limit_exceeded" })).toBe("provider_unavailable");
    expect(toFriendlyError(new ChatGPTSubscriptionError("reconnect_required")).message).toContain("Reconnect in Settings");
  });
  test("interrupted streams report uncertainty; cyclic unrelated causes terminate", () => {
    expect(toFriendlyError(new ChatGPTSubscriptionError("stream_interrupted")).message).toContain("may have used plan allowance");
    const cyclic = new Error("cycle"); cyclic.cause = cyclic;
    expect(findChatGPTSubscriptionError(cyclic)).toBeUndefined();
  });
});
