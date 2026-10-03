import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import type { SoulFileInput, SoulGenerationStreamEvent } from "@nautilo/agent";
import { SoulGenerationRateLimitError } from "@nautilo/db";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";

const generateSoulFileMock = mock(async (
  _input: Partial<SoulFileInput>,
  _signal?: AbortSignal,
  _authorization?: unknown,
) => "# Generated\n\n## Essence\nA usable generated Soul.\n\n## Tone\nExact.");
const generateSoulFileStreamMock = mock(
  (
    _input: Partial<SoulFileInput>,
    _signal?: AbortSignal,
    _authorization?: unknown,
  ): AsyncGenerator<SoulGenerationStreamEvent> =>
    (async function* () {
      yield { type: "started" } as const;
    })(),
);

const { bindSoulStreamCloseAbort, profileRoutes } = await import("../../src/routes/profile");

describe("POST /api/profile/generate-soul/stream", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    generateSoulFileMock.mockClear();
    generateSoulFileStreamMock.mockReset();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function makeApp(
    serverFunding = true,
    generator: typeof generateSoulFileMock = generateSoulFileMock,
    options: { personalService?: boolean; quotaError?: boolean } = {},
  ): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    profileRoutes(app, {
      findPersonalAgentsForUser: async () => [{
        agentId: "agent-own",
        handle: "genie",
        displayName: "Genie",
      }],
      assertCanUseServerFundedOwnSoul: async ({ humanUserId }) => {
        if (!serverFunding) {
          throw new ServerProviderCredentialsDeniedError(humanUserId, "soul_test");
        }
      },
      isPersonalSoulServiceCaller: async () => options.personalService ?? false,
      consumePersonalSoulAttempt: async () => {
        if (options.quotaError) throw new SoulGenerationRateLimitError();
      },
      generateSoulFile: generator,
      generateSoulFileStream: generateSoulFileStreamMock,
      upsertSoulProfile: async () => undefined,
    });
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
    expect(generateSoulFileStreamMock.mock.calls[0]?.[2]).toMatchObject({
      humanUserId: "test-user",
      agentId: "agent-own",
      admission: "own_soul_setup_service",
    });
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

  test("denies before starting the soul provider stream without server funding", async () => {
    const response = await makeApp(false).inject({
      method: "POST",
      url: "/api/profile/generate-soul/stream",
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(generateSoulFileStreamMock).not.toHaveBeenCalled();
    expect(JSON.parse(response.body)).toMatchObject({
      code: "server_provider_credentials_required",
      capability: "use_server_provider_credentials",
    });
  });

  test("uses the same own-Soul setup admission for the non-stream route", async () => {
    const response = await makeApp().inject({
      method: "POST",
      url: "/api/profile/generate-soul",
      payload: { name: "Vex" },
    });
    expect(response.statusCode).toBe(200);
    expect(generateSoulFileMock).toHaveBeenCalledTimes(1);
    expect(generateSoulFileMock.mock.calls[0]?.[2]).toMatchObject({
      humanUserId: "test-user",
      agentId: "agent-own",
      admission: "own_soul_setup_service",
    });
  });

  test("denies the non-stream route before provider work when setup admission fails", async () => {
    const response = await makeApp(false).inject({
      method: "POST",
      url: "/api/profile/generate-soul",
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(generateSoulFileMock).not.toHaveBeenCalled();
  });

  test("one Human cannot start simultaneous server-paid Soul generations across endpoints", async () => {
    let entered!: () => void;
    let finish!: (value: string) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const completed = new Promise<string>((resolve) => { finish = resolve; });
    const generator = mock(async () => {
      entered();
      return completed;
    }) as typeof generateSoulFileMock;
    const app = makeApp(true, generator);
    const first = app.inject({ method: "POST", url: "/api/profile/generate-soul", payload: {} });
    await started;

    const concurrent = await app.inject({
      method: "POST", url: "/api/profile/generate-soul/stream", payload: {},
    });
    expect(concurrent.statusCode).toBe(409);
    expect(JSON.parse(concurrent.body)).toEqual({ error: "soul_generation_in_progress" });
    expect(generateSoulFileStreamMock).not.toHaveBeenCalled();

    finish("# Generated\n\n## Essence\nDone.");
    expect((await first).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/profile/generate-soul", payload: {} })).statusCode)
      .toBe(200);
  });

  test("the personal Soul quota rejects both routes before provider work", async () => {
    const app = makeApp(true, generateSoulFileMock, { personalService: true, quotaError: true });
    for (const url of ["/api/profile/generate-soul", "/api/profile/generate-soul/stream"]) {
      const response = await app.inject({ method: "POST", url, payload: {} });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: "soul_generation_limit_reached" });
    }
    expect(generateSoulFileMock).not.toHaveBeenCalled();
    expect(generateSoulFileStreamMock).not.toHaveBeenCalled();
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
