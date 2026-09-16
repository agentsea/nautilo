import { describe, test, expect, spyOn, afterEach } from "bun:test";
import * as db from "@nautilo/db";
import { createReadArtifactEventsTool } from "../../src/tools/file/read-artifact-events";
import * as trustAgentDb from "../../src/store/trust-agent-db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";

type ToolJson = Record<string, unknown>;

function parseToolJson(raw: unknown): ToolJson {
  return JSON.parse(String(raw)) as ToolJson;
}

function envelope(over?: Partial<MemoryAccessEnvelope>): MemoryAccessEnvelope {
  return {
    agentId: AGENT_ID,
    ownerId: USER_ID,
    readableNamespaces: ["ns-read"],
    writableNamespaces: ["ns-write"],
    mutableNamespaces: ["ns-mut"],
    ...over,
  } as MemoryAccessEnvelope;
}

describe("read_artifact_events", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("missing envelope agentId → no_agent_in_envelope without DB", async () => {
    const spFind = spyOn(db, "findArtifactByPathForNamespaces");
    const spDrain = spyOn(db, "drainPendingArtifactEventsForNamespaces");
    restores.push(() => spFind.mockRestore(), () => spDrain.mockRestore());

    const tool = createReadArtifactEventsTool({
      userId: USER_ID,
      memoryAccessEnvelope: {
        ownerId: USER_ID,
        readableNamespaces: ["ns-read"],
      } as MemoryAccessEnvelope,
    });
    const raw = await tool.invoke({ path: "artifacts/quiz.html" });
    const out = parseToolJson(raw);
    expect(out).toEqual({ ok: false, error: "no_agent_in_envelope" });
    expect(spFind).not.toHaveBeenCalled();
    expect(spDrain).not.toHaveBeenCalled();
  });

  test("no readable namespaces → no_readable_namespaces without DB", async () => {
    const spFind = spyOn(db, "findArtifactByPathForNamespaces");
    const spDrain = spyOn(db, "drainPendingArtifactEventsForNamespaces");
    restores.push(() => spFind.mockRestore(), () => spDrain.mockRestore());

    const tool = createReadArtifactEventsTool({
      userId: USER_ID,
      memoryAccessEnvelope: envelope({ readableNamespaces: [] }),
    });
    const raw = await tool.invoke({ path: "artifacts/quiz.html" });
    const out = parseToolJson(raw);
    expect(out).toEqual({ ok: false, error: "no_readable_namespaces" });
    expect(spFind).not.toHaveBeenCalled();
    expect(spDrain).not.toHaveBeenCalled();
  });

  test("artifact not found → artifact_not_found", async () => {
    const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
      async (_ctx, fn) => fn({} as never),
    );
    const spFind = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    const spDrain = spyOn(db, "drainPendingArtifactEventsForNamespaces");
    restores.push(
      () => spTrust.mockRestore(),
      () => spFind.mockRestore(),
      () => spDrain.mockRestore(),
    );

    const tool = createReadArtifactEventsTool({
      userId: USER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const raw = await tool.invoke({ path: "artifacts/missing.html" });
    const out = parseToolJson(raw);
    expect(out).toEqual({
      ok: false,
      error: "artifact_not_found",
      path: "artifacts/missing.html",
    });
    expect(spDrain).not.toHaveBeenCalled();
  });

  test("happy drain returns events and drained:true", async () => {
    const createdAt = new Date("2026-06-04T12:00:00.000Z");
    const artifactRow = {
      id: "11111111-1111-4111-8111-111111111111",
      artifactId: "ext-art-1",
      path: "artifacts/quiz.html",
      mimeType: "text/html",
      size: 100,
      storageUri: "file:///tmp/quiz.html",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    };
    const eventRows = [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        namespaceId: "ns-read",
        agentId: AGENT_ID,
        artifactId: "ext-art-1",
        topic: "submitted",
        payload: { score: 9 },
        createdAt,
      },
    ];

    const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
      async (_ctx, fn) => fn({} as never),
    );
    const spFind = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(
      artifactRow as never,
    );
    const spDrain = spyOn(db, "drainPendingArtifactEventsForNamespaces").mockResolvedValue(
      eventRows as never,
    );
    restores.push(
      () => spTrust.mockRestore(),
      () => spFind.mockRestore(),
      () => spDrain.mockRestore(),
    );

    const tool = createReadArtifactEventsTool({
      userId: USER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const raw = await tool.invoke({ path: "artifacts/quiz.html" });
    const out = parseToolJson(raw);
    expect(out).toEqual({
      ok: true,
      path: "artifacts/quiz.html",
      artifactId: "ext-art-1",
      count: 1,
      events: [
        {
          id: eventRows[0]!.id,
          topic: "submitted",
          payload: { score: 9 },
          createdAt: createdAt.toISOString(),
          namespaceId: "ns-read",
        },
      ],
      drained: true,
    });
    expect(spDrain).toHaveBeenCalledWith(
      {
        readableNamespaceIds: ["ns-read"],
        agentId: AGENT_ID,
        artifactId: "ext-art-1",
      },
      {},
    );
  });

  test("empty queue → count 0 and drained:true", async () => {
    const createdAt = new Date("2026-06-04T12:00:00.000Z");
    const artifactRow = {
      id: "11111111-1111-4111-8111-111111111111",
      artifactId: "ext-art-2",
      path: "artifacts/empty.html",
      mimeType: "text/html",
      size: 1,
      storageUri: "file:///tmp/empty.html",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    };

    const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
      async (_ctx, fn) => fn({} as never),
    );
    const spFind = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(
      artifactRow as never,
    );
    const spDrain = spyOn(db, "drainPendingArtifactEventsForNamespaces").mockResolvedValue([]);
    restores.push(
      () => spTrust.mockRestore(),
      () => spFind.mockRestore(),
      () => spDrain.mockRestore(),
    );

    const tool = createReadArtifactEventsTool({
      userId: USER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const raw = await tool.invoke({ path: "artifacts/empty.html" });
    const out = parseToolJson(raw);
    expect(out["ok"]).toBe(true);
    expect(out["count"]).toBe(0);
    expect(out["events"]).toEqual([]);
    expect(out["drained"]).toBe(true);
  });
});
