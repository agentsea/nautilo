import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import {
  NautiloApiClient,
  type NautiloApiFetch,
} from "@nautilo/api-client";
import {
  createAuthorizedHumanMemoryClient,
  createHumanMemoryProcessorTransport,
  type AuthorizedHumanMemoryClient,
  type AuthorizedHumanMemoryDeviceContentPort,
  type AuthorizedHumanMemoryPreparedMutationJournal,
  type ProtectedAgentMemoryRepository,
} from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  __mintAuthorizedHumanMemoryTestAuthorityForTesting,
} from "@nautilo/lattice-bridge/testing";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryScopeLifecyclePort,
} from "../../../agent/src/tools/memory/protected-memory-ports";
import {
  __mintProtectedMemoryToolsNodeTestAuthorityForTesting,
  createProtectedMemoryTestToolsNode,
  type toolsNode,
} from "../../../agent/src/nodes/tools";
import {
  __mintProtectedMemoryTestShadowAuthorityForTesting,
  createProtectedMemoryTestShadowComposition,
  type ProtectedMemoryRouteAuthority,
  type ProtectedMemoryRoutePorts,
} from "../../src/routes/protected-memory-composition";
import { memoryRoutes } from "../../src/routes/memory";

export interface DormantForegroundMemoryConformanceAssembly {
  readonly app: FastifyInstance;
  readonly api: NautiloApiClient;
  readonly human: AuthorizedHumanMemoryClient;
  readonly agentToolsNode: typeof toolsNode;
  close(): Promise<void>;
}

/**
 * One test-only assembly of the dormant Human HTTP/client and Agent tool paths.
 * Both process-local authorities are minted inside this module. Production app
 * assembly cannot import this helper and no configuration value can activate it.
 */
export async function createDormantForegroundMemoryConformanceAssembly(
  input: Readonly<{
    routeAuthority: ProtectedMemoryRouteAuthority;
    memoryEnvelope: MemoryAccessEnvelope;
    routePorts: ProtectedMemoryRoutePorts;
    humanContent: AuthorizedHumanMemoryDeviceContentPort;
    humanJournal: AuthorizedHumanMemoryPreparedMutationJournal;
    agentRepository: ProtectedAgentMemoryRepository;
    agentAccess?: ProtectedAgentMemoryAccessPort;
    agentProjection?: ProtectedAgentMemoryProjectionPort;
    agentScopeLifecycle?: ProtectedAgentMemoryScopeLifecyclePort;
  }>,
): Promise<DormantForegroundMemoryConformanceAssembly> {
  const composition = createProtectedMemoryTestShadowComposition({
    authority: __mintProtectedMemoryTestShadowAuthorityForTesting(),
    target: input.routeAuthority,
    ports: input.routePorts,
  });
  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request) => {
    (request as { sessionUserId?: string }).sessionUserId =
      input.routeAuthority.userId;
    (request as { memoryEnvelope?: MemoryAccessEnvelope }).memoryEnvelope =
      input.memoryEnvelope;
    return Promise.resolve();
  });
  memoryRoutes(app, composition);
  await app.ready();

  const fetchImpl: NautiloApiFetch = async (request, init) => {
    const url = new URL(
      typeof request === "string"
        ? request
        : request instanceof URL
        ? request.href
        : request.url,
    );
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new TypeError("Conformance transport requires a JSON string body");
    }
    const response = await app.inject({
      method: (init?.method ?? "GET") as
        | "GET"
        | "POST"
        | "PATCH"
        | "DELETE",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(body === undefined || body === null ? {} : { payload: body }),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  api.setToken("dormant-conformance-session");

  return Object.freeze({
    app,
    api,
    human: createAuthorizedHumanMemoryClient({
      authority: __mintAuthorizedHumanMemoryTestAuthorityForTesting(),
      api: createHumanMemoryProcessorTransport({
        api, crypto: new LatticeCrypto(), subjectId: input.routeAuthority.userId,
      }),
      content: input.humanContent,
      journal: input.humanJournal,
      createOperationId: ({ kind, memoryId }) =>
        `conformance:${kind}:${memoryId}`,
    }),
    agentToolsNode: createProtectedMemoryTestToolsNode({
      authority: __mintProtectedMemoryToolsNodeTestAuthorityForTesting(),
      repository: input.agentRepository,
      ...(input.agentAccess === undefined
        ? {}
        : { access: input.agentAccess }),
      ...(input.agentProjection === undefined
        ? {}
        : { projection: input.agentProjection }),
      ...(input.agentScopeLifecycle === undefined
        ? {}
        : { scopeLifecycle: input.agentScopeLifecycle }),
    }),
    close: async () => app.close(),
  });
}
