import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import type { SoulFileInput, SoulGenerationStreamEvent } from "@nautilo/agent";

const realAgent = await import("@nautilo/agent");
const generateSoulFileStreamMock = mock(
  (_input: Partial<SoulFileInput>, _signal?: AbortSignal): AsyncGenerator<SoulGenerationStreamEvent> =>
    (async function* () {
      yield { type: "started" } as const;
    })(),
);

mock.module("@nautilo/agent", () => ({
  ...realAgent,
  generateSoulFileStream: (input: Partial<SoulFileInput>, signal?: AbortSignal) =>
    generateSoulFileStreamMock(input, signal),
}));

const { bindSoulStreamCloseAbort, profileRoutes } = await import("../../src/routes/profile");

describe("POST /api/profile/generate-soul/stream", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    generateSoulFileStreamMock.mockReset();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  afterAll(() => {
    mock.module("@nautilo/agent", () => realAgent);
  });

  function makeApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    profileRoutes(app);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = "test-user";
    });
    apps.push(app);
    return app;
  }

  test("never puts provider exception text in SSE and retains fallback markdown", async () => {
    const secret = "provider-secret-must-not-reach-the-browser";
    generateSoulFileStreamMock.mockImplementation(
      (_input, _signal) =>
        (async function* (): AsyncGenerator<SoulGenerationStreamEvent> {
          yield { type: "started" };
          yield {
            type: "error",
            error: `upstream failed: ${secret}`,
            fallback: "# Safe fallback\n\n## Essence\nStill usable.",
          };
        })(),
    );

    const response = await makeApp().inject({
      method: "POST",
      url: "/api/profile/generate-soul/stream",
      payload: { name: "Vex" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("soul.error");
    expect(response.body).toContain("# Safe fallback");
    expect(response.body).toContain("Unable to generate a soul file right now; using a fallback.");
    expect(response.body).not.toContain(secret);
  });

  test("normal completion removes close cleanup without aborting the generation signal", async () => {
    let signal: AbortSignal | undefined;
    generateSoulFileStreamMock.mockImplementation(
      (_input, externalSignal) =>
        (async function* (): AsyncGenerator<SoulGenerationStreamEvent> {
          signal = externalSignal;
          yield { type: "started" };
          yield { type: "completed", soulFile: "# Complete\n\n## Essence\nDone." };
        })(),
    );

    const response = await makeApp().inject({
      method: "POST",
      url: "/api/profile/generate-soul/stream",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });

  test("response/socket close aborts provider work and cleanup detaches listeners", () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    const socket = new EventEmitter();
    const controller = new AbortController();
    const guard = bindSoulStreamCloseAbort({ request, response, socket }, controller);

    socket.emit("close");
    expect(controller.signal.aborted).toBe(true);
    expect(guard.clientClosed()).toBe(true);

    guard.dispose();
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });
});
