import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as db from "@nautilo/db";
import { ContentAccessAuthorityError } from "../../src/content-access-authority";
import type {
  CommittedArtifactShareEffect,
  ContentAccessCommand,
  ContentAccessPreparation,
} from "../../src/content-access-coordinator";
import type { AuthorizedContentAttachmentSnapshot } from "../../src/content-access-plan";
import { createContentAccessPreviewCodec } from "../../src/content-access-preview";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const a = id(1), b = id(2), c = id(3), d = id(4);
const admission = { principal: { kind: "human" as const, userId: id(10), actorId: a,
  sourceRoomId: id(20) }, audienceContract: "invoking_room" as const,
approvalContext: "policy-normal:approved-tool-call-1" };
const object = { kind: "artifact" as const, id: id(30) };
const command = (target = c, operation = 40): ContentAccessCommand => ({
  operationId: id(operation), object, change: { kind: "grant_people", selectedActorIds: [target] },
});

let clock = 0;
let policyRevision = 1;
let sourceRevision = "source-authority-1";
let objectRevision = "content-1";
let targetRevision = 1;
let denied = false;
let failReceipt = false;
let loseCommitReply = false;
let rejectTransactions = false;
let expireAfterOperationLock = false;
let expireAfterAuthority = false;
let expireAfterPublication = false;
let abortNextAuthority: "40P01" | "40001" | undefined;
let attachments: AuthorizedContentAttachmentSnapshot[] = [];
let receipts = new Map<string, db.ContentAccessOperation>();
let namespaceAudiences = new Map<string, readonly string[]>();
const events: string[] = [];

function transaction() {
  const stagedReceipts = new Map(receipts);
  const stagedAttachments = new Set(attachments.map((row) => row.namespaceId));
  const stagedAudiences = new Map(namespaceAudiences);
  const tx = {
    stagedAudiences,
    execute: async () => {
      events.push("operation-lock");
      if (expireAfterOperationLock) clock = 10 * 60 * 1000;
    },
    select: () => ({ from: (table: unknown) => ({
      innerJoin: () => ({ where: (query: { right: string[] }) => ({ orderBy: async () =>
        query.right.map((actorId) => ({ actorId, displayName: `Person ${actorId}`, userHandle: null })) }) }),
      where: async (query: unknown) => {
      if (table === db.contentAccessOperations) {
        events.push("replay");
        // eq is mocked to preserve the exact operation-id predicate.
        const operationId = (query as { right: string }).right;
        const row = stagedReceipts.get(operationId);
        return row ? [row] : [];
      }
      if (table === db.rooms) {
        events.push("authorized-destination-labels");
        return [{ id: id(21), label: "Current Room label" },
          ...[...stagedAudiences.keys()].map((namespaceId) => ({ id: `room:${namespaceId}`, label: "Shared access" }))];
      }
      return [...stagedAttachments].map((namespaceId) => ({ id: namespaceId }));
    } }) }),
    insert: (table: unknown) => {
      let values: Record<string, unknown>;
      const chain = {
        values(next: Record<string, unknown>) { values = next; return chain; },
        onConflictDoNothing() { return chain; },
        async returning() {
          if (table === db.contentAccessOperations) {
            events.push("receipt-write");
            if (failReceipt) { failReceipt = false; throw new Error("receipt insert unavailable"); }
            const row = { ...values, createdAt: new Date() } as db.ContentAccessOperation;
            if (stagedReceipts.has(row.operationId)) throw new Error("duplicate operation");
            stagedReceipts.set(row.operationId, row);
            if (expireAfterPublication) clock = 10 * 60 * 1000;
            return [row];
          }
          events.push("attachment-write");
          const ns = values!["namespaceId"] as string;
          if (stagedAttachments.has(ns)) return [];
          stagedAttachments.add(ns);
          return [{ id: ns }];
        },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return chain.returning().then(resolve, reject);
        },
      };
      return chain;
    },
    delete: () => {
      let namespaceIds: readonly string[] = [];
      const chain = {
        where(query: { queries: readonly { right: unknown }[] }) {
          namespaceIds = query.queries.find((part) => Array.isArray(part.right))?.right as readonly string[] ?? [];
          return chain;
        },
        async returning() {
          events.push("attachment-delete");
          const deleted = namespaceIds.filter((namespaceId) => stagedAttachments.delete(namespaceId));
          return deleted.map((id) => ({ id }));
        },
      };
      return chain;
    },
  };
  return { tx, commit() {
    receipts = stagedReceipts;
    namespaceAudiences = stagedAudiences;
    attachments = [...stagedAttachments].map((namespaceId) => attachments.find((row) =>
      row.namespaceId === namespaceId) ?? { namespaceId, roomId: `room:${namespaceId}`,
      kind: "access", mutable: true, humanActorIds: stagedAudiences.get(namespaceId)! });
  } };
}

