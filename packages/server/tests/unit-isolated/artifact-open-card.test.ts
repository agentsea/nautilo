/**
 * D424 — ArtifactOpenCard receive-contract server helpers. Pins:
 *   - `collectWorkspaceArtifactExternalIds`: legacy `artifactRefs` +
 *     `focusedResources` kind `workspace-artifact` are collected; local-file
 *     focus refs are NEVER collected; dedupe by external id preserves order.
 *   - `persistMessageArtifactOpenRefs`: write-time gate resolves external →
 *     internal ids attached to the canonical room namespace, records the
 *     durable pointer-only relation; best-effort (no throw on DB error).
 *   - `hydrateMessageArtifactOpenRefs`: hydrates safe `MessageArtifactOpenRef[]`
 *     for a single message; omitted when canonical namespace / roomId missing.
 */
import { describe, expect, mock, test } from "bun:test";
import * as actualDb from "@nautilo/db";
import type {
  ChatArtifactRef,
  ChatFocusedResourceRef,
  MessageArtifactOpenRef,
} from "@nautilo/types";

const resolveCanonicalCalls: Array<{
  externalArtifactIds: string[];
  canonicalRoomNamespaceId: string;
}> = [];
const recordCalls: Array<{ messageId: number; artifactInternalIds: string[] }> = [];
const hydrateCalls: Array<{
  messageIds: number[];
  canonicalRoomNamespaceId: string;
  roomId: string;
}> = [];

const findArtifactInternalIdsForCanonicalNamespaceMock = mock(
  async (args: {
    externalArtifactIds: readonly string[];
    canonicalRoomNamespaceId: string;
  }): Promise<Map<string, string>> => {
    resolveCanonicalCalls.push({
      externalArtifactIds: [...args.externalArtifactIds],
      canonicalRoomNamespaceId: args.canonicalRoomNamespaceId,
    });
    const out = new Map<string, string>();
    if (args.canonicalRoomNamespaceId === "ns-canonical") {
      if (args.externalArtifactIds.includes("ext-a")) out.set("ext-a", "int-a");
      if (args.externalArtifactIds.includes("ext-b")) out.set("ext-b", "int-b");
    }
    return out;
  },
);

const recordMessageArtifactsMock = mock(async (args: {
  messageId: number;
  artifactInternalIds: readonly string[];
}): Promise<void> => {
  recordCalls.push({ messageId: args.messageId, artifactInternalIds: [...args.artifactInternalIds] });
});

let nextHydrate: Map<number, MessageArtifactOpenRef[]> = new Map();
const hydrateMessageArtifactsMock = mock(
  async (args: {
    messageIds: readonly number[];
    canonicalRoomNamespaceId: string;
    roomId: string;
  }): Promise<Map<number, MessageArtifactOpenRef[]>> => {
    hydrateCalls.push({
      messageIds: [...args.messageIds],
      canonicalRoomNamespaceId: args.canonicalRoomNamespaceId,
      roomId: args.roomId,
    });
    return nextHydrate;
  },
);

mock.module("@nautilo/db", () => ({
  ...actualDb,
  findArtifactByIdForNamespaces: mock(async () => null),
  findArtifactInternalIdsForCanonicalNamespace: findArtifactInternalIdsForCanonicalNamespaceMock,
  recordMessageArtifacts: recordMessageArtifactsMock,
  hydrateMessageArtifacts: hydrateMessageArtifactsMock,
}));

const {
  collectWorkspaceArtifactExternalIds,
  persistMessageArtifactOpenRefs,
  hydrateMessageArtifactOpenRefs,
} = await import("../../src/messaging/artifact-refs");

const artifactRef = (artifactId: string): ChatArtifactRef => ({
  artifactId,
  path: "",
  mimeType: "application/octet-stream",
  size: 0,
});

const wsArtifact = (artifactId: string): ChatFocusedResourceRef => ({
  kind: "workspace-artifact",
  artifactId,
});

const localFile: ChatFocusedResourceRef = {
  kind: "local-file",
  path: "/abs/path/to/file.txt",
  rootPath: "/abs/path",
  name: "file.txt",
  relayId: "relay-1",
};

describe("collectWorkspaceArtifactExternalIds", () => {
  test("collects legacy artifactRefs + focusedResources workspace-artifact, dedupes, preserves order", () => {
    const out = collectWorkspaceArtifactExternalIds({
      artifactRefs: [artifactRef("ext-a"), artifactRef("ext-b")],
      focusedResources: [wsArtifact("ext-b"), wsArtifact("ext-c")],
    });
    expect(out).toEqual(["ext-a", "ext-b", "ext-c"]);
  });

  test("local-file focus refs are NEVER collected", () => {
    const out = collectWorkspaceArtifactExternalIds({
      artifactRefs: [artifactRef("ext-a")],
      focusedResources: [localFile, wsArtifact("ext-a"), localFile],
    });
    expect(out).toEqual(["ext-a"]);
  });

  test("empty inputs → []", () => {
    expect(collectWorkspaceArtifactExternalIds({ artifactRefs: [], focusedResources: [] })).toEqual([]);
  });
});

