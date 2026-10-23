import { describe, expect, test } from "bun:test";

import { createAuthorizedHumanTaskRunTranscriptReaderV1 } from
  "../../src/client/task/authorized-human-task-run-transcript.ts";
import { bindEncryptionDataOperationOwner } from
  "../../src/transition/encryption-data-operation-owner.ts";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const ROOM = "40000000-0000-4000-8000-000000000004";
const SESSION = "50000000-0000-4000-8000-000000000005";
const HUMAN = "60000000-0000-4000-8000-000000000006";
const DIGEST = "A".repeat(43);

function owner(mode: "plaintext_only" | "encrypted_only" = "encrypted_only") {
  return bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({
      policy: { mode, shadowBehavior: mode === "plaintext_only"
        ? "fallback" as const : "strict" as const },
      revalidationToken: 7,
    }),
    revalidate: async () => undefined,
  } });
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

function ready() {
  const coordinate = {
    sessionId: SESSION,
    messageId: 41,
    editRevision: 0,
    role: "assistant" as const,
    logicalMessageKey: "row:41",
  };
  return {
    readVersion: 1 as const,
    status: "ready" as const,
    taskId: TASK,
    taskRunId: RUN,
    agentId: AGENT,
    sourceRoomId: ROOM,
    entries: [{
      sessionId: SESSION,
      messageId: "41",
      editRevision: 0,
      role: "assistant" as const,
      createdAt: "2026-10-09T12:00:00.000Z",
    }],
    nextCursor: "WzEsMV0",
    history: {
      responseVersion: 1 as const,
      status: "ready" as const,
      operationId: "task-transcript:one",
      clientRequestKey: "request:one",
      selectedCoordinateDigestBase64url: DIGEST,
      selectedCount: 1,
      selectedCoordinates: [coordinate],
      eligibleCount: 1,
      authority: {
        roomId: ROOM,
        policyRevision: 3,
        subjectHumanId: HUMAN,
        readerDeviceSigningKeyGeneration: 2,
        hostAuthorizationRevision: 1,
      },
      records: [{
        kind: "existing_representation" as const,
        representationMode: "protected-only" as const,
        coordinate,
        selectedSource: { role: "assistant" as const, authorAgentId: AGENT },
        protectedMessage: {
          dtoVersion: 2 as const,
          projection: {
            messageId: "41", logicalMessageKey: "row:41", sessionId: SESSION,
            roomId: ROOM, namespaceId: "namespace:one", role: "assistant" as const,
            createdAt: "2026-10-09T12:00:00.000Z", editRevision: 0,
            authorAgentId: AGENT,
          },
          protectedPayload: { status: "pending" as const, reason: "shadow_pending" as const },
        },
        repair: {
          identityDigestBase64url: DIGEST,
          allocationDigestBase64url: DIGEST,
          attestationDigestBase64url: DIGEST,
          publisherSignerKeyId: "signer:one",
          publisherSigningPublicKeyBase64url: DIGEST,
        },
      }],
      signerEvidence: [],
      terminalExecutions: [],
      acknowledgement: { status: "already_recorded" as const },
    },
  };
}

