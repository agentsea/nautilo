import { setup, replanFixture } from "../fixtures/human-task-mapped-content.ts";
import { fixture as taskCryptoFixture, authority as taskAuthority,
  coordinate as taskCoordinate } from "../fixtures/task-content-crypto-completion.ts";
import { taskRuntimeStableIdempotencyKey } from "../../../runtime/src/protected-execution/background-authorization/task-runtime-grant-claim";
import { InMemoryBackgroundAuthorizationRepository, buildUnclaimedTaskMappedHeadAuthorityReplacement } from "../../../runtime/src/protected-execution/background-authorization/repository";
import { readVerifiedTaskDefinitionAccessLineage, inspectMappedTaskDefinitionAccessLineage,
  readVerifiedForegroundTaskDefinitionAccessRevision, refreshHumanMappedTaskContentAccessHead } from "../../src/server/task/postgres-foreground-task-definition-inspector.ts";
import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { decodeObjectAccessManifestV5 } from "@nautilo/lattice-crypto/wire";
import type { HeldHumanTaskMappedContentAuthority } from "../../src/server/task/postgres-human-task-mapped-content-authority.ts";

describe("Human Task mapped access head", () => {
  for (const kind of ["human", "historical", "agent"] as const) {
    test(`${kind} terminal result repairs the exact mapped access head and keeps immutable provenance`, async () => {
      const f = await setup(kind, true);
      try {
        const before = structuredClone(f.ledger);
        expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("applied");
        expect(f.access()).toBe(1); expect(f.ledger).toEqual(before);
        expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("duplicate");
        expect(f.ledger).toEqual(before);
      } finally { f.cleanup(); }
    });
  }
  test("a later native Human content revision refreshes without a content bump", async () => {
    const f = await setup("human", false, 3);
    try { expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("applied"); expect(f.ledger.content_revision).toBe(3); }
    finally { f.cleanup(); }
  });
  test("a running or grant-captured terminal result remains frozen", async () => {
    for (const deny of ["running", "grant", "plain", "domain"] as const) {
      const f = await setup("human", true);
      try { f[deny](); expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("unavailable"); expect(f.access()).toBe(0); }
      finally { f.cleanup(); }
    }
  });
  test("source-versioned historical definitions retain exact provenance while advancing only the access head", async () => {
    const f = await setup("historical");
    try {
      const before = structuredClone(f.ledger);
      expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("applied");
      expect(f.access()).toBe(1); expect(f.ledger).toEqual(before);
    } finally { f.cleanup(); }
  });
  test("a substituted immutable ledger between inspection and CAS cannot map", async () => {
    for (const kind of ["human", "agent"] as const) {
      const f = await setup(kind);
      try { f.substituteLedger(); await rejects(refreshHumanMappedTaskContentAccessHead(f.input), /reservation changed/); expect(f.access()).toBe(0); }
      finally { f.cleanup(); }
    }
  });

  test("mapped Agent definition refresh preserves the operation digest without treating it as a manifest hash", async () => {
    const f = await setup("agent", false, 2);
    try {
      const before = structuredClone(f.ledger);
      const genesisHash = f.crypto.connection.state.manifests.get(0)!["manifest_hash"];
      expect(f.ledger.request_digest).not.toEqual(genesisHash);
      expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("applied");
      expect(f.access()).toBe(1);
      expect(f.ledger).toEqual(before);
      expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("duplicate");
    } finally { f.cleanup(); }
  });

  test("foreground Task authorization borrows the exact held mapped-content authority only during refresh", async () => {
    const f = await setup("foreground");
    const resolverContexts: HeldHumanTaskMappedContentAuthority[] = [];
    const mappedHeadContexts: HeldHumanTaskMappedContentAuthority[] = [];
    try {
      expect(await refreshHumanMappedTaskContentAccessHead({
        ...f.input,
        resolveTaskDefinitionForegroundAuthorization: async (
          evidence,
          context,
        ) => {
          context.assertCurrent();
          expect(evidence.objectId).toBe(f.crypto.prepared.objectId);
          expect(evidence.authorizationBytes).toEqual(
            f.foregroundAuthorizationBytes,
          );
          expect(evidence.principal.agentId).toBe("task-agent");
          resolverContexts.push(context);
          return f.crypto.foregroundSignerPublicKey?.slice() ?? null;
        },
        withMappedHead: async ({ context }) => {
          context.assertCurrent();
          mappedHeadContexts.push(context);
          const resolverContext = resolverContexts[0];
          if (resolverContext === undefined) {
            throw new Error("authorization resolver context was not observed");
          }
          expect(context).toBe(resolverContext);
        },
      })).toBe("applied");
      const resolverContext = resolverContexts[0];
      const mappedHeadContext = mappedHeadContexts[0];
      if (resolverContext === undefined || mappedHeadContext === undefined) {
        throw new Error("borrowed mapped-content authority was not observed");
      }
      expect(resolverContext).toBe(mappedHeadContext);
      expect(() => resolverContext.assertCurrent()).toThrow(
        "Human Task mapped authority is closed or expired",
      );
    } finally {
      f.cleanup();
    }
  });

  test("foreground Task authorization wipes a returned signer key when held authority expires", async () => {
    const f = await setup("foreground");
    const returnedKeys: Uint8Array[] = [];
    try {
      await rejects(refreshHumanMappedTaskContentAccessHead({
        ...f.input,
        resolveTaskDefinitionForegroundAuthorization: async () => {
          const signerPublicKey = f.crypto.foregroundSignerPublicKey?.slice();
          if (signerPublicKey === undefined) {
            throw new Error("foreground signer key is unavailable");
          }
          returnedKeys.push(signerPublicKey);
          f.expire();
          return signerPublicKey;
        },
      }), /Human Task mapped authority is closed or expired/);
      const returnedKey = returnedKeys[0];
      if (returnedKey === undefined) {
        throw new Error("foreground signer key was not returned");
      }
      expect(returnedKey).toEqual(new Uint8Array(returnedKey.length));
      expect(f.access()).toBe(0);
      expect(f.events).not.toContain("map");
    } finally {
      f.cleanup();
    }
  });

  test("repairs a paused definition through metadata authority without a key loan and preserves the signed-request digest", async () => {
    const f = await setup();
    try {
      const digest = f.ledger.request_digest.slice();
      expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("applied");
      expect(f.access()).toBe(1); expect(f.ledger.request_digest).toEqual(digest);
      expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("duplicate");
      expect(f.events.indexOf("policy-lock")).toBeLessThan(f.events.indexOf("tasks"));
      expect(f.events.indexOf("tasks")).toBeLessThan(f.events.indexOf("room"));
      expect(f.events.indexOf("room")).toBeLessThan(f.events.indexOf("device"));
      expect(f.events.indexOf("grant")).toBeLessThan(f.events.indexOf("map"));
    } finally { f.cleanup(); }
  });
  for (const deny of ["running", "queued", "grant", "archive", "revoke", "plain", "expire", "domain"] as const) {
    test(`denies ${deny} before mapping`, async () => {
      const f = await setup();
      try { f[deny](); expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("unavailable");
        expect(f.access()).toBe(0); expect(f.events).not.toContain("map"); }
      finally { f.cleanup(); }
    });
  }
  test("product commit loss preserves the old product access head", async () => {
    const f = await setup();
    try { f.failCommit(); await rejects(refreshHumanMappedTaskContentAccessHead(f.input), /commit rejected/); expect(f.access()).toBe(0); }
    finally { f.cleanup(); }
  });
  test("a changed genesis or ciphertext cannot authorize metadata mapping", async () => {
    for (const source of ["manifest_bytes", "payload_bytes"] as const) {
      const f = await setup();
      try {
        const row = source === "manifest_bytes" ? f.crypto.connection.state.manifests.get(0)! : f.crypto.connection.state.object!;
        (row[source] as Uint8Array)[0]! ^= 1;
        await rejects(refreshHumanMappedTaskContentAccessHead(f.input)); expect(f.access()).toBe(0);
      } finally { f.cleanup(); }
    }
  });
});