describe("persistMessageArtifactOpenRefs", () => {
  test("no-ops when external ids empty", async () => {
    resolveCanonicalCalls.length = 0;
    recordCalls.length = 0;
    await persistMessageArtifactOpenRefs({
      messageId: 1,
      externalArtifactIds: [],
      canonicalRoomNamespaceId: "ns-canonical",
    });
    expect(resolveCanonicalCalls.length).toBe(0);
    expect(recordCalls.length).toBe(0);
  });

  test("no-ops when canonical namespace id missing", async () => {
    resolveCanonicalCalls.length = 0;
    recordCalls.length = 0;
    await persistMessageArtifactOpenRefs({
      messageId: 1,
      externalArtifactIds: ["ext-a"],
      canonicalRoomNamespaceId: null,
    });
    expect(resolveCanonicalCalls.length).toBe(0);
    expect(recordCalls.length).toBe(0);
  });

  test("resolves canonical-namespace internal ids and records ordered, deduped relation", async () => {
    resolveCanonicalCalls.length = 0;
    recordCalls.length = 0;
    await persistMessageArtifactOpenRefs({
      messageId: 42,
      externalArtifactIds: ["ext-a", "ext-b", "ext-a", "ext-missing"],
      canonicalRoomNamespaceId: "ns-canonical",
    });
    expect(resolveCanonicalCalls).toEqual([
      { externalArtifactIds: ["ext-a", "ext-b", "ext-a", "ext-missing"], canonicalRoomNamespaceId: "ns-canonical" },
    ]);
    expect(recordCalls).toEqual([{ messageId: 42, artifactInternalIds: ["int-a", "int-b"] }]);
  });

  test("records nothing when no artifacts are attached to the canonical namespace", async () => {
    resolveCanonicalCalls.length = 0;
    recordCalls.length = 0;
    await persistMessageArtifactOpenRefs({
      messageId: 42,
      externalArtifactIds: ["ext-a"],
      canonicalRoomNamespaceId: "ns-foreign",
    });
    expect(recordCalls.length).toBe(0);
  });

  test("best-effort: a DB error is swallowed (never throws)", async () => {
    resolveCanonicalCalls.length = 0;
    recordCalls.length = 0;
    findArtifactInternalIdsForCanonicalNamespaceMock.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await persistMessageArtifactOpenRefs({
      messageId: 42,
      externalArtifactIds: ["ext-a"],
      canonicalRoomNamespaceId: "ns-canonical",
    });
    expect(recordCalls.length).toBe(0);
  });
});

describe("hydrateMessageArtifactOpenRefs", () => {
  test("returns [] when canonical namespace id missing", async () => {
    hydrateCalls.length = 0;
    const out = await hydrateMessageArtifactOpenRefs({
      messageId: 7,
      canonicalRoomNamespaceId: null,
      roomId: "room-1",
    });
    expect(out).toEqual([]);
    expect(hydrateCalls.length).toBe(0);
  });

  test("returns [] when roomId missing", async () => {
    hydrateCalls.length = 0;
    const out = await hydrateMessageArtifactOpenRefs({
      messageId: 7,
      canonicalRoomNamespaceId: "ns",
      roomId: "",
    });
    expect(out).toEqual([]);
    expect(hydrateCalls.length).toBe(0);
  });

  test("hydrates safe refs for the message via the db helper", async () => {
    hydrateCalls.length = 0;
    nextHydrate = new Map([
      [
        7,
        [
          {
            artifactInternalId: "int-a",
            roomId: "room-1",
            basename: "q3.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2048,
          },
        ],
      ],
    ]);
    const out = await hydrateMessageArtifactOpenRefs({
      messageId: 7,
      canonicalRoomNamespaceId: "ns-canonical",
      roomId: "room-1",
    });
    expect(hydrateCalls).toEqual([
      { messageIds: [7], canonicalRoomNamespaceId: "ns-canonical", roomId: "room-1" },
    ]);
    expect(out).toEqual([
      { artifactInternalId: "int-a", roomId: "room-1", basename: "q3.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
    ]);
  });

  test("best-effort: a DB error is swallowed → []", async () => {
    hydrateMessageArtifactsMock.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const out = await hydrateMessageArtifactOpenRefs({
      messageId: 7,
      canonicalRoomNamespaceId: "ns",
      roomId: "room-1",
    });
    expect(out).toEqual([]);
  });
});