let queue = Promise.resolve();
mock.module("@nautilo/db", () => ({ ...db,
  and: (...queries: unknown[]) => ({ queries }),
  eq: (left: unknown, right: unknown) => ({ left, right }),
  inArray: (left: unknown, right: unknown) => ({ left, right }),
  acquireEncryptionConsumptionFence: async () => { events.push("policy-fence"); return { revision: policyRevision }; },
  getSharedDirectDb: () => ({ transaction: <T>(run: (tx: unknown) => Promise<T>) => {
    const result = queue.then(async () => {
      if (rejectTransactions) throw new Error("database unavailable");
      const fixture = transaction();
      try {
        const value = await run(fixture.tx);
        fixture.commit();
        events.push("commit");
        if (loseCommitReply) { loseCommitReply = false; throw new Error("reply lost"); }
        return value;
      } catch (error) { events.push("rollback-or-lost-reply"); throw error; }
    });
    queue = result.then(() => {}, () => {});
    return result;
  } }),
}));

const loadAuthority = mock(async (_tx: unknown, input: { intent?: {
  selectedActorIds?: readonly string[]; legacyPersonalGrant?: boolean; targetRoomId?: string;
  makePrivate?: boolean;
} }) => {
  events.push("authority");
  if (abortNextAuthority) {
    const code = abortNextAuthority;
    abortNextAuthority = undefined;
    throw new Error("query failed", { cause: Object.assign(new Error("transaction aborted"), { code }) });
  }
  if (denied) throw new ContentAccessAuthorityError("denied");
  if (expireAfterAuthority) clock = 10 * 60 * 1000;
  const ids = input.intent?.selectedActorIds;
  if (ids) events.push("human-targets");
  return { policyRevision, object: { ...object, revision: objectRevision },
    display: { kind: "artifact" as const, path: "same-snapshot.txt", mimeType: "text/plain", size: 12 },
    sourceAuthorityDigest: sourceRevision,
    sourceContext: { roomId: admission.principal.sourceRoomId, humanActorIds: [a, b] },
    attachments: [...attachments], isPublicSource: false,
    humans: ids ? [...new Set([...(input.intent?.legacyPersonalGrant ? [a] : [a, b]), ...ids])].sort()
      .map((actorId) => ({ actorId, userId: `user:${actorId}` })) : undefined,
    target: input.intent?.targetRoomId || input.intent?.makePrivate ? {
      destination: { roomId: id(21), namespaceId: id(51),
        humanActorIds: input.intent?.makePrivate ? [a] : [a, c] },
      authority: { requestedRoomId: id(21), requestedKind: "group", requestedRevision: targetRevision,
        ownerKind: "group", ownerRevision: targetRevision },
    } : undefined,
  };
});
mock.module("../../src/content-access-authority", () => ({
  ContentAccessAuthorityError, lockContentAccessAuthorityInTx: loadAuthority,
}));
mock.module("../../src/content-access-namespace", () => ({
  resolveContentAccessNamespaceInTx: async (tx: { stagedAudiences: Map<string, readonly string[]> },
    input: { humanActorIds: readonly string[] }) => {
    events.push("room-construction");
    const namespaceId = `access:${input.humanActorIds.join(",")}`;
    tx.stagedAudiences.set(namespaceId, input.humanActorIds);
    return { roomId: `room:${namespaceId}`, namespaceId, minted: true };
  },
}));
const { createContentAccessCoordinator } = await import("../../src/content-access-coordinator");
const observeCommittedArtifactShares = mock(async (_effect: CommittedArtifactShareEffect) => undefined);
const coordinator = createContentAccessCoordinator(
  createContentAccessPreviewCodec(new Uint8Array(32).fill(7), () => clock),
  { observeCommittedArtifactShares },
);
afterAll(() => mock.restore());
beforeEach(() => {
  clock = 0; policyRevision = 1; sourceRevision = "source-authority-1"; objectRevision = "content-1";
  targetRevision = 1; denied = false; failReceipt = false; loseCommitReply = false; rejectTransactions = false;
  expireAfterOperationLock = false; expireAfterAuthority = false; expireAfterPublication = false;
  abortNextAuthority = undefined;
  receipts = new Map(); namespaceAudiences = new Map();
  attachments = [{ namespaceId: id(50), roomId: id(20), kind: "dynamic", humanActorIds: [a, b], mutable: true }];
  events.length = 0; loadAuthority.mockClear(); observeCommittedArtifactShares.mockClear();
});

