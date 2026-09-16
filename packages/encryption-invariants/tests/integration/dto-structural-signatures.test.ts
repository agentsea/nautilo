import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditDtoDeclarations,
  discoverHttpDtoInventory,
  discoverSseDtoInventory,
  type DtoDeclaration,
  type DtoInventoryObservation,
} from "../../src/node/dto-inventory";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `m220 ${name} `));
  temporaryRoots.push(root);
  return root;
}

function declarationFor(observation: DtoInventoryObservation): DtoDeclaration {
  return {
    observationId: observation.id,
    locator: observation.locator,
    structuralSignatures: observation.structuralSignatures,
    arbitraryPayloads: [],
  };
}

describe("HTTP DTO structural signatures", () => {
  test("discovers HEAD and OPTIONS routes, route method arrays, and referenced handlers", async () => {
    const root = await fixtureRoot("http supported route forms");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "routes.ts"), `
      type ProbeQuery = { verbose?: boolean };
      type ProbeReply = { ok: true; detail?: string };

      async function probeHandler(
        request: { query: ProbeQuery },
        reply: { send(value: ProbeReply): unknown },
      ) {
        return reply.send({
          ok: true,
          detail: request.query.verbose ? "verbose" : undefined,
        });
      }

      const optionsHandler = async (
        _request: unknown,
        reply: { send(value: { methods: string[] }): unknown },
      ) => reply.send({ methods: ["GET", "HEAD"] });

      app.head<{ Querystring: ProbeQuery; Reply: ProbeReply }>(
        "/api/probe",
        probeHandler,
      );
      app.options("/api/probe", optionsHandler);
      app.route<{ Querystring: ProbeQuery; Reply: ProbeReply }>({
        method: ["GET", "HEAD"],
        url: "/api/probe-many",
        handler: probeHandler,
      });
      for (const operation of ["delete", "restore"] as const) {
        app.post(
          \`/api/photos/:entryId/\${operation}\`,
          async (_request, reply) => reply.send({ ok: true }),
        );
      }
    `);

    const observations = await discoverHttpDtoInventory(root);
    expect(observations.map((item) => item.locator)).toEqual([
      "http:request_response:GET /api/probe-many",
      "http:request_response:HEAD /api/probe",
      "http:request_response:HEAD /api/probe-many",
      "http:request_response:OPTIONS /api/probe",
      "http:request_response:POST /api/photos/:entryId/delete",
      "http:request_response:POST /api/photos/:entryId/restore",
    ]);
    expect(
      observations.find((item) =>
        item.locator === "http:request_response:HEAD /api/probe"
      )?.structuralSignatures,
    ).toEqual([
      "request.query:{verbose?:boolean}",
      "response.body:{detail:string;ok:true}",
      "response.body:{detail?:string;ok:true}",
    ]);
    expect(
      observations.find((item) =>
        item.locator === "http:request_response:OPTIONS /api/probe"
      )?.structuralSignatures,
    ).toEqual([
      "response.body:{methods:string[]}",
    ]);
  });

  test("discovers route methods from a literal finite for-of binding", async () => {
    const root = await fixtureRoot("http finite route method loop");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "routes.ts"), `
      for (const method of ["GET", "POST"] as const) app.route({
        method,
        url: "/api/finite-method",
        async handler(_request, reply) {
          return reply.send({ ok: true });
        },
      });
    `);

    const observations = await discoverHttpDtoInventory(root);
    expect(observations.map((item) => item.locator)).toEqual([
      "http:request_response:GET /api/finite-method",
      "http:request_response:POST /api/finite-method",
    ]);
    expect(observations[0]?.structuralSignatures).toContain(
      "response.body:{ok:boolean}",
    );
  });

  test("resolves a shorthand route method by symbol through same-name declarations", async () => {
    const root = await fixtureRoot("http symbol resolved route method");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "routes.ts"), `
      const method = chooseMethod();
      {
        const method = "PATCH";
        app.route({
          method,
          url: "/api/symbol-method",
          async handler(_request, reply) {
            return reply.send({ ok: true });
          },
        });
      }
    `);

    const observations = await discoverHttpDtoInventory(root);
    expect(observations.map((item) => item.locator)).toEqual([
      "http:request_response:PATCH /api/symbol-method",
    ]);
  });

  test("uses later explicit route options as the runtime winners", async () => {
    const root = await fixtureRoot("http later explicit route options");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "routes.ts"), `
      app.route({
        method: "GET",
        url: "/api/later-explicit",
        async handler(_request, reply) {
          return reply.send({ stale: true });
        },
        method: "POST",
        handler: async (_request, reply) => reply.send({ ok: true }),
      });
    `);

    const observations = await discoverHttpDtoInventory(root);
    expect(observations.map((item) => item.locator)).toEqual([
      "http:request_response:POST /api/later-explicit",
    ]);
    expect(observations[0]?.structuralSignatures).toEqual([
      "response.body:{ok:boolean}",
    ]);
  });

  test("ignores collection methods whose generic values mention FastifyInstance", async () => {
    const root = await fixtureRoot("http non-route generic receiver");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "routes.ts"), `
      interface FastifyInstance {
        get(...arguments_: unknown[]): unknown;
        route(...arguments_: unknown[]): unknown;
      }

      declare const app: FastifyInstance;
      declare const router: FastifyInstance;
      const installedCompositions = new WeakMap<
        FastifyInstance,
        { readonly active: boolean }
      >();

      installedCompositions.get(app);
      router.get(
        "/api/probe",
        async (
          _request: unknown,
          reply: { send(value: { ok: true }): unknown },
        ) => reply.send({ ok: true }),
      );
    `);

    const observations = await discoverHttpDtoInventory(root);
    expect(observations.map((item) => item.locator)).toEqual([
      "http:request_response:GET /api/probe",
    ]);
  });

  test("fails closed when a Fastify-looking route URL, method, or handler cannot be resolved", async () => {
    const cases = [
      {
        name: "dynamic url",
        source: `
          const routePath = choosePath();
          app.get(routePath, async (_request, reply) => reply.send({ ok: true }));
        `,
        expected: "unresolved route URL",
      },
      {
        name: "dynamic method",
        source: `
          const routeMethod = chooseMethod();
          app.route({
            method: routeMethod,
            url: "/api/dynamic-method",
            handler: async (_request, reply) => reply.send({ ok: true }),
          });
        `,
        expected: "unresolved route method",
      },
      {
        name: "dynamic for-of method",
        source: `
          for (const method of chooseMethods()) app.route({
            method,
            url: "/api/dynamic-loop-method",
            async handler(_request, reply) {
              return reply.send({ ok: true });
            },
          });
        `,
        expected: "unresolved route method",
      },
      {
        name: "mutable for-of array element",
        source: `
          let actual = "GET";
          actual = chooseMethod();
          for (const method of [actual]) app.route({
            method,
            url: "/api/mutable-loop-element",
            async handler(_request, reply) {
              return reply.send({ ok: true });
            },
          });
        `,
        expected: "unresolved route method",
      },
      {
        name: "same-name method parameter",
        source: `
          const method = "GET";
          function register(method: string) {
            app.route({
              method,
              url: "/api/parameter-method",
              async handler(_request, reply) {
                return reply.send({ ok: true });
              },
            });
          }
          register(chooseMethod());
        `,
        expected: "unresolved route method",
      },
      {
        name: "reassigned for-of method",
        source: `
          for (let method of ["GET"] as const) {
            method = chooseMethod();
            app.route({
              method,
              url: "/api/reassigned-loop-method",
              async handler(_request, reply) {
                return reply.send({ ok: true });
              },
            });
          }
        `,
        expected: "unresolved route method",
      },
      {
        name: "shorthand method overridden by later spread",
        source: `
          const method = "GET";
          const runtimeOptions = { method: chooseMethod() };
          app.route({
            method,
            async handler(_request, reply) {
              return reply.send({ ok: true });
            },
            ...runtimeOptions,
            url: "/api/spread-method-override",
          });
        `,
        expected: "unresolved route method",
      },
      {
        name: "object method handler overridden by later spread",
        source: `
          const runtimeOptions = { handler: importedHandler };
          app.route({
            async handler(_request, reply) {
              return reply.send({ ok: true });
            },
            ...runtimeOptions,
            method: "GET",
            url: "/api/spread-handler-override",
          });
        `,
        expected: "unresolved route handler",
      },
      {
        name: "reassigned initialized method",
        source: `
          let method = "GET";
          method = chooseMethod();
          app.route({
            method,
            url: "/api/reassigned-initialized-method",
            async handler(_request, reply) {
              return reply.send({ ok: true });
            },
          });
        `,
        expected: "unresolved route method",
      },
      {
        name: "referenced imported handler",
        source: `
          app.post("/api/imported-handler", importedHandler);
        `,
        expected: "unresolved route handler",
      },
    ] as const;

    for (const fixture of cases) {
      const root = await fixtureRoot(`http ${fixture.name}`);
      const serverRoot = join(root, "packages/server/src");
      await mkdir(serverRoot, { recursive: true });
      await writeFile(join(serverRoot, "routes.ts"), fixture.source);

      let failure: unknown;
      try {
        await discoverHttpDtoInventory(root);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(fixture.expected);
    }
  });

  test("requires debt for recursively open inferred HTTP response and locally cast request paths", async () => {
    const root = await fixtureRoot("http recursive arbitrary");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "routes.ts"), `
      app.post("/api/open", async (request: any, reply: any) => {
        const body = request.body as {
          metadata: { nested: Record<string, unknown> };
          parts: Array<{ payload: unknown }>;
        };
        const untyped: any = body.metadata;
        return reply.send({
          direct: untyped,
          nested: body.metadata,
          parts: body.parts,
        });
      });
    `);

    const [observation] = await discoverHttpDtoInventory(root);
    expect(observation?.structuralSignatures).toEqual([
      "request.body:{metadata:{nested:{[key:string]:unknown}};parts:{payload:unknown}[]}",
      "response.body:{direct:any;nested:{nested:{[key:string]:unknown}};parts:{payload:unknown}[]}",
    ]);
    expect(observation?.arbitraryPayloads).toEqual([
      "request.body.metadata.nested",
      "request.body.parts[].payload",
      "response.body.direct",
      "response.body.nested.nested",
      "response.body.parts[].payload",
    ]);

    const audit = auditDtoDeclarations({
      observations: [observation!],
      declarations: [declarationFor(observation!)],
    });
    expect(audit).toEqual({
      ok: false,
      errors: observation!.arbitraryPayloads.map((path) =>
        `${observation!.locator}: missing arbitrary payload declaration: ${path}`
      ),
    });
  });

  test("closed request and inferred response field/type additions invalidate the declaration", async () => {
    const root = await fixtureRoot("http structural");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    const routeFile = join(serverRoot, "routes.ts");
    await writeFile(routeFile, `
      type SecretBody = {
        message: string;
        options?: { privateNote: string };
      };
      app.post<{ Body: SecretBody }>("/api/secret", async (request: { body: SecretBody }, reply: any) => {
        if (request.body.message.length === 0) {
          return reply.code(400).send({ error: "empty" });
        }
        return reply.send({ ok: true, echoed: request.body.message });
      });
    `);

    const before = await discoverHttpDtoInventory(root);
    const original = before.find((item) =>
      item.locator === "http:request_response:POST /api/secret"
    );
    expect(original?.structuralSignatures).toEqual([
      "request.body:{message:string;options?:{privateNote:string}}",
      "response.body:{echoed:string;ok:boolean}",
      "response.body:{error:string}",
    ]);

    await writeFile(routeFile, `
      type SecretBody = {
        message: string;
        options?: { privateNote: string };
        recoveryPhrase: string;
      };
      app.post<{ Body: SecretBody }>("/api/secret", async (request: { body: SecretBody }, reply: any) => {
        if (request.body.message.length === 0) {
          return reply.code(400).send({ error: "empty", retryAfter: 30 });
        }
        return reply.send({ ok: true, echoed: request.body.message });
      });
    `);

    const after = await discoverHttpDtoInventory(root);
    const changed = after.find((item) => item.locator === original?.locator);
    expect(changed?.structuralSignatures).toContain(
      "request.body:{message:string;options?:{privateNote:string};recoveryPhrase:string}",
    );
    expect(changed?.structuralSignatures).toContain(
      "response.body:{error:string;retryAfter:number}",
    );

    const audit = auditDtoDeclarations({
      observations: after,
      declarations: [declarationFor(original!)],
    });
    expect(audit).toEqual({
      ok: false,
      errors: [
        "http:request_response:POST /api/secret: missing structural signature: "
          + "request.body:{message:string;options?:{privateNote:string};recoveryPhrase:string}",
        "http:request_response:POST /api/secret: missing structural signature: "
          + "response.body:{error:string;retryAfter:number}",
        "http:request_response:POST /api/secret: stale structural signature: "
          + "request.body:{message:string;options?:{privateNote:string}}",
        "http:request_response:POST /api/secret: stale structural signature: "
          + "response.body:{error:string}",
      ],
    });
  });

  test("does not mistake nested callback returns for HTTP response bodies", async () => {
    const root = await fixtureRoot("http nested callback returns");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "routes.ts"), `
      app.patch("/api/connections/:name", async (_request: any, reply: any) => {
        const row = await db.transaction(async (tx: any) => {
          const stored = await tx.update();
          return stored as {
            authRef: unknown;
            envLiteral: unknown;
            spawnSandboxProfile: unknown;
          };
        });
        return reply.send({ ok: true, name: String(row.name ?? "connection") });
      });
    `);

    const [observation] = await discoverHttpDtoInventory(root);
    expect(observation?.structuralSignatures).toEqual([
      "response.body:{name:string;ok:boolean}",
    ]);
    expect(observation?.arbitraryPayloads).toEqual([]);
  });

  test("captures locally cast request body/query/params and preserves literal discriminators", async () => {
    const root = await fixtureRoot("http local casts");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    const routeFile = join(serverRoot, "routes.ts");
    await writeFile(routeFile, `
      app.patch("/api/memory/:id", async (request: any, reply: any) => {
        const params = request.params as { id: string };
        const query = request.query as { dryRun?: boolean };
        const body = request.body as {
          kind: "memory";
          content?: string;
          visibility: "private" | "shared";
        };
        return reply.send({
          id: params.id,
          dryRun: query.dryRun,
          kind: body.kind,
          status: "updated" as const,
        });
      });
    `);

    const before = await discoverHttpDtoInventory(root);
    const original = before.find((item) =>
      item.locator === "http:request_response:PATCH /api/memory/:id"
    );
    expect(original?.structuralSignatures).toEqual([
      'request.body:{content?:string;kind:"memory";visibility:"private"|"shared"}',
      "request.params:{id:string}",
      "request.query:{dryRun?:boolean}",
      'response.body:{dryRun:boolean;id:string;kind:"memory";status:"updated"}',
    ]);

    await writeFile(routeFile, `
      app.patch("/api/memory/:id", async (request: any, reply: any) => {
        const params = request.params as { id: string };
        const query = request.query as { dryRun?: boolean };
        const body = request.body as {
          kind: "memory";
          content?: string;
          recoveryPhrase: string;
          visibility: "private" | "shared";
        };
        return reply.send({
          id: params.id,
          dryRun: query.dryRun,
          kind: body.kind,
          status: "updated" as const,
        });
      });
    `);

    const after = await discoverHttpDtoInventory(root);
    const audit = auditDtoDeclarations({
      observations: after,
      declarations: [declarationFor(original!)],
    });
    expect(audit.ok).toBe(false);
    if (audit.ok) throw new Error("expected locally cast request DTO drift");
    expect(audit.errors).toContain(
      `${original!.locator}: missing structural signature: `
        + 'request.body:{content?:string;kind:"memory";recoveryPhrase:string;'
        + 'visibility:"private"|"shared"}',
    );
    expect(audit.errors).toContain(
      `${original!.locator}: stale structural signature: `
        + 'request.body:{content?:string;kind:"memory";visibility:"private"|"shared"}',
    );
  });
});

