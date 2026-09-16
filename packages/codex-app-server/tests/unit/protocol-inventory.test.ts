import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectProtocolInventory } from "../../src/protocol-inventory";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "protocol-inventory-test-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "v2"), { recursive: true });

  const unions: Record<string, string> = {
    "ClientRequest.ts":
      'export type ClientRequest = { "method": "thread/start" } | { "method": "turn/start" };',
    "ClientNotification.ts":
      'export type ClientNotification = { "method": "initialized" };',
    "ServerRequest.ts":
      'export type ServerRequest = { "method": "item/tool/call" };',
    "ServerNotification.ts":
      'export type ServerNotification = { "method": "turn/completed" };',
    "v2/ThreadItem.ts":
      'export type ThreadItem = { "type": "agentMessage" } | { "type": "dynamicToolCall" };',
    "v2/ThreadStartResponse.ts": "export type ThreadStartResponse = {};",
    "DynamicToolCallResponse.ts":
      "export type DynamicToolCallResponse = {};",
  };

  for (const [path, source] of Object.entries(unions)) {
    writeFileSync(join(root, path), source);
  }
  return root;
}

describe("collectProtocolInventory", () => {
  test("keeps raw generated protocol trees out of the repository", () => {
    expect(
      existsSync(
        join(
          import.meta.dir,
          "../../generated/0.146.0/upstream",
        ),
      ),
    ).toBe(false);
  });

  test("inventories every protocol union and response surface", () => {
    const inventory = collectProtocolInventory(fixtureRoot());

    expect(inventory.counts).toEqual({
      client_request: 2,
      response: 2,
      client_notification: 1,
      server_request: 1,
      server_notification: 1,
      thread_item: 2,
    });
    expect(inventory.entries).toContainEqual({
      surface: "server_request",
      name: "item/tool/call",
      generatedFile: "ServerRequest.ts",
    });
    expect(inventory.entries).toContainEqual({
      surface: "thread_item",
      name: "dynamicToolCall",
      generatedFile: "v2/ThreadItem.ts",
    });
  });

  test("fails when a required union surface is absent", () => {
    const root = fixtureRoot();
    rmSync(join(root, "ServerRequest.ts"));

    expect(() => collectProtocolInventory(root)).toThrow(
      "Required generated union is missing: ServerRequest.ts",
    );
  });

  test("fails when a generated union has no classifiable members", () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "ClientNotification.ts"),
      "export type ClientNotification = never;",
    );

    expect(() => collectProtocolInventory(root)).toThrow(
      "Generated union has no method members: ClientNotification.ts",
    );
  });
});
