import { chooseBrowserAction } from "../../../packages/agent/src/graph/browser-choice.ts";
import {
  invokeChoice,
  type ChoiceInput,
  type ChoiceResult,
} from "../../../packages/agent/src/providers/choice-driver.ts";

export function choiceInputReceipt(input: ChoiceInput): Omit<ChoiceInput, "signal" | "tenantContext"> {
  return {
    modelId: input.modelId,
    state: input.state,
    instructions: input.instructions,
    choices: input.choices,
  };
}

export async function runCapturedJevChoice(
  input: ChoiceInput,
  maxChoices: number,
): Promise<{
  readonly choiceRequests: readonly ReturnType<typeof choiceInputReceipt>[];
  readonly providerCalls: readonly Record<string, unknown>[];
  readonly result: ChoiceResult & { readonly choiceCalls: number; readonly screeningRounds: number };
}> {
  const choiceRequests: ReturnType<typeof choiceInputReceipt>[] = [];
  const providerCalls: Record<string, unknown>[] = [];
  const result = await chooseBrowserAction(input, maxChoices, async (requestInput: ChoiceInput): Promise<ChoiceResult> => {
    choiceRequests.push(choiceInputReceipt(requestInput));
    const captureFetch = (async (request: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const call: Record<string, unknown> = {
        request: {
          url: typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
        },
        response: null,
      };
      providerCalls.push(call);
      const response = await globalThis.fetch(request, init);
      call["response"] = {
        status: response.status,
        body: response.ok ? await response.clone().json().catch(() => null) : null,
      };
      return response;
    }) as typeof fetch;
    return invokeChoice(requestInput, { fetch: captureFetch, recordUsage: () => {} });
  });
  return { choiceRequests, providerCalls, result };
}