test("live Human metadata proof rotates only an exact unclaimed descendant plan and cannot escape", async () => {
  const f = await setup();
  let escaped: ReturnType<typeof replanFixture> | undefined;
  try {
    expect(await refreshHumanMappedTaskContentAccessHead({ ...f.input, withMappedHead: async held => {
      const input = replanFixture(held); escaped = input;
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(input.expected);
      const result = await repository.replaceUnclaimedTaskMappedHeadAuthority(input);
      expect(result.status).toBe("replaced");
      if (result.status !== "replaced") throw new Error("replacement required");
      expect(result.record.idempotencyKey).toBe(input.replacement.idempotencyKey);
      expect(result.record.snapshot.recipientGeneration).toBe(1);
      expect(result.record.snapshot.requestId).toBe(input.expected.snapshot.requestId);
      expect(result.record.snapshot.state).toBe("awaiting_recipient");
      expect((await repository.replaceUnclaimedTaskMappedHeadAuthority(input)).status).toBe("stale");
      expect(readVerifiedTaskDefinitionAccessLineage(input.lineage, input.stableIdentity)).toEqual([0, 1]);
    } })).toBe("applied");
    if (escaped === undefined) throw new Error("proof missing");
    const closed = escaped;
    expect(() => buildUnclaimedTaskMappedHeadAuthorityReplacement(closed)).toThrow("foreign or closed");
    // Immutable history remains usable only for the exact mapped snapshot; it grants no CAS authority.
    expect(readVerifiedTaskDefinitionAccessLineage(escaped.lineage, escaped.stableIdentity)).toEqual([0, 1]);
    expect(() => readVerifiedTaskDefinitionAccessLineage(closed.lineage, { ...closed.stableIdentity, contentAccessRevision: 2 })).toThrow();
  } finally { f.cleanup(); }
});

