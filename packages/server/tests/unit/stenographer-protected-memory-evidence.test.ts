import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DirectDatabase } from "@nautilo/db";
import type { CanonicalJsonValue } from "@nautilo/lattice-bridge";
import type { OpenedProtectedStenographerSources } from "@nautilo/runtime";
import { classifyPersonalMemoryEvidence } from "@nautilo/reflection-bridge/server";

import {
  createProtectedStenographerMemoryEvidence,
} from "../../src/background/stenographer-composition";

const ROOM = "10000000-0000-4000-8000-000000000001";
const NAMESPACE = "20000000-0000-4000-8000-000000000001";
const HUMAN = "30000000-0000-4000-8000-000000000001";
const OTHER_HUMAN = "30000000-0000-4000-8000-000000000002";

function fingerprint(messageId: number, editRevision: number, content: string) {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    "nautilo/stenographer/message-observation/v1",
    messageId,
    editRevision,
    content,
  ]), "utf8").digest("hex")}`;
}

function database(...rows: readonly Readonly<{
  id?: number;
  role: "user" | "assistant" | "tool";
  agentId: string | null;
  authorHumanId?: string;
}>[]): DirectDatabase {
  let read = 0;
  const query = {
    from() { return this; },
    innerJoin() { return this; },
    where() { return this; },
    limit: () => {
      const row = rows[Math.min(read, rows.length - 1)]!;
      read += 1;
      return Promise.resolve([{
      id: row.id ?? 11,
      editRevision: 0,
      role: row.role,
      externalAuthorship: false,
      authorHumanId: row.authorHumanId ?? HUMAN,
      agentId: row.agentId,
      roomId: ROOM,
      namespaceId: NAMESPACE,
      disabledAt: null,
    }]);
    },
  };
  return {
    select: () => query,
  } as unknown as DirectDatabase;
}

function sources(
  role: "user" | "assistant" | "tool",
  sensitiveMetadata?: Readonly<Record<string, CanonicalJsonValue>>,
): OpenedProtectedStenographerSources {
  const message = Object.freeze({
    kind: "message" as const,
    objectId: "message-object-11",
    source: "current" as const,
    messageId: 11,
    editRevision: 0,
    createdAt: new Date("2026-10-13T00:00:00.000Z"),
    participantId: "participant-11",
    displayLabel: "Alice",
    role,
    conversationalBoundary: true,
    payload: Object.freeze({
      role,
      content: role === "user" ? "Remember blue." : "I remembered blue.",
      ...(sensitiveMetadata === undefined ? {} : { sensitiveMetadata }),
    }),
  });
  return Object.freeze({
    orderedSources: Object.freeze([message]),
    currentMessages: Object.freeze([message]),
    priorMessages: Object.freeze([]),
    events: Object.freeze([]),
    latestRollup: null,
  });
}

function dependency(content: string) {
  return Object.freeze({
    kind: "source" as const,
    sourceKind: "message",
    logicalSourceRef: "message:11",
    observedRevision: "0",
    observedContentFingerprint: fingerprint(11, 0, content),
    terminalAuthorityLeafHandle: NAMESPACE,
  });
}

describe("protected Stenographer Memory evidence", () => {
  test("attributes an exact opened user Message to its current structural Human", async () => {
    let currentChecks = 0;
    const evidence = createProtectedStenographerMemoryEvidence({
      db: database({ role: "user", agentId: null }),
      roomId: ROOM,
      namespaceId: NAMESPACE,
      sources: sources("user"),
      audience: {
        readAudience: () => Promise.resolve({
          humanIds: [HUMAN],
          includesPublicBoundary: false,
        }),
      },
      assertCurrent: () => {
        currentChecks += 1;
        return Promise.resolve();
      },
    });
    expect(await evidence.readSource(dependency("Remember blue.")))
      .toEqual({
        status: "current",
        audienceHumanIds: [HUMAN],
        includesPublicBoundary: false,
        kind: "human",
        authorHumanId: HUMAN,
      });
    expect(await classifyPersonalMemoryEvidence({
      dependencies: [dependency("Remember blue.")],
      ports: evidence,
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    })).toEqual({ kind: "human", humanUserId: HUMAN });
    expect(currentChecks).toBeGreaterThanOrEqual(4);
  });

  test("keeps authenticated AI with absent protected ancestry service-funded", async () => {
    const ancestry = {
      version: 1,
      status: "complete",
      dependencies: [{
        kind: "source",
        sourceKind: "message",
        logicalObjectRef: "message:9",
        observedRevision: "0",
        observedContentFingerprint: "sha256:ancestor",
        terminalAuthorityLeafHandle: NAMESPACE,
      }],
    };
    const evidence = createProtectedStenographerMemoryEvidence({
      db: database({ role: "assistant", agentId: "agent-1" }),
      roomId: ROOM,
      namespaceId: NAMESPACE,
      sources: sources("assistant", {
        nautilo_memory_model_exposure: ancestry,
      }),
      audience: {
        readAudience: () => Promise.resolve({
          humanIds: [HUMAN],
          includesPublicBoundary: false,
        }),
      },
      assertCurrent: () => Promise.resolve(),
    });
    expect(await evidence.readSource(dependency("I remembered blue.")))
      .toMatchObject({ status: "current", kind: "unknown" });
    expect(await classifyPersonalMemoryEvidence({
      dependencies: [dependency("I remembered blue.")],
      ports: evidence,
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    })).toEqual({ kind: "service", reason: "incomplete" });
    expect(await evidence.readSource({
      kind: "source",
      sourceKind: "message",
      logicalSourceRef: "message:9",
      observedRevision: "0",
      observedContentFingerprint: "sha256:ancestor",
      terminalAuthorityLeafHandle: NAMESPACE,
    })).toBeNull();
  });

  test("follows complete opened AI ancestry to its exact Human", async () => {
    const ancestry = {
      version: 1,
      status: "complete",
      dependencies: [{
        kind: "source",
        sourceKind: "message",
        logicalObjectRef: "message:9",
        observedRevision: "0",
        observedContentFingerprint: fingerprint(9, 0, "Remember blue."),
        terminalAuthorityLeafHandle: NAMESPACE,
      }],
    };
    const assistant = sources("assistant", {
      nautilo_memory_model_exposure: ancestry,
    }).currentMessages[0]!;
    const user = Object.freeze({
      ...sources("user").currentMessages[0]!,
      objectId: "message-object-9",
      source: "prior" as const,
      messageId: 9,
      participantId: "participant-9",
    });
    const opened = Object.freeze({
      orderedSources: Object.freeze([user, assistant]),
      currentMessages: Object.freeze([assistant]),
      priorMessages: Object.freeze([user]),
      events: Object.freeze([]),
      latestRollup: null,
    });
    const evidence = createProtectedStenographerMemoryEvidence({
      db: database(
        { id: 11, role: "assistant", agentId: "agent-1" },
        { id: 9, role: "user", agentId: null },
      ),
      roomId: ROOM,
      namespaceId: NAMESPACE,
      sources: opened,
      audience: {
        readAudience: () => Promise.resolve({
          humanIds: [HUMAN],
          includesPublicBoundary: false,
        }),
      },
      assertCurrent: () => Promise.resolve(),
    });
    expect(await classifyPersonalMemoryEvidence({
      dependencies: [dependency("I remembered blue.")],
      ports: evidence,
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    })).toEqual({ kind: "human", humanUserId: HUMAN });
  });

  test("keeps an exact opened user source with a shared audience service-funded", async () => {
    const evidence = createProtectedStenographerMemoryEvidence({
      db: database({ role: "user", agentId: null }),
      roomId: ROOM,
      namespaceId: NAMESPACE,
      sources: sources("user"),
      audience: {
        readAudience: () => Promise.resolve({
          humanIds: [HUMAN, OTHER_HUMAN],
          includesPublicBoundary: false,
        }),
      },
      assertCurrent: () => Promise.resolve(),
    });
    expect(await classifyPersonalMemoryEvidence({
      dependencies: [dependency("Remember blue.")],
      ports: evidence,
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    })).toEqual({ kind: "service", reason: "shared" });
  });

  test("fails a read when the current processor authority changes", async () => {
    let checks = 0;
    const evidence = createProtectedStenographerMemoryEvidence({
      db: database({ role: "user", agentId: null }),
      roomId: ROOM,
      namespaceId: NAMESPACE,
      sources: sources("user"),
      audience: {
        readAudience: () => Promise.resolve({
          humanIds: [HUMAN],
          includesPublicBoundary: false,
        }),
      },
      assertCurrent: () => {
        checks += 1;
        return checks < 2
          ? Promise.resolve()
          : Promise.reject(new Error("grant changed"));
      },
    });
    const failure = await evidence.readSource(
      dependency("Remember blue."),
    ).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "")
      .toContain("grant changed");
  });
});
