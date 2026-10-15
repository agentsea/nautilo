import { afterEach, expect, test } from "bun:test";
import { createChatGPTDesktopListener } from "../../electron/chatgpt-plan-loopback";
const controllers: AbortController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.abort(); });
async function listener(current = () => true) {
  const controller = new AbortController(); controllers.push(controller);
  return { listener: await createChatGPTDesktopListener({ current, signal: controller.signal }), controller };
}
function authorization(port: number) {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.search = new URLSearchParams({ redirect_uri: `http://127.0.0.1:${port}/auth/callback`, state: "synthetic-state", code_challenge_method: "S256", code_challenge: "synthetic-challenge" }).toString();
  return url.toString();
}
test("captures a matching callback exactly once without claiming connection success", async () => {
  const h = await listener(); const { port } = h.listener;
  const result = h.listener.receive(authorization(port));
  const callback = `http://127.0.0.1:${port}/auth/callback?state=synthetic-state&code=synthetic-code&client_id=oaiapp_synthetic`;
  expect((await fetch(callback.replace("synthetic-state", "wrong-state"))).status).toBe(400);
  const response = await fetch(callback);
  expect(await result).toBe(callback);
  expect(await response.text()).toContain("finish connecting");
  expect(() => h.listener.receive(authorization(port))).toThrow();
});
test("rejects another destination or loopback port", async () => {
  const h = await listener();
  expect(() => h.listener.receive(authorization(h.listener.port).replace("auth.openai.com", "example.com"))).toThrow();
  const second = await listener();
  expect(() => second.listener.receive(authorization(1))).toThrow();
});
test("server or Human replacement fences callback delivery", async () => {
  let current = true;
  const h = await listener(() => current);
  const result = h.listener.receive(authorization(h.listener.port));
  current = false;
  const response = await fetch(`http://127.0.0.1:${h.listener.port}/auth/callback?state=synthetic-state&code=synthetic`);
  expect(response.status).toBe(400);
  h.controller.abort();
  await expect(result).rejects.toThrow("sign-in");
});
test("abort before and during preparation does not leave a callback listener", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(createChatGPTDesktopListener({ current: () => true, signal: controller.signal })).rejects.toThrow();
  const h = await listener(); h.controller.abort();
  expect(() => h.listener.receive(authorization(h.listener.port))).toThrow();
});