test("mapped-head replan rejects changed semantic anchors, foreign history and accepted work", async () => {
  const f = await setup();
  try {
    await refreshHumanMappedTaskContentAccessHead({ ...f.input, withMappedHead: async held => {
      const input = replanFixture(held);
      for (const patch of [{ taskId: "other-task" }, { taskRunId: "other-run" }, { contentNamespaceId: "other-namespace" },
        { targetRoomId: "other-room" }, { requiredNamespaceFingerprint: "changed" }, { contentObjectId: "changed" },
        { contentRevision: 2 }, { contentAccessRevision: 2 }]) {
        const stableIdentity = { ...input.stableIdentity, ...patch };
        expect(() => buildUnclaimedTaskMappedHeadAuthorityReplacement({ ...input, stableIdentity,
          replacement: { ...input.replacement, idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity) } })).toThrow();
      }
      expect(() => buildUnclaimedTaskMappedHeadAuthorityReplacement({ ...input, lineage: { kind: "verified_task_definition_access_lineage" } })).toThrow();
      expect(() => buildUnclaimedTaskMappedHeadAuthorityReplacement({ ...input, expected: { ...input.expected,
        idempotencyKey: taskRuntimeStableIdempotencyKey(input.stableIdentity) } })).toThrow("unique immutable predecessor");
      for (const state of ["grant_ready", "claimed", "running", "publication_reconciliation", "terminal_failure", "completed"] as const) {
        expect(() => buildUnclaimedTaskMappedHeadAuthorityReplacement({ ...input,
          expected: { ...input.expected, snapshot: { ...input.expected.snapshot, state } } })).toThrow();
      }
      expect(readVerifiedForegroundTaskDefinitionAccessRevision(input.proof, input)).toBe(1);
    } });
  } finally { f.cleanup(); }
});

