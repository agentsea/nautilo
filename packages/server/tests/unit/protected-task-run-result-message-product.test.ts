import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { NativeProtectedTaskRunResultMessageSourceV1 } from "@nautilo/lattice-bridge/server";
import type { ProtectedTaskOutputReadClosedProof } from "../../src/routes/protected-task-output-read-product";
import {
  createProtectedTaskRunResultMessageProductGuard,
  protectedTaskRunResultMessageAppendInput,
  type ProtectedTaskRunResultMessageProductInput,
} from "../../src/routes/protected-task-run-result-message-product";
import {
  withProtectedTaskRunResultMessageProductStore,
  type ProtectedTaskRunResultMessageProductStore,
} from "../../src/routes/protected-task-run-result-message-store";
import { taskRunResultMessageFixture } from
  "../../../lattice-bridge/tests/fixtures/task-run-result-message-fixture";

function setup(source: NativeProtectedTaskRunResultMessageSourceV1) {
  const intent: ProtectedTaskOutputReadClosedProof = {
    requesterUserId: "requester-user", requesterHumanId: source.requesterHumanId,
    agentId: source.result.signerAgentId, contentNamespaceId: source.result.namespace.namespaceId,
    representation: "protected", expectedPolicyRevision: 7, acceptedPolicyRevision: 6,
    result: source.result, invocation: source.invocation,
  };
  const state = {
    room: { id: source.invocation.roomId, ownerId: source.requesterHumanId,
      namespaceId: source.messageWrite.namespace.namespaceId, archivedAt: null },
    session: { id: source.invocation.sessionId, roomId: source.invocation.roomId,
      ownerId: source.requesterHumanId, agentId: source.result.signerAgentId,
      personaId: "owner", threadId: source.invocation.roomId },
    policy: { revision: 7, mode: "encrypted_only" },
  };
  let queries = 0;
  const tx = {
    select: () => {
      queries++;
      let rows: unknown[] = [];
      const builder = {
        from: (table: Parameters<typeof getTableName>[0]) => {
          const name = getTableName(table);
          rows = name === "rooms" ? [state.room] : name === "sessions"
            ? [state.session] : name === "encryption_transition_policy" ? [state.policy] : [];
          return builder;
        },
        where: () => builder, limit: () => builder, for: () => builder,
        then: (yes: (value: unknown[]) => unknown, no: (error: unknown) => unknown) => Promise.resolve(rows).then(yes, no),
      };
      return builder;
    },
    execute: () => Promise.resolve([]),
  } as unknown as CanonicalTranscriptTx;
  let active = true;
  let current: ProtectedTaskOutputReadClosedProof | null = intent;
  const input: ProtectedTaskRunResultMessageProductInput = {
    transaction: tx, intent, destinationNamespaceId: state.room.namespaceId,
    publicationPolicyRevision: 7, authorization: { kind: "source", source },
    revalidate: transaction => { expect(transaction).toBe(tx); return Promise.resolve(current); },
  };
  return { input, state, tx, queries: () => queries,
    close: () => { active = false; }, change: (value: typeof current) => { current = value; },
    guard: createProtectedTaskRunResultMessageProductGuard({ ...input, isActive: () => active }) };
}
function appendOperation(input: ProtectedTaskRunResultMessageProductInput) {
  return { action: "appendAllocated" as const, sessionId: input.intent.invocation.sessionId,
    messageId: 23, revision: 0, idempotencyKey: input.intent.invocation.operationId,
    authorRole: "assistant" as const, keyClass: "ai" as const,
    publicationPolicy: { expectedRevision: 7, representation: "protected_only" as const } };
}
async function denied(operation: Promise<unknown>) {
  const result = await Promise.allSettled([operation]);
  expect(result[0]?.status).toBe("rejected");
}

test("authentic source constructs only fixed assistant fields; Full has no ordinary body", async () => {
  const fixture = await taskRunResultMessageFixture();
  await fixture.run(async ({ source }) => {
    const { input, tx, guard } = setup(source);
    await guard.assertPublicationAllowed(tx, appendOperation(input));
    const full = protectedTaskRunResultMessageAppendInput(input);
    expect(full.content).toBeNull();
    expect(full.toolCalls).toBeNull(); expect(full.toolName).toBeNull();
    expect(full.metadata).toBeNull(); expect(full.transcriptOrigin).toBe("subagent");
    expect(full.structuralProjection).toEqual({ notificationEligibility: "excluded", subthreadReplyClassification: "excluded" });
    expect(full.requestDigest).toEqual(source.payloadDigest);
    expect(full.requestDigest).not.toBe(source.payloadDigest);
    const shadow = protectedTaskRunResultMessageAppendInput({ ...input,
      intent: { ...input.intent, representation: "dual" } });
    expect(shadow.content).toBe("A durable protected Task result");
    expect(shadow.content).not.toContain("must never become");
  });
});

