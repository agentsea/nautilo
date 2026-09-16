import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type {
  LiveShadowAgentPublishedMessage,
  LiveShadowAgentSessionFailureReason,
  LiveShadowAgentSessionFailureStage,
  LiveShadowAgentTurnSession,
} from "@nautilo/lattice-bridge/server";
import {
  LiveShadowToolProtectionRequiredError,
  LiveShadowToolProtectionTerminalError,
} from "@nautilo/agent";
import {
  StrictShadowEnforcementError,
  type StrictShadowEnforcementPolicy,
} from "@nautilo/lattice-bridge";
import { parseFullEncryptionMessageRealtimeContentEventV2, type ProtectedMessageDtoV2 } from "@nautilo/types";

import { createLiveShadowAgentRuntimeTurn as createRuntimeTurn } from
  "../../src/conversation/live-shadow-agent-runtime";
import { protectLiveShadowAssistantToken, publishLiveShadowRuntimeMessages } from
  "../../src/conversation/live-shadow-agent-runtime-events";

function createLiveShadowAgentRuntimeTurn(
  session: LiveShadowAgentTurnSession,
  policy: StrictShadowEnforcementPolicy = Object.freeze({
    mode: "shadow_encryption",
    shadowBehavior: "fallback",
    revision: 0,
  }),
) {
  return createRuntimeTurn(session, policy, undefined, {
    resolve: () => Promise.resolve({
      policy: { mode: policy.mode, shadowBehavior: policy.shadowBehavior },
      revalidationToken: policy.revision,
    }),
    revalidate: (revision) => revision === policy.revision
      ? Promise.resolve()
      : Promise.reject(new Error("test policy changed")),
  });
}

function throwingSession(input: Readonly<{
  reserve?: boolean;
  publish?: boolean;
  seal?: boolean;
}>): Readonly<{
  session: LiveShadowAgentTurnSession;
  failures: LiveShadowAgentSessionFailureStage[];
}> {
  const failures: LiveShadowAgentSessionFailureStage[] = [];
  const reservation = Object.freeze({
    messageId: 82,
    transcriptOrdinal: 2,
    authorRole: "assistant" as const,
  }) as Awaited<ReturnType<
    LiveShadowAgentTurnSession["reserveAssistantStream"]
  >> extends Readonly<{ status: "protected"; value: infer Value }>
    ? Value extends Readonly<{ reservation: infer Reservation }>
      ? Reservation
      : never
    : never;
  const session: LiveShadowAgentTurnSession = Object.freeze({
    reserveAssistantStream: () => {
      if (input.reserve === true) {
        return Promise.reject(new Error("protected reservation unavailable"));
      }
      return Promise.resolve(Object.freeze({
        status: "protected" as const,
        value: Object.freeze({
          reservation,
          startBytes: new Uint8Array([1]),
        }),
      }));
    },
    sealAssistantStreamChunk: () => {
      if (input.seal === true) {
        throw new Error("protected frame unavailable");
      }
      return Object.freeze({
        status: "protected" as const,
        value: Object.freeze({
          frameBytes: new Uint8Array([2]),
          terminal: false,
        }),
      });
    },
    publishMessage: () => {
      if (input.publish === true) {
        return Promise.reject(new Error("protected publication unavailable"));
      }
      throw new Error("unexpected publication");
    },
    fail: (stage: LiveShadowAgentSessionFailureStage) => {
      failures.push(stage);
    },
    destroy: () => undefined,
  });
  return Object.freeze({ session, failures });
}

