import { describe, expect, test } from "bun:test";
import {
  agentId, agentRuntimeGeneration, authorizationRevision,
  deriveAgentRuntimeObjectSignerPublic, LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { createLiveShadowAgentTurnSession } from "../../src/server/message/live-shadow-agent-session.ts";

const NOW = 1_800_300_000_000;
const PAYLOAD = { role: "assistant" as const, content: "Inspecting the result" };

function fixture(mode: "shadow_encryption" | "full_encryption") {
  const crypto = new LatticeCrypto();
  const runtime = {
    agentId: "40000000-0000-4000-8000-000000000001", generation: 4,
    keyClass: "runtime", key: new Uint8Array(32).fill(0x36),
  } as never;
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const authorization = new AbortController();
  const state = { now: NOW, writes: [] as string[], ordinals: [] as number[], diagnostics: [] as unknown[] };
  const session = createLiveShadowAgentTurnSession({
    crypto,
    representationMode: mode,
    plan: {
      deadlineAt: NOW + 30_000,
      operationId: "stream-publication-operation", policyRevision: 7,
      sessionId: "10000000-0000-4000-8000-000000000001",
      roomId: "20000000-0000-4000-8000-000000000001",
      namespaceId: "30000000-0000-4000-8000-000000000001",
      namespaceHeadDigest: new Uint8Array(32).fill(0x31),
      namespacePublicationDigest: new Uint8Array(32).fill(0x32),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x33),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x34),
      agentAuthorizationRevision: 5,
      recipientAgentId: "40000000-0000-4000-8000-000000000001",
      agentSignerKeyId: signer.principal.signerKeyId,
      agentSignerPublicKey: signer.publicKey,
      hostAuthorizationRevision: 9,
    } as never,
    causalHumanUserId: "stream-publication-human",
    product: {
      reserveLiveShadowAgent: async (request: { transcriptOrdinal: number }) => {
        state.ordinals.push(request.transcriptOrdinal);
        return {
          status: "reserved",
          allocation: {
            status: "allocated", messageId: 501, revision: 0,
            roomId: "20000000-0000-4000-8000-000000000001",
            namespaceId: "30000000-0000-4000-8000-000000000001",
            keyClass: "ai", authorRole: "assistant",
            cryptoObjectId: "message:stream-publication",
          },
          createdAt: NOW,
        };
      },
      publishReservedLiveShadowAgent: async () => {
        state.writes.push("publish");
        return { status: "allocated" };
      },
      recordLiveShadowAgentEvidence: async () => {
        state.writes.push("evidence");
        return "applied";
      },
    } as never,
    conversation: {
      completeRevision: async () => {
        state.writes.push("complete");
        return { status: "mapped" };
      },
    } as never,
    namespace: {
      namespaceId: "30000000-0000-4000-8000-000000000001", accessRevision: 2,
      headDigest: new Uint8Array(32).fill(0x31),
      publicationDigest: new Uint8Array(32).fill(0x32),
      publicationSetDigest: new Uint8Array(32).fill(0x33),
      audienceFingerprint: new Uint8Array(32).fill(0x34),
      keyGeneration: 3, aiKey: new Uint8Array(32).fill(0x35),
    },
    runtime,
    grantId: "stream-publication-grant", grantDigest: new Uint8Array(32).fill(0x37),
    recipientKeyId: "stream-publication-recipient",
    authorizationDeadlineAt: NOW + 30_000,
    authorizationSignal: authorization.signal,
    resolveCurrentDeviceWrappedAgentObjectAuthorization: (context) => ({
      context, grantAuthorized: true, namespaceAuthorized: true,
      agentAuthorized: true, hostAllowsOperation: true,
      currentRuntime: {
        agentId: agentId("40000000-0000-4000-8000-000000000001"),
        authorizationRevision: authorizationRevision(5),
        runtimeGeneration: agentRuntimeGeneration(4),
      },
      signerPublicKey: signer.publicKey.slice(),
    }),
    now: () => state.now,
    onDiagnostic: (_stage, error) => state.diagnostics.push(error instanceof Error ? error.stack : error),
  });
  return { session, state, authorization };
}