test("detached lineage verifies retained signed prefixes and grants no live metadata capability", async () => {
  const f = await setup();
  try {
    const input = { handle: f.crypto.handle, crypto: f.crypto.crypto, coordinate: { ...f.input.coordinate, kind: "definition" as const },
      objectId: f.crypto.prepared.objectId, namespaceId: f.ledger.content_namespace_id,
      requesterHumanId: f.ledger.requester_human_id, mappedAccessRevision: 1,
      expectedAgentId: "unused-human-genesis", ...f.crypto.history };
    const proof = await inspectMappedTaskDefinitionAccessLineage(input);
    expect(proof).not.toBeNull();
    if (proof === null) throw new Error("signed lineage required");
    const current = { taskId: input.coordinate.taskId, contentRevision: input.coordinate.contentRevision,
      contentObjectId: input.objectId, contentNamespaceId: input.namespaceId, contentAccessRevision: 1 };
    expect(readVerifiedTaskDefinitionAccessLineage(proof, current)).toEqual([0, 1]);
    expect(() => readVerifiedTaskDefinitionAccessLineage(structuredClone(proof), current)).toThrow();
    expect(await inspectMappedTaskDefinitionAccessLineage({ ...input, mappedAccessRevision: 0 })).toBeNull();
    expect(await inspectMappedTaskDefinitionAccessLineage({ ...input, requesterHumanId: "other-human" })).toBeNull();
    (f.crypto.connection.state.manifests.get(0)!["manifest_bytes"] as Uint8Array)[0]! ^= 1;
    await rejects(inspectMappedTaskDefinitionAccessLineage(input));
  } finally { f.cleanup(); }
});

test("detached lineage accepts a retained same-Human cross-Agent definition author", async () => {
  const crypto = await taskCryptoFixture("foreground", true, true);
  await crypto.adapter.complete(crypto.prepared);
  crypto.rewrapHuman(3);
  const input = {
    handle: crypto.handle,
    crypto: crypto.crypto,
    coordinate: taskCoordinate,
    objectId: crypto.prepared.objectId,
    namespaceId: taskAuthority.namespaceId,
    requesterHumanId: taskAuthority.requesterHumanId,
    mappedAccessRevision: 1,
    expectedAgentId: "different-task-executor",
    ...crypto.history,
  };
  expect(await inspectMappedTaskDefinitionAccessLineage(input)).not.toBeNull();
  crypto.invalidateAcceptedPlan();
  await rejects(inspectMappedTaskDefinitionAccessLineage(input));
});

for (const kind of ["human", "foreground"] as const) test(`detached ${kind} lineage keeps its original signer rule without a Domain head`, async () => {
  const crypto = await taskCryptoFixture(kind, true, true);
  await crypto.adapter.complete(crypto.prepared);
  crypto.rewrapHuman(3);
  const genesis = decodeObjectAccessManifestV5(
    crypto.connection.state.manifests.get(0)!["manifest_bytes"] as Uint8Array,
  );
  const input = {
    handle: crypto.handle, crypto: crypto.crypto, coordinate: taskCoordinate,
    objectId: crypto.prepared.objectId, namespaceId: taskAuthority.namespaceId,
    requesterHumanId: taskAuthority.requesterHumanId, mappedAccessRevision: 1,
    expectedAgentId: genesis.signer.kind === "agent_runtime"
      ? genesis.signer.agentId : "unused-human-genesis",
    ...crypto.history,
  };
  crypto.connection.namespaceHead = null;
  expect(await inspectMappedTaskDefinitionAccessLineage(input)).not.toBeNull();
  if (kind === "foreground") {
    expect(await inspectMappedTaskDefinitionAccessLineage({
      ...input, expectedAgentId: "different-task-executor",
    })).toBeNull();
  }
});