test("forged source and staged token are refused before product access", async () => {
  const fixture = await taskRunResultMessageFixture();
  await fixture.run(async ({ source }) => {
    const { input, tx, queries } = setup(source);
    for (const authorization of [{ kind: "source", source: { ...source } },
      { kind: "staged", proof: {}, currentAuthority: {} }] as const) {
      const guard = createProtectedTaskRunResultMessageProductGuard({ ...input,
        authorization: authorization as never, isActive: () => true });
      await denied(guard.assertPublicationAllowed(tx, appendOperation(input)));
    }
    expect(queries()).toBe(0);
  });
});

test("closed source cannot authorize stale result, requester, Agent, destination or policy", async () => {
  const fixture = await taskRunResultMessageFixture();
  await fixture.run(async ({ source }) => {
    const { input, tx } = setup(source);
    for (const intent of [
      { ...input.intent, requesterHumanId: "another-human" },
      { ...input.intent, agentId: "another-agent" },
      { ...input.intent, contentNamespaceId: "another-private-namespace" },
      { ...input.intent, result: { ...input.intent.result, objectId: "another-result" } },
      { ...input.intent, result: { ...input.intent.result, genesisManifestHash: new Uint8Array(32) } },
      { ...input.intent, invocation: { ...input.intent.invocation, sessionId: "another-session" } },
      { ...input.intent, expectedPolicyRevision: 8 },
    ]) {
      const guard = createProtectedTaskRunResultMessageProductGuard({ ...input, intent, isActive: () => true });
      await denied(guard.assertPublicationAllowed(tx, appendOperation(input)));
    }
    expect(() => protectedTaskRunResultMessageAppendInput({ ...input, destinationNamespaceId: "private-fallback" })).toThrow();
  });
});

test("current canonical revalidation, Room, Session and policy remain mandatory", async () => {
  const fixture = await taskRunResultMessageFixture();
  await fixture.run(async ({ source }) => {
    for (const corrupt of [
      (f: ReturnType<typeof setup>) => f.change(null),
      (f: ReturnType<typeof setup>) => { Object.assign(f.state.room, { archivedAt: new Date() }); },
      (f: ReturnType<typeof setup>) => { f.state.room.namespaceId = "changed"; },
      (f: ReturnType<typeof setup>) => { f.state.session.agentId = "changed"; },
      (f: ReturnType<typeof setup>) => { f.state.session.ownerId = "changed"; },
      (f: ReturnType<typeof setup>) => { f.state.policy.revision = 8; },
      (f: ReturnType<typeof setup>) => { f.state.policy.mode = "plain"; },
      (f: ReturnType<typeof setup>) => f.close(),
    ]) {
      const f = setup(source); corrupt(f);
      await denied(f.guard.assertPublicationAllowed(f.tx, appendOperation(f.input)));
    }
    const f = setup(source);
    await denied(f.guard.assertPublicationAllowed({} as CanonicalTranscriptTx, appendOperation(f.input)));
    await denied(f.guard.assertPublicationAllowed(f.tx, { ...appendOperation(f.input), action: "markCryptoComplete" }));
  });
});

test("borrowed facade expires after callback and after callback failure; no connection escapes", async () => {
  const fixture = await taskRunResultMessageFixture();
  await fixture.run(async ({ source }) => {
    for (const failure of [false, true]) {
      const { input } = setup(source);
      let facade: ProtectedTaskRunResultMessageProductStore | undefined;
      const operation = withProtectedTaskRunResultMessageProductStore({ ...input,
        product: { query: () => Promise.resolve([{ current_user: "nautilo", session_user: "nautilo" }]) } as never,
        use: store => { facade = store; if (failure) throw new Error("rollback"); return Promise.resolve("done"); },
      });
      if (failure) await denied(operation); else expect(await operation).toBe("done");
      expect(facade).toBeDefined();
      await denied(facade!.appendAllocated());
    }
  });
});
