import { describe, expect, test } from "bun:test";
import { OpenRouterCreditError, openRouterCreditError } from "../../src/providers/openrouter-credit-error";
import { classifyPersonalAttemptFailure } from "../../src/usage/personal-llm-attempt";
import { toFriendlyError } from "../../src/utils/friendly-errors";
import { withGatewayErrorLabel } from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";

const refusal = (requested = "90000", affordable = "40000") => Object.assign(new Error(
  `This request requires more credits, or fewer max_tokens. You requested up to ${requested} tokens, but can only afford ${affordable}. Private provider diagnostic.`,
), { status: 402 });

describe("OpenRouter credit refusals", () => {
  test("preserves only documented temporary-hold evidence and the provider wait", () => {
    const temporary = {
      status: 402,
      headers: new Headers({ "retry-after": "120", "set-cookie": "private" }),
      error: { message: "private diagnostic", metadata: {
        limit_source: "openrouter_in_flight_budget", reason: "in_flight_budget_exhausted", private: "private",
      } },
    };
    const error = openRouterCreditError(temporary)!;
    expect(error.inFlightBudget).toEqual({ retryAfterMs: 120_000 });
    expect(error.code).toBe("OPENROUTER_IN_FLIGHT_BUDGET");
    expect(error.allowance).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("private");
    expect(toFriendlyError(error).message).toContain("temporarily reserved");
    expect(toFriendlyError(error).detailsForLog).toBe("OPENROUTER_IN_FLIGHT_BUDGET");
    expect(classifyPersonalAttemptFailure(error, false).disposition).toBe("safe_refusal");
    expect(classifyPersonalAttemptFailure(error, false, true).disposition).toBe("terminal_unknown");
    expect(openRouterCreditError(temporary, true)?.inFlightBudget).toBeUndefined();
    expect(openRouterCreditError(error, true)?.inFlightBudget).toBeUndefined();
    expect(openRouterCreditError({ ...temporary, status: 503 })).toBeNull();
    expect(openRouterCreditError({ ...temporary, error: { metadata: { limit_source: "openrouter_credits", reason: "weight_exceeds_budget" } } })?.inFlightBudget).toBeUndefined();
    for (const header of [undefined, "", "-1", "1.5", "120 seconds", "Infinity", "2147484"]) {
      expect(openRouterCreditError({ ...temporary, headers: { "retry-after": header } })?.inFlightBudget).toEqual({});
    }
    expect(openRouterCreditError({ ...temporary, headers: { "retry-after": "0" } })?.inFlightBudget).toEqual({ retryAfterMs: 0 });
    expect(openRouterCreditError({ ...temporary, headers: { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" } })?.inFlightBudget).toEqual({ retryAfterMs: 0 });
  });
  test("retains only validated allowance evidence and gives a safe actionable error", () => {
    const error = openRouterCreditError(refusal())!;
    expect(error.allowance).toEqual({ requested: 90000, affordable: 40000 });
    expect(JSON.stringify(error)).not.toContain("Private provider");
    expect(error.message).not.toContain("Private provider");
    expect(toFriendlyError(error).message).toContain("OpenRouter");
    expect(toFriendlyError(error).message).toContain("account balance and key budget");
    expect(toFriendlyError(error).message).not.toContain("Something went wrong");
    expect(toFriendlyError(error).detailsForLog).toBe("OPENROUTER_CREDIT_LIMIT");
    expect(classifyPersonalAttemptFailure(error, false).disposition).toBe("safe_refusal");
    expect(classifyPersonalAttemptFailure(error, false, true).disposition).toBe("terminal_unknown");
    expect(classifyPersonalAttemptFailure(error, true).disposition).toBe("terminal_cancelled");
  });
  test("does not guess allowances or treat another status as a credit refusal", () => {
    expect(openRouterCreditError(Object.assign(refusal(), { status: 500 }))).toBeNull();
    expect(openRouterCreditError(new Error("402 insufficient credits"))).toBeNull();
    for (const [requested, affordable] of [["100", "100"], ["100", "101"], ["100", "-1"], ["100", "4.5"], ["100", "9007199254740992"], ["0", "0"]]) {
      expect(openRouterCreditError(refusal(requested, affordable))?.allowance).toBeUndefined();
    }
    expect(openRouterCreditError(refusal("100", "0"))?.allowance?.affordable).toBe(0);
    expect(openRouterCreditError({ status: 402, error: { message: refusal().message } })?.allowance?.affordable).toBe(40000);
    expect(classifyPersonalAttemptFailure(refusal(), false).disposition).toBe("terminal_unknown");
  });
  test("streaming and bound tools retain refusal evidence only before any progress", async () => {
    for (const partial of [false, true]) {
      const model: ChatModel = {
        invoke: async () => { throw refusal(); },
        stream: async function* () { if (partial) yield "reasoning or partial output"; throw refusal(); },
        bindTools: () => model,
      };
      const wrapped = withGatewayErrorLabel(model, "OpenRouter", (error, outputObserved) => openRouterCreditError(error, outputObserved) ?? error);
      expect(await wrapped.bindTools!([]).invoke([]).catch((error: unknown) => error)).toBeInstanceOf(OpenRouterCreditError);
      let caught: unknown;
      try { for await (const _chunk of await wrapped.stream!([])) { /* consume */ } } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OpenRouterCreditError);
      expect((caught as OpenRouterCreditError).allowance !== undefined).toBe(!partial);
    }
  });
});
