import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { bolterRoutes } from "../../src/routes/bolter";
import { BolterControlError, type BolterController } from "../../src/messaging/bolter-controller";
const user = "11111111-1111-4111-8111-111111111111";
const binding = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function fixture(controller: Partial<BolterController>, signedIn = true) {
  const app = Fastify(); apps.push(app);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", request => { request.sessionUserId = signedIn ? user : null; return Promise.resolve(); });
  bolterRoutes(app, controller as BolterController);
  await app.ready(); return app;
}
describe("Bolter HTTP Human authority", () => {
  test("unauthenticated callers cannot invoke a semantic operation", async () => {
    let calls = 0;
    const app = await fixture({ connections: async () => { calls++; throw new Error("unexpected"); } }, false);
    const reply = await app.inject({ method: "GET", url: "/api/bolter/connections" });
    expect(reply.statusCode).toBe(401); expect(calls).toBe(0);
  });
  test("reviewed text uses the authenticated Human and preserves the exact reviewed body", async () => {
    const calls: unknown[] = [];
    const app = await fixture({ sendReviewed: async (...input) => { calls.push(input); return { messageId: 8, outboxId: requestId, state: "pending" }; } });
    const payload = { expectedRevision: 2, requestId, content: "  /literal external text\n" };
    expect((await app.inject({ method: "POST", url: `/api/bolter/bindings/${binding}/messages`, payload })).statusCode).toBe(200);
    expect(calls).toEqual([[user, binding, payload]]);
    for (const extra of [{ userId: binding }, { sourceInboxId: binding }, { namespaceId: binding }, { receiver: {} }]) {
      expect((await app.inject({ method: "POST", url: `/api/bolter/bindings/${binding}/messages`, payload: { ...payload, ...extra } })).statusCode).toBe(400);
    }
    expect(calls.length).toBe(1);
  });
  test("fresh Room selection never accepts an existing Room or arbitrary provider destination", async () => {
    let calls = 0;
    const app = await fixture({ createRoom: async () => { calls++; throw new BolterControlError("authority_changed"); } });
    const payload = { choiceId: "qualified-choice", agentId: binding, name: "Chat", modelSponsorshipAccepted: true };
    for (const extra of [{ roomId: binding }, { chatId: "retarget" }, { modelSponsorshipAccepted: false }]) {
      expect((await app.inject({ method: "POST", url: `/api/bolter/connections/${binding}/rooms`, payload: { ...payload, ...extra } })).statusCode).toBe(400);
    }
    const result = await app.inject({ method: "POST", url: `/api/bolter/connections/${binding}/rooms`, payload });
    expect(result.statusCode).toBe(409); expect(result.json<unknown>()).toEqual({ code: "authority_changed" }); expect(calls).toBe(1);
  });
  test("operation cancellation is owner-scoped and provider errors are not reflected", async () => {
    const calls: unknown[] = [];
    const app = await fixture({ cancelOperation: async (...input) => { calls.push(input); throw new Error("private provider response"); } });
    const result = await app.inject({ method: "POST", url: `/api/bolter/operations/${requestId}/cancel`, payload: {} });
    expect(result.statusCode).toBe(503); expect(result.json<unknown>()).toEqual({ code: "runtime_unavailable" });
    expect(calls).toEqual([[user, requestId]]);
  });
});

test("delivery status selectors remain UUID-only and owner-scoped", async () => {
  const calls: unknown[] = [];
  const app = await fixture({ deliveries: async (...input) => { calls.push(input); return { deliveries: [] }; } });
  expect((await app.inject({ method: "GET", url: `/api/bolter/bindings/${binding}/deliveries?requestId=${requestId}` })).statusCode).toBe(200);
  expect(calls).toEqual([[user, binding, { requestId }]]);
  for (const query of ["requestId=invalid", `requestId=${requestId}&chatId=foreign`, `userId=${user}`]) {
    expect((await app.inject({ method: "GET", url: `/api/bolter/bindings/${binding}/deliveries?${query}` })).statusCode).toBe(400);
  }
  expect(calls).toHaveLength(1);
});