describe("authorized Human TaskRun transcript reader", () => {
  test("opens and acknowledges only the exact page through history custody", async () => {
    const calls: unknown[] = [];
    const response = ready();
    const reader = createAuthorizedHumanTaskRunTranscriptReaderV1({
      api: {
        readProtectedTaskRunTranscriptV1: async input => {
          calls.push(input);
          return response as never;
        },
      },
      owner: owner(),
      history: {
        readerDeviceId: "device:one",
        reconcile: async input => {
          calls.push(input);
          return {
            records: [{
              sessionId: SESSION,
              messageId: "41",
              editRevision: 0,
              status: "verified" as const,
              verification: "signed_representation_authenticated" as const,
              payload: {
                role: "assistant" as const,
                content: "private answer",
                toolCalls: [{ id: "call:one", name: "lookup", args: { q: "term" } }],
              },
            }],
            eligibleCount: 1,
            verifiedCount: 1,
            fallbackCounts: {},
          };
        },
        acknowledge: async input => {
          calls.push(input);
          return "already_recorded";
        },
      },
      createClientRequestKey: () => "request:one",
    });

    expect(await reader.read({
      taskId: TASK, taskRunId: RUN, agentId: AGENT,
      cursor: "cursor_one", limit: 50,
    })).toEqual({
      status: "ready",
      messages: [{
        role: "assistant",
        content: "private answer",
        toolName: null,
        toolCalls: [{ id: "call:one", name: "lookup", args: { q: "term" } }],
        createdAt: "2026-10-09T12:00:00.000Z",
      }],
      nextCursor: "WzEsMV0",
    });
    expect(calls[0]).toMatchObject({
      taskId: TASK, taskRunId: RUN, agentId: AGENT,
      cursor: "cursor_one", limit: 50,
      historyRead: { clientRequestKey: "request:one", readerDeviceId: "device:one" },
    });
    expect(calls[2]).toMatchObject({
      roomId: ROOM,
      allowOrdinaryRepairs: false,
      result: { verifiedCount: 1 },
    });
  });

  test("never calls the protected API when policy is Plain", async () => {
    let reads = 0;
    const reader = createAuthorizedHumanTaskRunTranscriptReaderV1({
      api: { readProtectedTaskRunTranscriptV1: async () => {
        reads += 1;
        return ready() as never;
      } },
      owner: owner("plaintext_only"),
      history: {} as never,
      createClientRequestKey: () => "request:one",
    });
    await reader.read({ taskId: TASK, taskRunId: RUN, agentId: AGENT })
      .then(() => { throw new Error("expected Plain admission to reject"); }, () => undefined);
    expect(reads).toBe(0);
  });

  test("rejects a substituted Task transcript identity before history custody", async () => {
    let historyReads = 0;
    const reader = createAuthorizedHumanTaskRunTranscriptReaderV1({
      api: { readProtectedTaskRunTranscriptV1: async () => ({
        ...ready(),
        taskRunId: "70000000-0000-4000-8000-000000000007",
      }) as never },
      owner: owner(),
      history: {
        readerDeviceId: "device:one",
        reconcile: async () => {
          historyReads += 1;
          throw new Error("substituted page reached history custody");
        },
        acknowledge: async () => "accepted",
      },
      createClientRequestKey: () => "request:one",
    });

    expect(await rejected(reader.read({ taskId: TASK, taskRunId: RUN, agentId: AGENT })))
      .toBeInstanceOf(Error);
    expect(historyReads).toBe(0);
  });

  test("rejects substituted transcript metadata before history custody", async () => {
    let historyReads = 0;
    const response = ready();
    const reader = createAuthorizedHumanTaskRunTranscriptReaderV1({
      api: { readProtectedTaskRunTranscriptV1: async () => ({
        ...response,
        entries: [{
          ...response.entries[0]!,
          createdAt: "2026-10-09T12:00:01.000Z",
        }],
      }) as never },
      owner: owner(),
      history: {
        readerDeviceId: "device:one",
        reconcile: async () => {
          historyReads += 1;
          throw new Error("substituted page reached history custody");
        },
        acknowledge: async () => "accepted",
      },
      createClientRequestKey: () => "request:one",
    });

    expect(await rejected(reader.read({ taskId: TASK, taskRunId: RUN, agentId: AGENT })))
      .toBeInstanceOf(Error);
    expect(historyReads).toBe(0);
  });

  test("withholds plaintext when history verification falls back", async () => {
    const reader = createAuthorizedHumanTaskRunTranscriptReaderV1({
      api: { readProtectedTaskRunTranscriptV1: async () => ready() as never },
      owner: owner(),
      history: {
        readerDeviceId: "device:one",
        reconcile: async () => ({
          records: [{ sessionId: SESSION, messageId: "41", editRevision: 0,
            status: "fallback" as const, reason: "retained_key_material_unavailable" as const }],
          eligibleCount: 1, verifiedCount: 0,
          fallbackCounts: { retained_key_material_unavailable: 1 },
        }),
        acknowledge: async () => "accepted",
      },
      createClientRequestKey: () => "request:one",
    });
    expect(await reader.read({ taskId: TASK, taskRunId: RUN, agentId: AGENT }))
      .toEqual({ status: "unavailable", reason: "device_not_ready" });
  });
});