async function prepare(input = command()): Promise<ContentAccessPreparation> {
  const prepared = await coordinator.prepare(admission, input);
  expect(prepared.outcome).toBe("prepared");
  if (prepared.outcome !== "prepared") throw new Error("prepare failed");
  return prepared;
}

describe("ordinary access coordinator", () => {
  test("peer contact requires an exact successful receipt and live unchanged grant, not receipt history", async () => {
    const agentAdmission = { ...admission, principal: { ...admission.principal, kind: "agent" as const, agentId: "agent" } };
    const prepared = await coordinator.prepare(agentAdmission, command());
    if (prepared.outcome !== "prepared") throw new Error("prepare failed");
    const verify = () => coordinator.verifyPreparedGrantForContact(agentAdmission, command(), prepared.previewToken);
    expect(await verify()).toBe(false);
    expect((await coordinator.commit(agentAdmission, command(), prepared.previewToken)).outcome).toBe("applied");
    clock = 11 * 60 * 1000;
    events.length = 0;
    expect(await verify()).toBe(true);
    expect(events).not.toContain("attachment-write");
    expect(events).not.toContain("receipt-write");
    expect(events).not.toContain("room-construction");
    objectRevision = "changed-content";
    expect(await verify()).toBe(false);
    objectRevision = "content-1";
    denied = true;
    expect(await verify()).toBe(false);
    denied = false;
    policyRevision += 1;
    expect(await verify()).toBe(false);
    policyRevision -= 1;
    attachments = attachments.filter((attachment) => attachment.kind !== "access");
    expect(await verify()).toBe(false);
    expect(receipts.size).toBe(1);
    expect(attachments).toHaveLength(1);
    expect(await coordinator.verifyPreparedGrantForContact(admission, command(), prepared.previewToken)).toBe(false);
  });

  test("prepare computes exact A+B+C preview without Room, attachment or ledger writes", async () => {
    const prepared = await prepare();
    expect(prepared.preview.humanActorIds).toEqual([a, b, c]);
    expect(prepared.preview.people.map((person) => person.actorId)).toEqual([a, b, c]);
    expect(prepared.display).toEqual({ kind: "artifact", path: "same-snapshot.txt", mimeType: "text/plain", size: 12 });
    expect(prepared.expiresAt).toBe(10 * 60 * 1000);
    expect(events).toEqual(["authority", "human-targets", "commit"]);
    expect(receipts.size).toBe(0);
    expect(namespaceAudiences.size).toBe(0);
    expect(attachments).toHaveLength(1);
  });

  test("trusted legacy contract grants A+C from A+B with full real source authority still bound", async () => {
    const legacyAdmission = { ...admission, audienceContract: "legacy_personal_grant" as const };
    const prepared = await coordinator.prepare(legacyAdmission, command());
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") throw new Error("missing legacy preview");
    expect(prepared.preview.humanActorIds).toEqual([a, c]);
    const substituted = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(substituted.outcome).toBe("denied");
    const applied = await coordinator.commit(legacyAdmission, command(), prepared.previewToken);
    expect(applied.outcome).toBe("applied");
    expect([...namespaceAudiences.values()]).toEqual([[a, c]]);
    const wrongContractReplay = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(wrongContractReplay.outcome).toBe("denied");
    const nextCommand = command(d, 41);
    const next = await coordinator.prepare(legacyAdmission, nextCommand);
    if (next.outcome !== "prepared") throw new Error("missing legacy preview");
    sourceRevision += "-changed";
    const stale = await coordinator.commit(legacyAdmission, nextCommand, next.previewToken);
    expect(stale.outcome).toBe("stale");
  });

  test("legacy personal contract cannot select Room or removal operations", async () => {
    const result = await coordinator.prepare({ ...admission, audienceContract: "legacy_personal_grant" },
      { ...command(), change: { kind: "make_private" } });
    expect(result.outcome).toBe("denied");
    expect(events).toEqual([]);
  });

  test("Agent admission cannot select the frozen Human legacy personal contract", async () => {
    const result = await coordinator.prepare({ ...admission, audienceContract: "legacy_personal_grant",
      principal: { ...admission.principal, kind: "agent", agentId: id(60) } }, command());
    expect(result.outcome).toBe("denied");
    expect(events).toEqual([]);
  });

  test("rejects altered command, operation, principal and trusted approval before receipt lookup", async () => {
    const prepared = await prepare();
    const attempts = [
      { admission, command: command(d) },
      { admission, command: command(c, 41) },
      { admission: { ...admission, approvalContext: "changed-policy" }, command: command() },
      { admission: { ...admission, principal: { ...admission.principal, actorId: b } }, command: command() },
      { admission, command: { ...command(), object: { ...object, id: id(31) } } },
    ];
    for (const attempt of attempts) {
      events.length = 0;
      const result = await coordinator.commit(attempt.admission, attempt.command, prepared.previewToken);
      expect(result.outcome).toBe("denied");
      expect(events).toEqual([]);
    }
    expect(receipts.size).toBe(0);
  });

  test("ten-minute expired preview records authenticated stale evidence and cannot publish", async () => {
    const prepared = await prepare();
    clock = 10 * 60 * 1000;
    events.length = 0;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "stale", stateChanged: false });
    expect(events).toEqual(["policy-fence", "operation-lock", "replay", "rollback-or-lost-reply",
      "policy-fence", "operation-lock", "replay", "receipt-write", "commit"]);
    expect(receipts.get(command().operationId)?.outcome).toBe("stale");
    expect(attachments).toHaveLength(1);
  });

  test("invalid token does not look up receipts or disclose historical access", async () => {
    const prepared = await prepare();
    events.length = 0;
    const result = await coordinator.commit(admission, command(), prepared.previewToken + "tampered");
    expect(result.outcome).toBe("denied");
    expect(events).toEqual([]);
  });

  test("expiry while waiting for operation lock cannot begin authority planning", async () => {
    const prepared = await prepare();
    clock = 10 * 60 * 1000 - 1;
    expireAfterOperationLock = true;
    events.length = 0;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "stale", stateChanged: false });
    expect(events).not.toContain("authority");
    expect(receipts.get(command().operationId)?.outcome).toBe("stale");
  });

  test("expiry while waiting for authority locks prevents destination publication", async () => {
    const prepared = await prepare();
    expireAfterAuthority = true;
    events.length = 0;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "stale", stateChanged: false });
    expect(events).not.toContain("room-construction");
    expect(attachments).toHaveLength(1);
  });

  test("expiry during publication rolls back Room, junction and success receipt before recording stale", async () => {
    const prepared = await prepare();
    expireAfterPublication = true;
    events.length = 0;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "stale", stateChanged: false });
    expect(events).toContain("room-construction");
    expect(events).toContain("attachment-write");
    expect(events).toContain("rollback-or-lost-reply");
    expect(namespaceAudiences.size).toBe(0);
    expect(attachments).toHaveLength(1);
    expect(receipts.get(command().operationId)?.outcome).toBe("stale");
  });

  test("operation UUID already bound to another request is denied without a failure write", async () => {
    const prepared = await prepare();
    await coordinator.commit(admission, command(), prepared.previewToken);
    const old = receipts.get(command().operationId)!;
    receipts.set(old.operationId, { ...old, requestDigest: "0".repeat(64) });
    events.length = 0;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "denied", stateChanged: false });
    expect(events).toEqual(["policy-fence", "operation-lock", "replay", "rollback-or-lost-reply"]);
    expect(receipts.size).toBe(1);
  });

  test("publishes Room, attachment and receipt on the same transaction after policy and replay locks", async () => {
    const prepared = await prepare();
    events.length = 0;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(events).toEqual(["policy-fence", "operation-lock", "replay", "authority", "human-targets",
      "room-construction", "attachment-write", "receipt-write", "commit"]);
    expect(receipts.size).toBe(1);
    expect(attachments).toHaveLength(2);
  });

  test("observes a fresh person grant after commit using only explicitly selected Actors", async () => {
    const input = { ...command(), change: { kind: "grant_people" as const, selectedActorIds: [d, c, d] } };
    const prepared = await prepare(input);
    events.length = 0;
    observeCommittedArtifactShares.mockImplementationOnce(async () => { events.push("observer"); });

    const result = await coordinator.commit(admission, input, prepared.previewToken);

    expect(result.outcome).toBe("applied");
    expect(events.at(-1)).toBe("observer");
    expect(events.at(-2)).toBe("commit");
    expect(observeCommittedArtifactShares).toHaveBeenCalledWith({
      operationId: input.operationId,
      requester: { kind: "human", userId: admission.principal.userId, actorId: a },
      artifactId: object.id,
      target: { kind: "people", personActorIds: [c, d] },
    });
  });

  test("observes a fresh Room grant with the authorized selected Room", async () => {
    const input: ContentAccessCommand = {
      ...command(),
      change: { kind: "grant_room", targetRoomId: id(21) },
    };
    const prepared = await prepare(input);

    const result = await coordinator.commit(admission, input, prepared.previewToken);

    expect(result.outcome).toBe("applied");
    expect(observeCommittedArtifactShares).toHaveBeenCalledWith({
      operationId: input.operationId,
      requester: { kind: "human", userId: admission.principal.userId, actorId: a },
      artifactId: object.id,
      target: { kind: "room", roomId: id(21) },
    });
  });

  test("preserves the Agent separately from its authorizing Human Actor", async () => {
    const agentAdmission = {
      ...admission,
      principal: { ...admission.principal, kind: "agent" as const, agentId: id(60) },
    };
    const prepared = await coordinator.prepare(agentAdmission, command());
    if (prepared.outcome !== "prepared") throw new Error("prepare failed");

    expect((await coordinator.commit(agentAdmission, command(), prepared.previewToken)).outcome).toBe("applied");
    expect(observeCommittedArtifactShares).toHaveBeenCalledWith({
      operationId: command().operationId,
      requester: {
        kind: "agent",
        userId: admission.principal.userId,
        actorId: a,
        agentId: id(60),
      },
      artifactId: object.id,
      target: { kind: "people", personActorIds: [c] },
    });
    const effect = observeCommittedArtifactShares.mock.calls[0]?.[0];
    expect(effect?.requester.actorId).toBe(a);
    expect(effect?.requester.kind === "agent" && effect.requester.agentId).toBe(id(60));
    expect(effect?.requester.kind === "agent" && effect.requester.agentId)
      .not.toBe(effect?.requester.actorId);
  });

  test("contains a rejected post-commit observer without changing the successful grant result", async () => {
    const prepared = await prepare();
    observeCommittedArtifactShares.mockImplementationOnce(async () => {
      throw new Error("event feed unavailable");
    });

    const result = await coordinator.commit(admission, command(), prepared.previewToken);

    expect(result).toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(receipts.get(command().operationId)?.outcome).toBe("applied");
    expect(attachments).toHaveLength(2);
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(1);
  });

  test("does not observe already-attached, replayed, removal re-home, or uncertain-recovery effects", async () => {
    const prepared = await prepare();
    await coordinator.commit(admission, command(), prepared.previewToken);
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(1);

    await coordinator.commit(admission, command(), prepared.previewToken);
    const duplicateIntent = command(c, 41);
    const duplicatePrepared = await prepare(duplicateIntent);
    await coordinator.commit(admission, duplicateIntent, duplicatePrepared.previewToken);
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(1);

    const removal: ContentAccessCommand = {
      ...command(c, 42),
      change: { kind: "remove_person", actorId: c },
    };
    const removalPrepared = await prepare(removal);
    expect((await coordinator.commit(admission, removal, removalPrepared.previewToken)).outcome).toBe("applied");
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(1);

    const makePrivate: ContentAccessCommand = {
      ...command(c, 43),
      change: { kind: "make_private" },
    };
    const privatePrepared = await prepare(makePrivate);
    expect((await coordinator.commit(admission, makePrivate, privatePrepared.previewToken)).outcome).toBe("applied");
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(1);

    attachments = [{ namespaceId: id(50), roomId: id(20), kind: "dynamic",
      humanActorIds: [a, b], mutable: true }];
    const uncertain = command(c, 44);
    const uncertainPrepared = await prepare(uncertain);
    loseCommitReply = true;
    expect(await coordinator.commit(admission, uncertain, uncertainPrepared.previewToken)).toMatchObject({
      outcome: "applied", replayed: true,
    });
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(1);
  });

  test("expired replay after revoke returns historical success without reauthorization or resurrection", async () => {
    const prepared = await prepare();
    await coordinator.commit(admission, command(), prepared.previewToken);
    attachments = attachments.slice(0, 1); denied = true; clock = 10 * 60 * 1000;
    events.length = 0;
    const replay = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(replay).toMatchObject({ outcome: "applied", stateChanged: false, originalStateChanged: true, replayed: true });
    expect(events).toEqual(["policy-fence", "operation-lock", "replay", "commit"]);
    expect(attachments).toHaveLength(1);
  });

  test("policy, source context and content drift produce a terminal stale receipt without publication", async () => {
    for (const drift of [() => { policyRevision++; }, () => { sourceRevision += "-changed"; }, () => { objectRevision += "-changed"; }]) {
      const input = command(c, 40 + receipts.size);
      const prepared = await prepare(input);
      drift(); events.length = 0;
      const result = await coordinator.commit(admission, input, prepared.previewToken);
      expect(result).toMatchObject({ outcome: "stale", stateChanged: false });
      expect(events).not.toContain("room-construction");
      expect(events).not.toContain("attachment-write");
    }
    expect(receipts.size).toBe(3);
  });

  test("target Room authority drift is stale even when its human set is unchanged", async () => {
    const input: ContentAccessCommand = { ...command(), change: { kind: "grant_room", targetRoomId: id(21) } };
    const prepared = await prepare(input);
    targetRevision++;
    const result = await coordinator.commit(admission, input, prepared.previewToken);
    expect(result.outcome).toBe("stale");
    expect(attachments).toHaveLength(1);
  });

  test("destructive plans reject new attachment state instead of removing unreviewed access", async () => {
    const input: ContentAccessCommand = { ...command(), change: { kind: "remove_person", actorId: c } };
    const prepared = await prepare(input);
    attachments.push({ namespaceId: id(52), roomId: id(22), kind: "access", humanActorIds: [a, b, c], mutable: true });
    events.length = 0;
    const result = await coordinator.commit(admission, input, prepared.previewToken);
    expect(result.outcome).toBe("stale");
    expect(events).not.toContain("attachment-write");
    expect(attachments).toHaveLength(2);
  });

  test("revoked current authority persists denied evidence which cannot become permission after restoration", async () => {
    const prepared = await prepare();
    denied = true;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result.outcome).toBe("denied");
    expect(receipts.size).toBe(1);
    denied = false;
    events.length = 0;
    const retry = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(retry).toMatchObject({ outcome: "denied", replayed: true, stateChanged: false });
    expect(events).not.toContain("authority");
    expect(attachments).toHaveLength(1);
  });

  test("independent concurrently prepared C and D grants retain separate A+B+C and A+B+D boundaries", async () => {
    const cCommand = command(c, 40), dCommand = command(d, 41);
    const [cp, dp] = await Promise.all([prepare(cCommand), prepare(dCommand)]);
    const outcomes = await Promise.all([
      coordinator.commit(admission, cCommand, cp.previewToken),
      coordinator.commit(admission, dCommand, dp.previewToken),
    ]);
    expect(outcomes.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    expect([...namespaceAudiences.values()]).toEqual([[a, b, c], [a, b, d]]);
    expect(attachments).toHaveLength(3);
  });

  test("failed terminal receipt insert rolls back Room and attachment, records failure, and never retries as a grant", async () => {
    const prepared = await prepare();
    failReceipt = true;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "failed", stateChanged: false });
    expect(namespaceAudiences.size).toBe(0);
    expect(attachments).toHaveLength(1);
    expect(receipts.size).toBe(1);
    const retry = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(retry).toMatchObject({ outcome: "failed", replayed: true, stateChanged: false });
    expect(attachments).toHaveLength(1);
  });

  test("lost commit reply recovers committed success before recording any failure", async () => {
    const prepared = await prepare();
    loseCommitReply = true;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "applied", replayed: true, originalStateChanged: true });
    expect(receipts.size).toBe(1);
    expect(receipts.get(command().operationId)?.outcome).toBe("applied");
  });

  test("failed receipt recovery reports unknown commit state without asserting no change", async () => {
    const prepared = await prepare();
    rejectTransactions = true;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "failed", stateChanged: "unknown", recovery: "retry_receipt" });
  });

  test("Postgres deadlock and serialization aborts preserve exact-operation retry without terminal failure", async () => {
    for (const [index, code] of (["40P01", "40001"] as const).entries()) {
      const input = command(c, 40 + index);
      const prepared = await prepare(input);
      abortNextAuthority = code;
      events.length = 0;
      const failed = await coordinator.commit(admission, input, prepared.previewToken);
      expect(failed).toMatchObject({ outcome: "failed", stateChanged: false, receiptPersisted: false, recovery: "retry_operation" });
      expect(receipts.has(input.operationId)).toBe(false);
      expect(events).not.toContain("receipt-write");
      const retry = await coordinator.commit(admission, input, prepared.previewToken);
      expect(["applied", "already_applied"]).toContain(retry.outcome);
      expect(receipts.has(input.operationId)).toBe(true);
    }
  });

  test("known stale rollback with unavailable receipt persistence asks for fresh preparation", async () => {
    const prepared = await prepare();
    policyRevision++;
    failReceipt = true;
    const result = await coordinator.commit(admission, command(), prepared.previewToken);
    expect(result).toMatchObject({ outcome: "stale", stateChanged: false, receiptPersisted: false, recovery: "prepare_again" });
    expect(receipts.size).toBe(0);
    expect(attachments).toHaveLength(1);
  });

  test("legacy Human execution needs no client token, generates its own operation and returns exact authorized labels", async () => {
    const legacy = { ...admission, audienceContract: "legacy_personal_grant" as const };
    const result = await coordinator.executeLegacyHuman(legacy, command());
    expect("kind" in result && result.kind).toBe("completed");
    if (!("kind" in result) || result.kind !== "completed") throw new Error("missing completion");
    expect(result.receipt.outcome).toBe("applied");
    expect(result.receipt.operationId).not.toBe(command().operationId);
    expect(result.details.destinations).toEqual([{ namespaceId: `access:${[a, c].join(",")}`,
      roomId: `room:access:${[a, c].join(",")}`, minted: true, label: "Shared access" }]);
    expect([...namespaceAudiences.values()]).toEqual([[a, c]]);
    expect(events).toContain("authorized-destination-labels");
    expect(observeCommittedArtifactShares).toHaveBeenCalledWith({
      operationId: result.receipt.operationId,
      requester: { kind: "human", userId: admission.principal.userId, actorId: a },
      artifactId: object.id,
      target: { kind: "people", personActorIds: [c] },
    });
  });

  test("legacy retries no-op when attached but a distinct request after revoke is a new explicit legacy grant", async () => {
    const legacy = { ...admission, audienceContract: "legacy_personal_grant" as const };
    const first = await coordinator.executeLegacyHuman(legacy, command());
    const second = await coordinator.executeLegacyHuman(legacy, command());
    if (!("kind" in first) || first.kind !== "completed" || !("kind" in second) || second.kind !== "completed") {
      throw new Error("missing completion");
    }
    expect(second.receipt.outcome).toBe("already_applied");
    expect(second.receipt.operationId).not.toBe(first.receipt.operationId);
    expect(second.details.destinations[0]?.minted).toBe(false);
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(1);
    attachments = attachments.slice(0, 1);
    const third = await coordinator.executeLegacyHuman(legacy, command());
    if (!("kind" in third) || third.kind !== "completed") throw new Error("missing completion");
    expect(third.receipt.outcome).toBe("applied");
    expect(attachments).toHaveLength(2);
    expect(observeCommittedArtifactShares).toHaveBeenCalledTimes(2);
  });

  test("legacy commit reply recovery reuses captured details only after its exact receipt proves commit", async () => {
    loseCommitReply = true;
    const result = await coordinator.executeLegacyHuman({ ...admission, audienceContract: "legacy_personal_grant" }, command());
    if (!("kind" in result) || result.kind !== "completed") throw new Error("missing completion");
    expect(result.receipt).toMatchObject({ outcome: "applied", replayed: true, stateChanged: false, originalStateChanged: true });
    expect(result.details.destinations[0]).toMatchObject({ minted: true, label: "Shared access" });
    expect(events.filter((event) => event === "room-construction")).toHaveLength(1);
    expect(observeCommittedArtifactShares).not.toHaveBeenCalled();
  });

  test("legacy rolled-back publication returns only failed receipt and cannot fabricate success details", async () => {
    failReceipt = true;
    const result = await coordinator.executeLegacyHuman({ ...admission, audienceContract: "legacy_personal_grant" }, command());
    expect(result).toMatchObject({ kind: "receipt_only", receipt: { outcome: "failed", stateChanged: false } });
    expect("details" in result).toBe(false);
    expect(attachments).toHaveLength(1);
    expect(namespaceAudiences.size).toBe(0);
  });

  test("legacy entry point cannot be invoked by an Agent under either audience contract", async () => {
    for (const audienceContract of ["invoking_room", "legacy_personal_grant"] as const) {
      const result = await coordinator.executeLegacyHuman({ ...admission, audienceContract,
        principal: { ...admission.principal, kind: "agent", agentId: id(60) } }, command());
      expect(result).toMatchObject({ outcome: "denied", stateChanged: false });
    }
    expect(events).toEqual([]);
  });
});