async function reserve(session: ReturnType<typeof fixture>["session"]) {
  const result = await session.reserveAssistantStream({
    assistantMessageKey: "assistant:stream-publication:0", createdAt: NOW,
  });
  if (result.status !== "protected") throw new Error("Expected protected stream");
  return result.value.reservation;
}

for (const mode of ["shadow_encryption", "full_encryption"] as const) {
  describe(`${mode} stream publication ordering`, () => {
    test("waits for terminal evidence before writing and reuses one ordinal", async () => {
      const { session, state } = fixture(mode);
      try {
        const reservation = await reserve(session);
        let settled = false;
        const pending = session.publishMessage({
          payload: PAYLOAD, stage: "tool_call", reservation,
        }).then((result) => { settled = true; return result; });
        const chunk = session.sealAssistantStreamChunk({
          reservation, ordinaryChunk: new TextEncoder().encode(PAYLOAD.content), done: false,
        });
        expect(chunk.status).toBe("protected");
        await Bun.sleep(0);
        expect(settled).toBe(false);
        expect(state.writes).toEqual([]);
        const frame = session.sealAssistantStreamChunk({
          reservation, ordinaryChunk: new Uint8Array(),
          done: true, finalPayload: PAYLOAD,
        });
        expect(frame.status).toBe("protected");
        const published = await pending;
        expect(state.diagnostics).toEqual([]);
        expect(published.status).toBe("protected");
        expect(state.writes).toEqual(["publish", "complete", "evidence"]);
        const durable = await session.publishMessage({
          payload: PAYLOAD, stage: "assistant_message", reservation,
        });
        expect(durable).toEqual(published);
        expect(state.ordinals).toEqual([2]);
        expect(state.writes).toEqual(["publish", "complete", "evidence"]);
      } finally { session.destroy(); }
    });

    for (const stop of ["failure", "cancellation", "job_cancellation", "destroy", "expiry"] as const) {
      test(`releases publication without writes on ${stop}`, async () => {
        const { session, state, authorization } = fixture(mode);
        try {
          const reservation = await reserve(session);
          // Use the existing retained deadline; advancing the fixture clock
          // leaves only its final millisecond when the wait is installed.
          if (stop === "expiry") state.now = NOW + 29_999;
          const pending = session.publishMessage({
            payload: PAYLOAD, stage: "tool_call", reservation,
          });
          if (stop === "failure") session.fail("assistant_stream", "integrity_failure");
          if (stop === "cancellation") authorization.abort();
          if (stop === "job_cancellation") session.fail("agent_input", "cancelled");
          if (stop === "destroy") session.destroy();
          if (stop === "expiry") state.now = NOW + 30_000;
          const result = await pending;
          expect(result.status).toBe("ordinary_fallback");
          if (result.status !== "ordinary_fallback") throw new Error("Expected terminal failure");
          expect(result.reason).toBe(stop === "job_cancellation" ? "cancelled"
            : stop === "failure" ? "integrity_failure"
            : stop === "expiry" ? "deadline_expired" : "protected_unavailable");
          expect(state.writes).toEqual([]);
          expect(state.ordinals).toEqual([2]);
        } finally { session.destroy(); }
      });
    }

    test("publishes an assistant without a stream immediately", async () => {
      const { session, state } = fixture(mode);
      try {
        const result = await session.publishMessage({ payload: PAYLOAD, stage: "tool_call" });
        expect(state.diagnostics).toEqual([]);
        expect(result.status).toBe("protected");
        expect(state.ordinals).toEqual([2]);
        expect(state.writes).toEqual(["publish", "complete", "evidence"]);
      } finally { session.destroy(); }
    });
  });
}
