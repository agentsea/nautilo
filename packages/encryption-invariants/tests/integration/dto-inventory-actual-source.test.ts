import {
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { resolve } from "node:path";

import {
  discoverDtoInventory,
  type DtoInventoryObservation,
} from "../../src/node/dto-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");
let actualObservations: readonly DtoInventoryObservation[];
let repeatedObservations: readonly DtoInventoryObservation[];
setDefaultTimeout(120_000);

beforeAll(async () => {
  // Cold hosted runners make a full TypeScript inventory materially slower
  // than local warm-cache runs. Compute it twice, sequentially, to preserve
  // the determinism assertion without re-scanning the repository in every
  // individual assertion test.
  actualObservations = await discoverDtoInventory(repoRoot);
  repeatedObservations = await discoverDtoInventory(repoRoot);
});

function findObservation(
  observations: readonly DtoInventoryObservation[],
  locator: string,
): DtoInventoryObservation {
  const observation = observations.find((candidate) => candidate.locator === locator);
  if (!observation) throw new Error(`missing DTO inventory observation: ${locator}`);
  return observation;
}

describe("DTO inventory against the actual Nautilo source tree", () => {
  test("is byte-deterministic, sorted, and duplicate-free", () => {
    expect(JSON.stringify(actualObservations)).toBe(
      JSON.stringify(repeatedObservations),
    );
    expect(actualObservations.map((item) => item.id)).toEqual(
      [...actualObservations.map((item) => item.id)].sort(),
    );
    expect(new Set(actualObservations.map((item) => item.id)).size).toBe(
      actualObservations.length,
    );
    expect(new Set(actualObservations.map((item) => item.locator)).size).toBe(
      actualObservations.length,
    );
  });

  test("finds canonical HTTP and WebSocket boundaries", () => {
    const observations = actualObservations;

    expect(
      findObservation(
        observations,
        "http:request_response:POST /api/rooms/:roomId/messages",
      ),
    ).toMatchObject({
      transport: "http",
      direction: "request_response",
      sourcePath: "packages/server/src/routes/rooms.ts",
    });
    expect(
      findObservation(
        observations,
        "http:request_response:GET /api/rooms/:id/messages",
      ),
    ).toMatchObject({
      transport: "http",
      sourcePath: "packages/server/src/routes/sessions.ts",
    });
    expect(
      findObservation(observations, "http:request_response:GET /office-engine/*"),
    ).toMatchObject({
      transport: "http",
      sourcePath: "packages/server/src/routes/office-proxy.ts",
    });
    expect(
      findObservation(observations, "http:request_response:POST /office-engine/*"),
    ).toMatchObject({
      transport: "http",
      sourcePath: "packages/server/src/routes/office-proxy.ts",
    });
    const memoryPatch = findObservation(
      observations,
      "http:request_response:PATCH /api/memory/:id",
    );
    expect(memoryPatch.structuralSignatures).toContain(
      "request.body:{content?:string;importance?:number;namespaceId?:string}",
    );
    expect(memoryPatch.structuralSignatures).toContain("request.params:{id:string}");
    expect(
      findObservation(observations, "ws:server_to_client:message.new"),
    ).toMatchObject({
      transport: "ws",
      direction: "server_to_client",
      contract: "MessageNewEvent",
      sourcePath: "packages/types/src/realtime.ts",
    });
    expect(findObservation(observations, "ws:client_to_server:typing.ping")).toMatchObject({
      sourcePath: "packages/server/src/routes/ws.ts",
    });
  });

  test("distinguishes SSE events produced by the server from legacy events only accepted by clients", () => {
    const observations = actualObservations;

    expect(findObservation(
      observations,
      "sse:produced:GET /api/workspace/artifacts/events#changed",
    )).toMatchObject({
      sourcePath: "packages/server/src/routes/workspace-artifacts.ts",
    });
    expect(
      findObservation(
        observations,
        "sse:produced:GET /api/workspace/artifacts/events#document.mutation.committed",
      ),
    ).toBeDefined();
    expect(
      findObservation(
        observations,
        "sse:accepted:GET /api/workspace/artifacts/events#document.patch.applied",
      ),
    ).toMatchObject({
      sourcePath: "packages/api-client/src/client.ts",
    });
    expect(findObservation(
      observations,
      "sse:produced:GET /api/workspace/artifacts/events#document.patch.applied",
    )).toMatchObject({
      sourcePath: "packages/server/src/routes/workspace-artifacts.ts",
    });
    for (const event of [
      "soul.started",
      "soul.delta",
      "soul.completed",
      "soul.error",
      "status",
    ]) {
      const channel = event.startsWith("soul.")
        ? "POST /api/profile/generate-soul/stream"
        : "GET /api/apps/events";
      expect(findObservation(
        observations,
        `sse:produced:${channel}#${event}`,
      )).toBeDefined();
    }
    for (const event of [
      "soul.started",
      "soul.delta",
      "soul.completed",
      "soul.error",
      "status",
    ]) {
      const channel = event.startsWith("soul.")
        ? "POST /api/profile/generate-soul/stream"
        : "GET /api/apps/events";
      expect(findObservation(
        observations,
        `sse:accepted:${channel}#${event}`,
      )).toBeDefined();
    }
    expect(findObservation(
      observations,
      "sse:produced:POST /api/profile/generate-soul/stream#soul.delta",
    )).toMatchObject({
      sourcePath: "packages/server/src/routes/profile.ts",
    });
    expect(findObservation(
      observations,
      "sse:produced:GET /api/apps/events#status",
    )).toMatchObject({
      sourcePath: "packages/server/src/apps/app-routes.ts",
    });
    expect(findObservation(
      observations,
      "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta",
    ).structuralSignatures).toEqual([
      "consumer:apps/desktop/electron/main.ts#1:event.payload:"
        + "{error?:unknown;fallback?:unknown;soulFile?:unknown;text?:unknown}",
    ]);
    expect(findObservation(
      observations,
      "sse:accepted:GET /api/apps/events#status",
    )).toMatchObject({
      sourcePath: "packages/api-client/src/client.ts",
    });
    expect(findObservation(
      observations,
      "sse:produced:GET /api/apps/events#changed",
    ).structuralSignatures).not.toEqual(findObservation(
      observations,
      "sse:produced:GET /api/workspace/artifacts/events#changed",
    ).structuralSignatures);
  });

  test("finds relay and app-bridge discriminated frames", () => {
    const observations = actualObservations;

    expect(findObservation(observations, "relay:client_to_server:relay:result")).toMatchObject({
      contract: "RelayResultMessage",
      sourcePath: "packages/relay/src/protocol.ts",
    });
    expect(findObservation(observations, "relay:server_to_client:relay:dispatch")).toMatchObject({
      contract: "RelayDispatchMessage",
    });
    expect(
      findObservation(
        observations,
        "app_bridge:app_to_host:nautilo.app.document.req#write",
      ),
    ).toMatchObject({
      contract: "AppDocumentWriteRequest",
      sourcePath: "apps/workbench/src/apps/app-bridge.ts",
    });
    expect(
      findObservation(
        observations,
        "app_bridge:host_to_app:nautilo.app.live-proposal",
      ),
    ).toBeDefined();
  });

  test("enumerates precise arbitrary payload fields instead of classifying their container wholesale", () => {
    const observations = actualObservations;

    expect(
      findObservation(
        observations,
        "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
    ).arbitraryPayloads,
    ).toEqual([
      "activeMiniApp",
      "artifactRefs",
      "attachments",
      "cardContinuation",
      "clientActionSessionId",
      "focusedResources",
      "liveMiniAppSession",
      "liveShadow",
      "mentionedHumanUserIds",
    ]);
    expect(
      findObservation(
        observations,
        "http:produced_arbitrary:packages/types/src/api.ts#JobStatusResponse",
      ).arbitraryPayloads,
    ).toEqual(["input", "result"]);
    expect(
      findObservation(
        observations,
        "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
      ).arbitraryPayloads,
    ).toEqual([
      "args",
      "computerUseRequest.arguments",
      "computerUseRequest.contract",
      "desktopFilesystemGrantRequest.operation",
      "desktopFilesystemGrantRequest.policy.lifetime",
      "desktopFilesystemGrantRequest.requiredOperations[]",
      "desktopFilesystemGrantRequest.subject",
      "workstationShellBinding.operation",
    ]);
    expect(
      findObservation(
        observations,
        "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppStateSetRequest",
      ).arbitraryPayloads,
    ).toEqual(["value"]);
    expect(
      findObservation(
        observations,
        "http:request_response:POST /api/invites/:token/redeem",
      ).arbitraryPayloads,
    ).toEqual([
      "request.body.displayName",
      "request.body.email",
      "request.body.forcePasswordChange",
      "request.body.handle",
      "request.body.password",
      "request.body.pin",
      "response.body.code",
      "response.body.error",
      "response.body.message",
    ]);
    expect(
      findObservation(
        observations,
        "http:request_response:POST /api/file/invoke-direct",
      ).arbitraryPayloads,
    ).toEqual(["request.body.args"]);
    expect(
      findObservation(
        observations,
        "http:request_response:POST /api/chat",
      ).arbitraryPayloads,
    ).toEqual([
      "request.body.activeMiniApp.selection",
      "request.body.activeMiniApp.summary",
    ]);
  });
});
