import { describe, expect, test } from "bun:test";
import Fastify, { type FastifyRequest } from "fastify";
import { acpReadinessRoutes, type AcpReadinessRouteDeps } from "../../src/acp/routes";

const OWNER = "11111111-1111-4111-8111-111111111111";

function appFor(
  deps: Partial<AcpReadinessRouteDeps> = {},
  sessionUserId: string | null = OWNER,
) {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("policyContext", null);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.sessionUserId = sessionUserId;
    request.policyContext = sessionUserId ? { actorRole: "owner" } as typeof request.policyContext : null;
  });
  acpReadinessRoutes(app, {
    relay: { requestAcpReadiness: async () => "ready" },
    resolveHost: async () => ({ relayId: "relay-1" }),
    ...deps,
  });
  return app;
}

describe("D452 Hermes ACP readiness routes", () => {
  test("lists a static descriptor without selecting a relay or probing", async () => {
    let resolved = 0;
    const app = appFor({ resolveHost: async () => { resolved += 1; return { relayId: "relay-1" }; } });
    const response = await app.inject({ method: "GET", url: "/api/acp/harnesses" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual(expect.objectContaining({
      harnesses: [
        expect.objectContaining({ id: "hermes-acp" }),
        expect.objectContaining({ id: "opencode-acp" }),
      ],
    }));
    expect(resolved).toBe(0);
    await app.close();
  });

  test("uses the exact authenticated host selection and returns only the safe readiness result", async () => {
    const calls: unknown[] = [];
    const app = appFor({
      resolveHost: async (userId, relayId) => {
        calls.push({ userId, relayId });
        return relayId === "relay-1" ? { relayId } : null;
      },
      relay: { requestAcpReadiness: async (input) => {
        calls.push(input);
        return "missing";
      } },
    });
    const response = await app.inject({
      method: "POST", url: "/api/acp/harnesses/hermes-acp/readiness", payload: { relayId: "relay-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({
      state: "missing",
      action: "Install the reviewed Hermes runtime on this paired desktop, then retry.",
    });
    expect(calls[0]).toEqual({ userId: OWNER, relayId: "relay-1" });
    expect(calls[1]).toMatchObject({ relayId: "relay-1", userId: OWNER, registrationId: "hermes-acp" });
    const readinessRequest = calls[1] as { requestId?: unknown } | undefined;
    expect(typeof readinessRequest?.requestId).toBe("string");
    await app.close();
  });

  test("rejects unauthenticated and malformed requests before relay selection", async () => {
    let resolved = 0;
    const app = appFor({ resolveHost: async () => { resolved += 1; return { relayId: "relay-1" }; } }, null);
    expect((await app.inject({ method: "GET", url: "/api/acp/harnesses" })).statusCode).toBe(401);
    await app.close();
    const authenticated = appFor({ resolveHost: async () => { resolved += 1; return { relayId: "relay-1" }; } });
    expect((await authenticated.inject({
      method: "POST", url: "/api/acp/harnesses/hermes-acp/readiness", payload: { relayId: "relay-1", path: "/private" },
    })).statusCode).toBe(400);
    expect(resolved).toBe(0);
    await authenticated.close();
  });

  test("selects OpenCode explicitly and returns only its safe readiness state", async () => {
    const calls: unknown[] = [];
    const app = appFor({ relay: { requestAcpReadiness: async (input) => {
      calls.push(input);
      return "ready";
    } } });
    const response = await app.inject({
      method: "POST", url: "/api/acp/harnesses/opencode-acp/readiness", payload: { relayId: "relay-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({ state: "ready", action: null });
    expect(calls).toEqual([expect.objectContaining({ registrationId: "opencode-acp" })]);
    await app.close();
  });
});