describe("SSE channel-qualified structural signatures", () => {
  test("discovers route-method arrays with referenced SSE handlers and fails closed on missing producers", async () => {
    const root = await fixtureRoot("sse route forms");
    const serverRoot = join(root, "packages/server/src");
    await mkdir(serverRoot, { recursive: true });
    const routeFile = join(serverRoot, "events.ts");
    await writeFile(routeFile, `
      function eventHandler(_request: unknown, reply: any) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        writeEvent("changed", { id: "artifact" });
      }
      app.route({
        method: ["GET", "HEAD"],
        url: "/api/route-events",
        handler: eventHandler,
      });
    `);

    const observations = await discoverSseDtoInventory(root);
    expect(observations.map((item) => item.locator)).toEqual([
      "sse:produced:GET /api/route-events#changed",
      "sse:produced:HEAD /api/route-events#changed",
    ]);

    await writeFile(routeFile, `
      app.options("/api/empty-events", async (_request, reply) => {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        subscribeWithoutWriting();
      });
    `);
    let emptyFailure: unknown;
    try {
      await discoverSseDtoInventory(root);
    } catch (error) {
      emptyFailure = error;
    }
    expect((emptyFailure as Error).message).toContain(
      "SSE route has zero resolved event producers",
    );

    await writeFile(routeFile, `
      app.get("/api/dynamic-events", async (_request, reply) => {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        writeEvent(dynamicEventName(), { id: "artifact" });
      });
    `);
    let dynamicFailure: unknown;
    try {
      await discoverSseDtoInventory(root);
    } catch (error) {
      dynamicFailure = error;
    }
    expect((dynamicFailure as Error).message).toContain(
      "unresolved SSE producer event",
    );
  });

  test("requires debt for open producer and consumer event payload paths", async () => {
    const root = await fixtureRoot("sse recursive arbitrary");
    const serverRoot = join(root, "packages/server/src");
    const clientRoot = join(root, "packages/api-client/src");
    await mkdir(serverRoot, { recursive: true });
    await mkdir(clientRoot, { recursive: true });
    await writeFile(join(serverRoot, "events.ts"), `
      app.get("/api/open-events", async (_request, reply) => {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        const payload: {
          direct: any;
          metadata: { nested: Record<string, unknown> };
        } = getPayload();
        writeEvent("changed", payload);
      });
    `);
    await writeFile(join(clientRoot, "client.ts"), `
      const events = new EventSource("/api/open-events");
      events.addEventListener(
        "changed",
        (event: MessageEvent<{
          accepted: unknown;
          entries: Array<{ value: any }>;
        }>) => event,
      );
    `);

    const observations = await discoverSseDtoInventory(root);
    const accepted = observations.find((item) => item.direction === "accepted");
    const produced = observations.find((item) => item.direction === "produced");
    expect(accepted?.arbitraryPayloads).toEqual([
      "event.payload.accepted",
      "event.payload.entries[].value",
    ]);
    expect(produced?.arbitraryPayloads).toEqual([
      "event.payload.direct",
      "event.payload.metadata.nested",
    ]);

    const audit = auditDtoDeclarations({
      observations,
      declarations: observations.map(declarationFor),
    });
    expect(audit.ok).toBe(false);
    if (audit.ok) throw new Error("expected SSE arbitrary-payload debt drift");
    expect(audit.errors).toEqual([
      `${accepted!.locator}: missing arbitrary payload declaration: event.payload.accepted`,
      `${accepted!.locator}: missing arbitrary payload declaration: event.payload.entries[].value`,
      `${produced!.locator}: missing arbitrary payload declaration: event.payload.direct`,
      `${produced!.locator}: missing arbitrary payload declaration: event.payload.metadata.nested`,
    ]);
  });

  test("same-name events on different channels remain distinct and payload drift fails", async () => {
    const root = await fixtureRoot("sse structural");
    const serverRoot = join(root, "packages/server/src");
    const clientRoot = join(root, "packages/api-client/src");
    await mkdir(serverRoot, { recursive: true });
    await mkdir(clientRoot, { recursive: true });
    const producerFile = join(serverRoot, "events.ts");
    await writeFile(producerFile, `
      app.get("/api/apps/events", async (_request, reply) => {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        const writeEvent = (payload: { type: "changed"; appId: string; sourceHash: string }) => {};
        subscribeApps((event: { type: "changed"; appId: string; sourceHash: string }) => {
          writeEvent(event);
        });
      });
      app.get("/api/workspace/events", async (_request, reply) => {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        const writeEvent = (_type: string, _payload: unknown) => {};
        writeEvent("changed", { id: "artifact", path: "notes/private.md" });
      });
    `);
    await writeFile(join(clientRoot, "client.ts"), `
      const apps = new EventSource("/api/apps/events");
      apps.addEventListener("changed", (event: MessageEvent<{ type: "changed"; appId: string; sourceHash: string }>) => event);
      const workspace = new EventSource("/api/workspace/events");
      workspace.addEventListener("changed", (event: MessageEvent<{ id: string; path: string }>) => event);
    `);

    const before = await discoverSseDtoInventory(root);
    expect(before.map((item) => item.locator)).toEqual([
      "sse:accepted:GET /api/apps/events#changed",
      "sse:accepted:GET /api/workspace/events#changed",
      "sse:produced:GET /api/apps/events#changed",
      "sse:produced:GET /api/workspace/events#changed",
    ]);
    expect(before.find((item) =>
      item.locator === "sse:produced:GET /api/apps/events#changed"
    )?.structuralSignatures).toEqual([
      'event.payload:{appId:string;sourceHash:string;type:"changed"}',
    ]);
    expect(before.find((item) =>
      item.locator === "sse:produced:GET /api/workspace/events#changed"
    )?.structuralSignatures).toEqual([
      "event.payload:{id:string;path:string}",
    ]);

    await writeFile(producerFile, `
      app.get("/api/apps/events", async (_request, reply) => {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        const writeEvent = (payload: { type: "changed"; appId: string; sourceHash: string; privateSummary: string }) => {};
        subscribeApps((event: { type: "changed"; appId: string; sourceHash: string; privateSummary: string }) => {
          writeEvent(event);
        });
      });
      app.get("/api/workspace/events", async (_request, reply) => {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        const writeEvent = (_type: string, _payload: unknown) => {};
        writeEvent("changed", { id: "artifact", path: "notes/private.md" });
      });
    `);

    const after = await discoverSseDtoInventory(root);
    const originalApp = before.find((item) =>
      item.locator === "sse:produced:GET /api/apps/events#changed"
    )!;
    const audit = auditDtoDeclarations({
      observations: after,
      declarations: before.map(declarationFor),
    });
    expect(audit.ok).toBe(false);
    if (audit.ok) throw new Error("expected SSE structural drift");
    expect(audit.errors).toContain(
      `${originalApp.locator}: missing structural signature: `
        + 'event.payload:{appId:string;privateSummary:string;sourceHash:string;type:"changed"}',
    );
    expect(audit.errors).toContain(
      `${originalApp.locator}: stale structural signature: `
        + 'event.payload:{appId:string;sourceHash:string;type:"changed"}',
    );
  });
});
