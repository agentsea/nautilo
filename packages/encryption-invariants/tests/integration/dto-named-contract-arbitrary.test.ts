import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverNamedDtoInventory } from "../../src/node/dto-inventory";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

test("named relay, app-bridge, and API contracts expose direct, nested, and aliased any", async () => {
  const root = await mkdtemp(join(tmpdir(), "m220 named arbitrary "));
  temporaryRoots.push(root);
  const relayRoot = join(root, "packages/relay/src");
  const appRoot = join(root, "apps/workbench/src/apps");
  const typesRoot = join(root, "packages/types/src");
  const messagingRoot = join(root, "packages/server/src/messaging");
  await Promise.all([
    mkdir(relayRoot, { recursive: true }),
    mkdir(appRoot, { recursive: true }),
    mkdir(typesRoot, { recursive: true }),
    mkdir(messagingRoot, { recursive: true }),
  ]);

  await writeFile(join(relayRoot, "protocol.ts"), `
    import type { ImportedAlias, ImportedRelayMessage } from "./external";
    type AliasAny = any;
    type NestedAlias = { value: AliasAny };
    export type RelayResultMessage = { type: "relay:result"; ok: true };
    export type RelayDispatchMessage = {
      type: "relay:dispatch";
      direct: any;
      nested: { value: any };
      aliased: AliasAny;
      deep: NestedAlias;
      imported: ImportedAlias;
    };
    export type RelayClientMessage = RelayResultMessage;
    export type RelayServerMessage = RelayDispatchMessage | ImportedRelayMessage;
  `);
  await writeFile(join(relayRoot, "external.ts"), `
    export type ImportedAlias = { value: string };
    export type ImportedRelayMessage = {
      type: "relay:imported";
      payload: ImportedAlias;
    };
  `);
  await writeFile(join(appRoot, "app-bridge.ts"), `
    import type { ImportedAlias } from "./external";
    type AliasAny = any;
    type AppNestedAlias = { value: AliasAny };
    type AppStateSetRequest = {
      type: "nautilo.app.state.req";
      op: "set";
      direct: any;
      nested: { value: any };
      aliased: AliasAny;
      deep: AppNestedAlias;
      imported: ImportedAlias;
    };
    type AppBridgeRequest = AppStateSetRequest;
  `);
  await writeFile(join(appRoot, "external.ts"), `
    export type ImportedAlias = { value: string };
  `);
  await writeFile(join(typesRoot, "api.ts"), `
    import type { ImportedAlias } from "./external";
    type AliasAny = any;
    type ApiNestedAlias = { value: AliasAny };
    export type ExampleResponse = {
      direct: any;
      nested: { value: any };
      aliased: AliasAny;
      deep: ApiNestedAlias;
      imported: ImportedAlias;
    };
  `);
  await writeFile(join(typesRoot, "external.ts"), `
    export type ImportedAlias = { value: string };
  `);
  await writeFile(join(messagingRoot, "dispatch.ts"), `
    type RoomPostMessageBody = { content: string };
  `);

  const observations = await discoverNamedDtoInventory(root);
  const importedRelayObservation = observations.find((item) =>
    item.locator === "relay:server_to_client:relay:imported"
  );
  expect(importedRelayObservation?.contract).toBe("ImportedRelayMessage");
  expect(importedRelayObservation?.sourcePath).toBe("packages/relay/src/external.ts");
  for (const locator of [
    "relay:server_to_client:relay:dispatch",
    "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
    "app_bridge:app_to_host:nautilo.app.state.req#set",
    "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppStateSetRequest",
    "http:produced_arbitrary:packages/types/src/api.ts#ExampleResponse",
  ]) {
    const observation = observations.find((item) => item.locator === locator);
    expect(observation?.arbitraryPayloads).toEqual([
      "aliased",
      "deep.value",
      "direct",
      "imported",
      "nested.value",
    ]);
    expect(observation?.structuralSignatures).not.toEqual([]);
    expect(observation?.structuralSignatures.join("\n")).toContain("any");
  }
});
