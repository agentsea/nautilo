import { afterEach, describe, expect, test } from "bun:test";
import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";
import type { LiveShadowAgentTurnSession } from "@nautilo/lattice-bridge/server";
import type { ForegroundRecordContextPort } from "@nautilo/reflection/foreground";
import {
  createLiveShadowDataOperationPolicyBinding,
  runWithLiveShadowTurnSession,
} from "../../src/conversation/live-shadow-turn-context";
import type { createForegroundContextRebuilder } from
  "../../src/executors/foreground-context-refresh";
import { createPersistingProcessor } from "../../src/executors/persisting-processor";
import {
  installForegroundRecordContextPortFactory,
  uninstallForegroundRecordContextPortFactory,
} from "../../src/reflection/foreground-record-context";

afterEach(() => uninstallForegroundRecordContextPortFactory());

function rebuildThatSelectsRecordContext(
  onSelection: (selection: Awaited<ReturnType<ForegroundRecordContextPort["select"]>>) => void,
): typeof createForegroundContextRebuilder {
  return ((input: Parameters<typeof createForegroundContextRebuilder>[0]) =>
    async () => {
      if (input.recordContext === undefined) {
        throw new Error("expected Record context");
      }
      const selection = await input.recordContext.select({ query: "latest preference", limit: 3 });
      onSelection(selection);
      return { messages: [], source: { acceptedMessages: [] } };
    }) as typeof createForegroundContextRebuilder;
}

function protectedResumeInput() {
  return {
    operationId: "operation-resume",
    capability: Object.freeze({
      kind: "foreground_session" as const,
      sessionReference: "foreground-session:operation-resume",
      authorizationDigest: new Uint8Array(32).fill(0xa1),
      scope: Object.freeze({
        subjectHumanId: "human-1",
        issuingDeviceId: "device-1",
        recipientAgentId: "agent-1",
        sessionId: "session-1",
        roomId: "room-1",
        policyRevision: 1,
        hostAuthorizationRevision: 1,
        agentAuthorizationRevision: 1,
        namespaceIds: Object.freeze(["namespace-1"]),
        grantDomainIds: Object.freeze(["domain-1"]),
        domainAuthoritySetDigest: new Uint8Array(32).fill(0xa2),
      }),
    }),
    enforcementPolicy: {
      mode: "shadow_encryption" as const,
      shadowBehavior: "strict" as const,
      revision: 1,
    },
    dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
      () => Promise.resolve({
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 1,
      }),
    ),
  };
}

function rebuildTransition(
  trustedExecutionEntrypoint: "foreground.main" | "foreground.task_report_back",
) {
  return { state: { trustedExecutionEntrypoint } } as never;
}

test("Room processor exposes a foreground rebuild callback", () => {
  const processor = createPersistingProcessor({
    threadId: "thread-1",
    ownerId: "owner-1",
    agentId: "agent-1",
    roomId: "room-1",
    laneKey: "room:room-1:bot:agent-1",
    eventBus: { emit() {} },
  });

  expect(typeof processor.rebuildForegroundContext).toBe("function");
});

test("background processor does not advertise foreground rebuilding", () => {
  const processor = createPersistingProcessor({
    threadId: "task-thread",
    ownerId: "owner-1",
    laneKey: "task-lane",
    eventBus: { emit() {} },
  });

  expect("rebuildForegroundContext" in processor).toBe(false);
});

