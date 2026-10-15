import { afterEach, expect, spyOn, test } from "bun:test";
import type { ChatGPTRegistrationRecord } from "@nautilo/db";
import { chatGPTSessionStore, listChatGPTModels } from "../../../src/lib/chatgpt-plan/runtime";
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const row = { userId: "synthetic-human", id: "synthetic-registration", authorityRevision: 1 } as ChatGPTRegistrationRecord;
function provider(body: unknown) {
  spies.push(spyOn(chatGPTSessionStore, "accessToken").mockResolvedValue("synthetic-access"));
  spies.push(spyOn(globalThis, "fetch").mockImplementation((async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ Authorization: "Bearer synthetic-access" });
    return Response.json(body);
  }) as typeof fetch));
}
test("account models intersect visible provider discovery with the signed catalog", async () => {
  provider({ models: [
    { slug: "gpt-6.1-sol", display_name: "Eligible model", visibility: "list" },
    { slug: "gpt-6-astra", display_name: "Hidden model", visibility: "hide" },
    { slug: "unrecognized-provider-model", display_name: "Not in catalog", visibility: "list" },
    { slug: "gpt-image-2", display_name: "Unsupported workload", visibility: "list" },
  ] });
  expect(await listChatGPTModels(row, new AbortController().signal)).toEqual([{ id: "openai:gpt-6.1-sol", name: "Eligible model" }]);
});
test("an API-key discovery shape cannot invent subscription entitlement", async () => {
  provider({ data: [{ id: "gpt-6.1-sol" }] });
  let code: string | undefined;
  try { await listChatGPTModels(row, new AbortController().signal); } catch (error) { code = error instanceof Error ? error.message : undefined; }
  expect(code).toBe("provider_unavailable");
});