describe("live Shadow Agent Runtime fallback boundary", () => {
  test("event publication delegates once and never ordinary-retries an ambiguous commit", async () => {
    let protectedCalls = 0;
    let ordinaryCalls = 0;
    let warnings = 0;
    const runtime = {
      representationMode: "shadow_encryption" as const,
      sharedAgentPlanBytesBase64url: null,
      toolBoundary: {} as never,
      reserveAssistantStream: () => Promise.resolve(null),
      sealAssistantStreamChunk: async () => null,
      publishMessages: async () => {
        protectedCalls += 1;
        throw new Error("publication outcome unknown");
      },
    };
    expect(publishLiveShadowRuntimeMessages({
      runtime,
      operationId: "ambiguous",
      laneKey: "room:ambiguous",
      agentId: "agent:ambiguous",
      messages: [new AIMessage({ content: "must not duplicate" })],
      persistOrdinary: async () => { ordinaryCalls += 1; },
      warn: () => { warnings += 1; },
    })).rejects.toThrow("publication outcome unknown");
    expect({ protectedCalls, ordinaryCalls, warnings }).toEqual({
      protectedCalls: 1,
      ordinaryCalls: 0,
      warnings: 0,
    });
  });

  test("stream framing propagates an ambiguous reservation failure without ordinary delegation", async () => {
    let reserveCalls = 0;
    const runtime = {
      representationMode: "shadow_encryption" as const,
      sharedAgentPlanBytesBase64url: null,
      toolBoundary: {} as never,
      reserveAssistantStream: async () => {
        reserveCalls += 1;
        throw new Error("reservation outcome unknown");
      },
      sealAssistantStreamChunk: async () => null,
      publishMessages: async () => { throw new Error("unused"); },
    };
    expect(protectLiveShadowAssistantToken({
      runtime,
      operationId: "ambiguous-stream",
      laneKey: "room:ambiguous",
      state: { ordinals: new Map() },
      messagesToPersist: [],
      event: {
        type: "message.tokens",
        laneKey: "room:ambiguous",
        content: "secret",
        done: false,
        assistantMessageKey: "assistant:ambiguous",
        chunkSequence: 1,
      },
    })).rejects.toThrow("reservation outcome unknown");
    expect(reserveCalls).toBe(1);
  });

  test("refuses a Full runtime backed by an ordinary-persisting Shadow session", () => {
    expect(() => createLiveShadowAgentRuntimeTurn(throwingSession({}).session, {
      mode: "encrypted_only", shadowBehavior: "fallback", revision: 8,
    })).toThrow("does not match");
  });

  test("rejects a policy change since admission before invoking protected Runtime", async () => {
    let protectedCalls = 0;
    const base = throwingSession({}).session;
    const runtime = createRuntimeTurn({
      ...base,
      reserveAssistantStream: (input) => {
        protectedCalls += 1;
        return base.reserveAssistantStream(input);
      },
    }, {
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 8,
    }, undefined, {
      resolve: () => Promise.resolve({
        policy: { mode: "encrypted_only", shadowBehavior: "strict" },
        revalidationToken: 9,
      }),
      revalidate: () => Promise.resolve(),
    });

    expect(runtime.reserveAssistantStream({
      assistantMessageKey: "stale-admission",
      createdAt: 1_800_000_000_000,
    })).rejects.toThrow("admission policy changed");
    expect(protectedCalls).toBe(0);
  });

  test("Full frame and durable events omit transient ordinary siblings in both Agent routes", async () => {
    const secret = "FULL_TRANSPORT_SENTINEL_318";
    for (const shared of [false, true]) {
      const openedPayload = { role: "assistant" as const, content: secret };
      const published: LiveShadowAgentPublishedMessage = {
        representationMode: "full_encryption",
        reservation: { messageId: 42, transcriptOrdinal: 2, authorRole: "assistant" } as LiveShadowAgentPublishedMessage["reservation"],
        policyRevision: 8,
        ordinaryPayloadBytes: new TextEncoder().encode(secret),
        openedPayload,
        protectedMessage: {
          dtoVersion: 2,
          projection: {
            messageId: "42", sessionId: "10000000-0000-4000-8000-000000000318",
            roomId: "20000000-0000-4000-8000-000000000318",
            namespaceId: "30000000-0000-4000-8000-000000000318",
            role: "assistant", createdAt: "2027-01-15T08:00:00.000Z", editRevision: 0,
          },
          protectedPayload: {
            status: "encrypted", cryptoObjectId: "message:full:42", payloadVersion: 2,
            keyClass: "ai", encryptedPayloadBytesBase64url: "AQ",
            accessManifestBytesBase64url: "Ag", namespaceEnvelopeBytesBase64url: "Aw",
          },
        },
        durableEventDigest: new Uint8Array(32), streamEvidence: null,
      };
      const runtime = createLiveShadowAgentRuntimeTurn({
        ...throwingSession({}).session,
        representationMode: "full_encryption",
        sharedAgentRealtimePlanBytes: () => shared ? new Uint8Array([3]) : null,
        publishMessage: () => Promise.resolve({ status: "protected", value: published }),
      }, { mode: "encrypted_only", shadowBehavior: "strict", revision: 8 });
      const token = await protectLiveShadowAssistantToken({
        runtime, operationId: "turn:m318", laneKey: "room:20000000-0000-4000-8000-000000000318",
        state: { ordinals: new Map() }, messagesToPersist: [],
        event: {
          type: "message.tokens", laneKey: "room:20000000-0000-4000-8000-000000000318",
          content: secret, done: false, assistantMessageKey: "assistant:m318",
          chunkSequence: 1,
        },
      });
      expect(token.handled).toBe(true);
      let ordinaryCalls = 0;
      const durable = await publishLiveShadowRuntimeMessages({
        runtime, operationId: "turn:m318", laneKey: "room:20000000-0000-4000-8000-000000000318",
        agentId: "agent:m318", messages: [new AIMessage({ content: secret })],
        persistOrdinary: () => { ordinaryCalls += 1; return Promise.resolve(); },
        warn: () => { throw new Error("Full must not warn-and-fallback"); },
      });
      expect(ordinaryCalls).toBe(0);
      expect(durable).toHaveLength(1);
      for (const event of [...token.events, ...durable]) {
        expect(parseFullEncryptionMessageRealtimeContentEventV2(event).wireVersion).toBe(2);
        expect(JSON.stringify(event)).not.toContain(secret);
        expect(JSON.stringify(event)).not.toContain(Buffer.from(secret).toString("base64url"));
        expect(event).not.toHaveProperty("ordinaryChunk");
        expect(event).not.toHaveProperty("ordinaryPayloadBytesBase64url");
      }
    }
  });
  test("Full never downgrades stream, Message or Tool failures with stale fallback behavior", async () => {
    const policy = {
      mode: "encrypted_only" as const,
      shadowBehavior: "fallback" as const,
      revision: 8,
    };
    const failed = throwingSession({ reserve: true, publish: true });
    const runtime = createLiveShadowAgentRuntimeTurn({
      ...failed.session, representationMode: "full_encryption",
    }, policy);
    expect(runtime.reserveAssistantStream({
      assistantMessageKey: "full:failed",
      createdAt: 1_800_000_000_000,
    })).rejects.toThrow("protected reservation unavailable");
    expect(runtime.publishMessages([
      new AIMessage({ content: "Full confidential sentinel" }),
    ])).rejects.toThrow("protected publication unavailable");
    expect(runtime.toolBoundary.protectAssistantToolCall(new AIMessage({
      content: "",
      tool_calls: [{ id: "full:call", name: "search", args: { query: "secret" } }],
    }))).rejects.toBeInstanceOf(LiveShadowToolProtectionTerminalError);
    expect(runtime.toolBoundary.protectToolResult(new ToolMessage({
      content: "Full confidential result",
      tool_call_id: "full:call",
    }))).rejects.toBeInstanceOf(LiveShadowToolProtectionTerminalError);

    const seal = throwingSession({ seal: true });
    const sealing = createLiveShadowAgentRuntimeTurn({
      ...seal.session, representationMode: "full_encryption",
    }, policy);
    await sealing.reserveAssistantStream({
      assistantMessageKey: "full:seal",
      createdAt: 1_800_000_000_000,
    });
    expect(sealing.sealAssistantStreamChunk({
      assistantMessageKey: "full:seal",
      ordinaryChunk: new TextEncoder().encode("secret"),
      done: false,
    })).rejects.toThrow("protected frame unavailable");
  });

  test("incomplete streams cannot ask the caller to emit ordinary tokens in protected-only modes", async () => {
    for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
      const runtime = createLiveShadowAgentRuntimeTurn({
        ...throwingSession({}).session,
        representationMode: mode === "encrypted_only" ? "full_encryption" : "shadow_encryption",
      }, {
        mode,
        shadowBehavior: mode === "encrypted_only" ? "fallback" : "strict",
        revision: 8,
      });
      const chunk = {
        assistantMessageKey: "missing:stream",
        ordinaryChunk: new TextEncoder().encode("secret"),
        done: false,
      };
      expect(runtime.sealAssistantStreamChunk(chunk))
        .rejects.toBeInstanceOf(StrictShadowEnforcementError);
      await runtime.reserveAssistantStream({
        assistantMessageKey: chunk.assistantMessageKey,
        createdAt: 1_800_000_000_000,
      });
      expect(runtime.sealAssistantStreamChunk({ ...chunk, done: true }))
        .rejects.toBeInstanceOf(StrictShadowEnforcementError);
    }
  });

  test("never turns revoked authorization into an ordinary fallback", async () => {
    const authorization = new AbortController();
    const state = throwingSession({ publish: true });
    const session: LiveShadowAgentTurnSession = Object.freeze({
      ...state.session,
      authorizationDeadlineAt: Date.now() + 60_000,
      authorizationSignal: authorization.signal,
    });
    const runtime = createLiveShadowAgentRuntimeTurn(session);
    authorization.abort();

    expect(runtime.publishMessages([
      new AIMessage({ content: "must stop with the authorization" }),
    ])).rejects.toThrow("authorization is unavailable");
    expect(runtime.toolBoundary.protectAssistantToolCall(
      new AIMessage({
        content: "",
        tool_calls: [{ id: "expired-call", name: "search", args: {} }],
      }),
    )).rejects.toBeInstanceOf(LiveShadowToolProtectionTerminalError);
    expect(state.failures).toEqual(["assistant_message", "tool_call"]);
  });

  test("reports clock expiry as the canonical terminal deadline reason", async () => {
    const failures: Array<Readonly<{
      stage: LiveShadowAgentSessionFailureStage;
      reason: LiveShadowAgentSessionFailureReason;
    }>> = [];
    let publishCalls = 0;
    const base = throwingSession({}).session;
    const session = Object.freeze({
      ...base,
      authorizationDeadlineAt: Date.now() - 1,
      publishMessage: () => {
        publishCalls += 1;
        return base.publishMessage({} as never);
      },
      fail: (
        stage: LiveShadowAgentSessionFailureStage,
        reason: LiveShadowAgentSessionFailureReason = "protected_unavailable",
      ) => failures.push({ stage, reason }),
    }) satisfies LiveShadowAgentTurnSession;
    const runtime = createLiveShadowAgentRuntimeTurn(session);

    expect(runtime.publishMessages([
      new AIMessage({ content: "must stop before publication" }),
    ])).rejects.toMatchObject({
      decision: {
        actorClass: "agent",
        state: "failed",
        reason: "deadline_expired",
        retryable: false,
      },
    });
    expect(runtime.toolBoundary.protectAssistantToolCall(new AIMessage({
      content: "",
      tool_calls: [{ id: "expired-call", name: "search", args: {} }],
    }))).rejects.toMatchObject({
      decision: {
        actorClass: "tool",
        state: "failed",
        reason: "deadline_expired",
        retryable: false,
      },
    });
    expect(publishCalls).toBe(0);
    expect(failures).toEqual([
      { stage: "assistant_message", reason: "deadline_expired" },
      { stage: "tool_call", reason: "deadline_expired" },
    ]);
  });

  test("rechecks expiry before fallback when the clock crosses during protected publication", async () => {
    let authorizationDeadlineAt = Date.now() + 60_000;
    let protectedCalls = 0;
    let ordinaryPersistCalls = 0;
    const failures: Array<Readonly<{
      stage: LiveShadowAgentSessionFailureStage;
      reason: LiveShadowAgentSessionFailureReason;
    }>> = [];
    const base = throwingSession({}).session;
    const session = Object.freeze({
      ...base,
      get authorizationDeadlineAt() {
        return authorizationDeadlineAt;
      },
      publishMessage: async () => {
        protectedCalls += 1;
        authorizationDeadlineAt = Date.now() - 1;
        return Object.freeze({
          status: "ordinary_fallback" as const,
          stage: "assistant_message" as const,
          reason: "protected_unavailable" as const,
        });
      },
      fail: (
        stage: LiveShadowAgentSessionFailureStage,
        reason: LiveShadowAgentSessionFailureReason = "protected_unavailable",
      ) => failures.push({ stage, reason }),
    }) satisfies LiveShadowAgentTurnSession;
    const runtime = createLiveShadowAgentRuntimeTurn(session);

    expect(publishLiveShadowRuntimeMessages({
      runtime,
      operationId: "expires-during-publication",
      laneKey: "room:expires-during-publication",
      agentId: "agent:expires-during-publication",
      messages: [new AIMessage({ content: "must never publish ordinarily" })],
      persistOrdinary: async () => {
        ordinaryPersistCalls += 1;
      },
      warn: () => undefined,
    })).rejects.toMatchObject({
      decision: {
        state: "failed",
        reason: "deadline_expired",
        retryable: false,
      },
    });
    expect(protectedCalls).toBe(1);
    expect(ordinaryPersistCalls).toBe(0);
    expect(failures).toEqual([{
      stage: "assistant_message",
      reason: "deadline_expired",
    }]);
  });

  test("does not retry ambiguous protected stream exceptions as ordinary", async () => {
    const reserve = throwingSession({ reserve: true });
    const reserveRuntime = createLiveShadowAgentRuntimeTurn(reserve.session);
    expect(reserveRuntime.reserveAssistantStream({
      assistantMessageKey: "assistant:turn:0",
      createdAt: 1_800_000_000_000,
    })).rejects.toThrow("protected reservation unavailable");
    expect(reserve.failures).toEqual([]);

    const seal = throwingSession({ seal: true });
    const sealRuntime = createLiveShadowAgentRuntimeTurn(seal.session);
    expect(await sealRuntime.reserveAssistantStream({
      assistantMessageKey: "assistant:turn:0",
      createdAt: 1_800_000_000_000,
    })).not.toBeNull();
    expect(sealRuntime.sealAssistantStreamChunk({
      assistantMessageKey: "assistant:turn:0",
      ordinaryChunk: new TextEncoder().encode("ordinary survives"),
      done: false,
    })).rejects.toThrow("protected frame unavailable");
    expect(seal.failures).toEqual([]);
  });

  test("does not retry an ambiguous protected publication as ordinary", async () => {
    const state = throwingSession({ publish: true });
    const runtime = createLiveShadowAgentRuntimeTurn(state.session);
    const source = new AIMessage({ content: "ordinary survives" });

    expect(runtime.publishMessages([source]))
      .rejects.toThrow("protected publication unavailable");
    expect(state.failures).toEqual([]);
  });

  test("never invokes ordinary Runtime fallbacks under Strict Shadow", async () => {
    const strictPolicy = Object.freeze({
      mode: "shadow_encryption" as const,
      shadowBehavior: "strict" as const,
      revision: 7,
    });

    const reserve = throwingSession({ reserve: true });
    const reserveRuntime = createLiveShadowAgentRuntimeTurn(
      reserve.session,
      strictPolicy,
    );
    expect(reserveRuntime.reserveAssistantStream({
      assistantMessageKey: "assistant:strict:0",
      createdAt: 1_800_000_000_000,
    })).rejects.toThrow("protected reservation unavailable");

    const publish = throwingSession({ publish: true });
    const publishRuntime = createLiveShadowAgentRuntimeTurn(
      publish.session,
      strictPolicy,
    );
    expect(publishRuntime.publishMessages([
      new AIMessage({ content: "must never escape as ordinary" }),
    ])).rejects.toThrow("protected publication unavailable");

    expect(publishRuntime.toolBoundary.protectAssistantToolCall(
      new AIMessage({
        content: "",
        tool_calls: [{ id: "strict-call", name: "search", args: {} }],
      }),
    )).rejects.toBeInstanceOf(LiveShadowToolProtectionTerminalError);

    const unavailableSession = {
      ...throwingSession({}).session,
      publishMessage: () => Promise.resolve(Object.freeze({
        status: "ordinary_fallback" as const,
        stage: "tool_call" as const,
        reason: "protected_unavailable" as const,
      })),
    } satisfies LiveShadowAgentTurnSession;
    const unavailableRuntime = createLiveShadowAgentRuntimeTurn(
      unavailableSession,
      strictPolicy,
    );
    expect(unavailableRuntime.toolBoundary.protectAssistantToolCall(
      new AIMessage({
        content: "",
        tool_calls: [{ id: "strict-unavailable", name: "search", args: {} }],
      }),
    )).rejects.toBeInstanceOf(LiveShadowToolProtectionRequiredError);
  });

  test("publishes one logical tool call once across concurrent consumer and durable gates", async () => {
    let publications = 0;
    const openedPayload = {
      role: "assistant" as const,
      content: "",
      toolCalls: [{
        id: "call-live-shadow",
        name: "get_current_time",
        args: { timezone: "UTC" },
      }],
    };
    const published: LiveShadowAgentPublishedMessage = Object.freeze({
      reservation: Object.freeze({
        messageId: 83,
        transcriptOrdinal: 2,
        authorRole: "assistant" as const,
      }) as LiveShadowAgentPublishedMessage["reservation"],
      policyRevision: 9,
      ordinaryPayloadBytes: new Uint8Array([1]),
      openedPayload,
      protectedMessage: Object.freeze({}) as ProtectedMessageDtoV2,
      durableEventDigest: new Uint8Array(32),
      streamEvidence: null,
    });
    const session: LiveShadowAgentTurnSession = Object.freeze({
      reserveAssistantStream: () => Promise.reject(new Error("unused")),
      sealAssistantStreamChunk: () => {
        throw new Error("unused");
      },
      publishMessage: async () => {
        publications += 1;
        await Promise.resolve();
        return Object.freeze({
          status: "protected" as const,
          value: published,
        });
      },
      fail: () => undefined,
      destroy: () => undefined,
    });
    const runtime = createLiveShadowAgentRuntimeTurn(session);
    const consumerMessage = new AIMessage({
      content: "",
      tool_calls: openedPayload.toolCalls,
    });
    const durableMessage = new AIMessage({
      content: "",
      tool_calls: openedPayload.toolCalls,
    });

    const [opened, durable] = await Promise.all([
      runtime.toolBoundary.protectAssistantToolCall(consumerMessage),
      runtime.publishMessages([durableMessage]),
    ]);

    expect(opened).not.toBeNull();
    expect(durable.status).toBe("protected");
    expect(publications).toBe(1);
  });

  test("keeps protecting long transcripts after the bounded dedupe cache fills", async () => {
    let publications = 0;
    const session: LiveShadowAgentTurnSession = Object.freeze({
      ...throwingSession({}).session,
      publishMessage: async (
        request: Parameters<LiveShadowAgentTurnSession["publishMessage"]>[0],
      ) => {
        publications += 1;
        return Object.freeze({
          status: "protected" as const,
          value: Object.freeze({
            reservation: Object.freeze({
              messageId: 1_000 + publications,
              transcriptOrdinal: publications,
              authorRole: "assistant" as const,
            }) as LiveShadowAgentPublishedMessage["reservation"],
            policyRevision: 9,
            ordinaryPayloadBytes: new Uint8Array([1]),
            openedPayload: request.payload,
            protectedMessage: Object.freeze({}) as ProtectedMessageDtoV2,
            durableEventDigest: new Uint8Array(32),
            streamEvidence: null,
          }),
        });
      },
    });
    const runtime = createLiveShadowAgentRuntimeTurn(session);

    for (let index = 0; index < 257; index += 1) {
      const result = await runtime.publishMessages([
        new AIMessage({ content: `protected message ${index}` }),
      ]);
      expect(result.status).toBe("protected");
    }

    expect(publications).toBe(257);
  });

  test("does not add execution-local status to the durable Tool payload", async () => {
    let captured: Parameters<LiveShadowAgentTurnSession["publishMessage"]>[0]
      | undefined;
    const session: LiveShadowAgentTurnSession = Object.freeze({
      reserveAssistantStream: () => Promise.reject(new Error("unused")),
      sealAssistantStreamChunk: () => {
        throw new Error("unused");
      },
      publishMessage: async (
        request: Parameters<LiveShadowAgentTurnSession["publishMessage"]>[0],
      ) => {
        captured = request;
        return Object.freeze({
          status: "protected" as const,
          value: Object.freeze({
            reservation: Object.freeze({
              messageId: 84,
              transcriptOrdinal: 3,
              authorRole: "tool" as const,
            }) as LiveShadowAgentPublishedMessage["reservation"],
            policyRevision: 9,
            ordinaryPayloadBytes: new Uint8Array([1]),
            openedPayload: request.payload,
            protectedMessage: Object.freeze({}) as ProtectedMessageDtoV2,
            durableEventDigest: new Uint8Array(32),
            streamEvidence: null,
          }),
        });
      },
      fail: () => undefined,
      destroy: () => undefined,
    });
    const runtime = createLiveShadowAgentRuntimeTurn(session);

    const result = await runtime.publishMessages([new ToolMessage({
      content: "17:34",
      tool_call_id: "call-live-shadow",
      name: "get_current_time",
      status: "success",
    })]);

    expect(result.status).toBe("protected");
    expect(captured?.payload.sensitiveMetadata).toEqual({
      toolCallId: "call-live-shadow",
    });
  });

  test("makes malformed confidential tool transport terminal even in fallback mode", async () => {
    const state = throwingSession({});
    const runtime = createLiveShadowAgentRuntimeTurn(state.session);
    const malformed = new AIMessage({
      content: [{
        type: "tool_use",
        id: "call-unpreserved",
        name: "search",
        input: { secret: "must-not-disappear" },
      } as never],
    });

    expect(runtime.toolBoundary.protectAssistantToolCall(malformed))
      .rejects.toBeInstanceOf(LiveShadowToolProtectionTerminalError);
    expect(state.failures).toEqual(["tool_call"]);
  });

  test("makes session integrity and parity failures terminal in fallback mode", async () => {
    for (const reason of ["integrity_failure", "parity_mismatch"] as const) {
      const failures: LiveShadowAgentSessionFailureStage[] = [];
      let authorizationDeadlineAt = Date.now() + 60_000;
      const session = {
        ...throwingSession({}).session,
        get authorizationDeadlineAt() {
          return authorizationDeadlineAt;
        },
        publishMessage: () => {
          authorizationDeadlineAt = Date.now() - 1;
          return Promise.resolve(Object.freeze({
            status: "ordinary_fallback" as const,
            stage: "tool_call" as const,
            reason,
          }));
        },
        fail: (stage: LiveShadowAgentSessionFailureStage) => failures.push(stage),
      } satisfies LiveShadowAgentTurnSession;
      const runtime = createLiveShadowAgentRuntimeTurn(session);

      expect(runtime.toolBoundary.protectAssistantToolCall(new AIMessage({
        content: "",
        tool_calls: [{ id: "terminal", name: "search", args: {} }],
      }))).rejects.toBeInstanceOf(LiveShadowToolProtectionTerminalError);
      expect(failures).toEqual([]);
    }
  });

  test("terminalizes malformed self-opened tool payloads instead of consuming ordinary bytes", async () => {
    for (const stage of ["tool_call", "tool_result"] as const) {
      const failures: LiveShadowAgentSessionFailureStage[] = [];
      const source = stage === "tool_call"
        ? new AIMessage({
          content: "",
          tool_calls: [{ id: "call-shape", name: "search", args: {} }],
        })
        : new ToolMessage({
          content: "ordinary result",
          tool_call_id: "call-shape",
          name: "search",
        });
      const malformedPublished = Object.freeze({
        reservation: Object.freeze({
          messageId: 85,
          transcriptOrdinal: 4,
          authorRole: stage === "tool_call" ? "assistant" as const : "tool" as const,
        }) as LiveShadowAgentPublishedMessage["reservation"],
        policyRevision: 9,
        ordinaryPayloadBytes: new Uint8Array([1]),
        openedPayload: Object.freeze({
          role: "human" as const,
          content: "invalid self-opened role",
        }),
        protectedMessage: Object.freeze({}) as ProtectedMessageDtoV2,
        durableEventDigest: new Uint8Array(32),
        streamEvidence: null,
      }) as unknown as LiveShadowAgentPublishedMessage;
      const session = {
        ...throwingSession({}).session,
        publishMessage: () => Promise.resolve(Object.freeze({
          status: "protected" as const,
          value: malformedPublished,
        })),
        fail: (failureStage: LiveShadowAgentSessionFailureStage) => {
          failures.push(failureStage);
        },
      } satisfies LiveShadowAgentTurnSession;
      const boundary = createLiveShadowAgentRuntimeTurn(session).toolBoundary;

      const result = stage === "tool_call"
        ? boundary.protectAssistantToolCall(source as AIMessage)
        : boundary.protectToolResult(source as ToolMessage);
      expect(result).rejects.toBeInstanceOf(
        LiveShadowToolProtectionTerminalError,
      );
      expect(failures).toEqual([stage]);
    }
  });

  test("makes terminal stream failures abort fallback-mode Agent execution", async () => {
    const reserveSession = {
      ...throwingSession({}).session,
      reserveAssistantStream: () => Promise.resolve(Object.freeze({
        status: "ordinary_fallback" as const,
        stage: "assistant_stream" as const,
        reason: "integrity_failure" as const,
      })),
    } satisfies LiveShadowAgentTurnSession;
    const reserveRuntime = createLiveShadowAgentRuntimeTurn(reserveSession);
    expect(reserveRuntime.reserveAssistantStream({
      assistantMessageKey: "terminal-reserve",
      createdAt: 1_800_000_000_000,
    })).rejects.toThrow("failed terminally");

    const sealSession = {
      ...throwingSession({}).session,
      sealAssistantStreamChunk: () => Object.freeze({
        status: "ordinary_fallback" as const,
        stage: "assistant_stream" as const,
        reason: "parity_mismatch" as const,
      }),
    } satisfies LiveShadowAgentTurnSession;
    const sealRuntime = createLiveShadowAgentRuntimeTurn(sealSession);
    expect(await sealRuntime.reserveAssistantStream({
      assistantMessageKey: "terminal-seal",
      createdAt: 1_800_000_000_000,
    })).not.toBeNull();
    expect(sealRuntime.sealAssistantStreamChunk({
      assistantMessageKey: "terminal-seal",
      ordinaryChunk: new TextEncoder().encode("must stop"),
      done: false,
    })).rejects.toThrow("failed terminally");
  });

  test("terminalizes a malformed final streamed Message before sealing it", async () => {
    const state = throwingSession({});
    const runtime = createLiveShadowAgentRuntimeTurn(state.session);
    expect(await runtime.reserveAssistantStream({
      assistantMessageKey: "terminal-final",
      createdAt: 1_800_000_000_000,
    })).not.toBeNull();

    expect(runtime.sealAssistantStreamChunk({
      assistantMessageKey: "terminal-final",
      ordinaryChunk: new TextEncoder().encode("must not complete"),
      done: true,
      finalMessage: new AIMessage({
        content: [{
          type: "future_confidential_block",
          secret: "must-not-disappear",
        } as never],
      }),
    })).rejects.toThrow("content block is unsupported");
    expect(state.failures).toEqual(["assistant_stream"]);
  });
});
