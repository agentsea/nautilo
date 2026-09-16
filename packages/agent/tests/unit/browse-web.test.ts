import { afterEach, expect, test } from "bun:test";
import { buildSystemPrompt } from "../../src/prompts/templates";
import { createBrowseWebTool, dispatchBrowseWeb, publicBrowserUseAvailable } from "../../src/tools/connected-web-accounts/browse-web";
import { setConnectedWebAccountReadToolRuntime } from "../../src/tools/connected-web-accounts/runtime";
const context = { userId: "owner", agentId: "agent", roomId: "room", memoryAccessEnvelope: {} as never };
afterEach(() => setConnectedWebAccountReadToolRuntime(null));
test("availability follows hosted provider readiness, not account inventory", () => {
  expect(publicBrowserUseAvailable()).toBe(false);
  setConnectedWebAccountReadToolRuntime({ publicAvailable: () => true, readPublic: async () => ({ ok: false, code: "unavailable", recovery: "none" }), read: async () => ({ ok: false, code: "unavailable", recovery: "none" }) });
  expect(publicBrowserUseAvailable()).toBe(true);
});
test("server fields cannot leak through the public receipt projection", async () => {
  setConnectedWebAccountReadToolRuntime({ read: async () => ({ ok: false, code: "unavailable", recovery: "none" }), readPublic: async () => ({ ok: true, status: "active", target: { url: "https://example.com", origin: "https://example.com" }, profileId: "private-secret" } as never) });
  expect(JSON.parse(await dispatchBrowseWeb({ url: "https://example.com", request: "Read" }, context))).toEqual({ ok: false, code: "invalid_result", recovery: "none" });
});
test("a browse-only tool binding still receives public routing instructions", () => {
  const prompt = buildSystemPrompt({ assistantName: "Moxie", isGuest: false, tools: [createBrowseWebTool()] });
  expect(prompt).toContain("Honor an explicit Browser Use request directly");
  expect(prompt).toContain("choose Browser Use autonomously");
  expect(prompt).toContain("A missing saved account does not mean authentication is required");
});

test("oversized public instructions and targets reject before starting provider work", async () => {
  let dispatches = 0;
  setConnectedWebAccountReadToolRuntime({
    read: async () => ({ ok: false, code: "unavailable", recovery: "none" }),
    readPublic: async () => { dispatches += 1; return { ok: false, code: "unavailable", recovery: "none" }; },
  });
  const tool = createBrowseWebTool(context);
  for (const input of [
    { url: "https://example.com", request: "r".repeat(4097) },
    { url: "https://example.com/" + "p".repeat(2048), request: "Read" },
  ]) {
    const error: unknown = await tool.invoke(input).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
  }
  expect(dispatches).toBe(0);
});