describe("resumed foreground Record context", () => {
  test("ordinary resumes keep using the ordinary Record port", async () => {
    let ordinarySelections = 0;
    let selectedStatement: string | undefined;
    installForegroundRecordContextPortFactory(() => ({
      representation: "ordinary",
      select: () => {
        ordinarySelections += 1;
        return Promise.resolve({
          status: "available",
          representation: "ordinary",
          queryEmbeddingStatus: "available",
          candidateCount: 1,
          records: [{
            recordRef: "record-1",
            statement: "ordinary statement",
            lifecycle: "current",
            structuralHeight: 0,
          }],
        });
      },
    }));
    const processor = createPersistingProcessor({
      threadId: "thread-1",
      ownerId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
      laneKey: "room:room-1:bot:agent-1",
      eventBus: { emit() {} },
    }, {
      createForegroundContextRebuilder: rebuildThatSelectsRecordContext(
        (selection) => {
          selectedStatement = selection.status === "available"
            ? selection.records[0]?.statement
            : undefined;
        },
      ),
    });

    await processor.rebuildForegroundContext?.(
      rebuildTransition("foreground.main"),
    );

    expect(ordinarySelections).toBe(1);
    expect(selectedStatement).toBe("ordinary statement");
  });

  test("protects a Record port inside the resumed session that invokes the rebuild", async () => {
    let factoryCalls = 0;
    let ordinarySelections = 0;
    let selectedRepresentation: string | undefined;
    let selectedStatement: string | undefined;
    installForegroundRecordContextPortFactory(() => {
      factoryCalls += 1;
      return {
        representation: "ordinary",
        select: () => {
          ordinarySelections += 1;
          return Promise.resolve({
            status: "available",
            representation: "ordinary",
            queryEmbeddingStatus: "available",
            candidateCount: 1,
            records: [{
              recordRef: "record-1",
              statement: "ordinary statement",
              lifecycle: "current",
              structuralHeight: 0,
            }],
          });
        },
        selectStructural: () => Promise.resolve({
          status: "available",
          representation: "protected",
          queryEmbeddingStatus: "available",
          candidateCount: 1,
          records: [{
            representation: "structural",
            recordRef: "record-1",
            structuralHeight: 0,
          }],
        }),
      };
    });
    const processor = createPersistingProcessor({
      threadId: "thread-1",
      ownerId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
      laneKey: "room:room-1:bot:agent-1",
      eventBus: { emit() {} },
    }, {
      createForegroundContextRebuilder: rebuildThatSelectsRecordContext(
        (selection) => {
          selectedRepresentation = selection.representation;
          selectedStatement = selection.status === "available"
            ? selection.records[0]?.statement
            : undefined;
        },
      ),
    });
    const session = {
      protectForegroundRecords: () => Promise.resolve({
        status: "verified" as const,
        records: [{
          recordRef: "record-1",
          statement: "protected statement",
          lifecycle: "current" as const,
          structuralHeight: 0,
        }],
        provenance: "existing" as const,
        repairedCount: 0,
      }),
    } as unknown as LiveShadowAgentTurnSession;

    expect(factoryCalls).toBe(0);

    await runWithLiveShadowTurnSession({
      ...protectedResumeInput(),
      session,
      work: () => processor.rebuildForegroundContext!(
        rebuildTransition("foreground.main"),
      ),
    });

    expect(factoryCalls).toBe(1);
    expect(ordinarySelections).toBe(0);
    expect(selectedRepresentation).toBe("protected");
    expect(selectedStatement).toBe("protected statement");
  });

  test("fails closed when resumed Record protection is rejected", async () => {
    let ordinarySelections = 0;
    installForegroundRecordContextPortFactory(() => ({
      representation: "ordinary",
      select: () => {
        ordinarySelections += 1;
        return Promise.resolve({
          status: "available",
          representation: "ordinary",
          queryEmbeddingStatus: "available",
          candidateCount: 1,
          records: [{
            recordRef: "record-1",
            statement: "must not reach the prompt",
            lifecycle: "current",
            structuralHeight: 0,
          }],
        });
      },
      selectStructural: () => Promise.resolve({
        status: "available",
        representation: "protected",
        queryEmbeddingStatus: "available",
        candidateCount: 1,
        records: [{
          representation: "structural",
          recordRef: "record-1",
          structuralHeight: 0,
        }],
      }),
    }));
    const processor = createPersistingProcessor({
      threadId: "thread-1",
      ownerId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
      laneKey: "room:room-1:bot:agent-1",
      eventBus: { emit() {} },
    }, {
      createForegroundContextRebuilder: rebuildThatSelectsRecordContext(() => undefined),
    });
    const session = {
      protectForegroundRecords: () => Promise.resolve({
        status: "failed" as const,
        reason: "record_parity_mismatch" as const,
      }),
    } as unknown as LiveShadowAgentTurnSession;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(runWithLiveShadowTurnSession({
      ...protectedResumeInput(),
      session,
      work: () => processor.rebuildForegroundContext!(
        rebuildTransition("foreground.main"),
      ),
    })).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(ordinarySelections).toBe(0);
  });

  test("does not add Record context to task report-back refreshes", async () => {
    let factoryCalls = 0;
    let receivedRecordContext = true;
    installForegroundRecordContextPortFactory(() => {
      factoryCalls += 1;
      return {
        representation: "ordinary",
        select: () => Promise.resolve({
          status: "available",
          representation: "ordinary",
          queryEmbeddingStatus: "available",
          candidateCount: 0,
          records: [],
        }),
      };
    });
    const processor = createPersistingProcessor({
      threadId: "thread-1",
      ownerId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
      laneKey: "room:room-1:bot:agent-1",
      eventBus: { emit() {} },
    }, {
      createForegroundContextRebuilder: ((input) => async () => {
        receivedRecordContext = input.recordContext !== undefined;
        return { messages: [], source: { acceptedMessages: [] } };
      }) as typeof createForegroundContextRebuilder,
    });

    await processor.rebuildForegroundContext?.(
      rebuildTransition("foreground.task_report_back"),
    );

    expect(factoryCalls).toBe(0);
    expect(receivedRecordContext).toBe(false);
  });
});
