import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agents,
  artifacts,
  createDirectDb,
  eq,
  fileRevisions,
  inArray,
  users,
  workspaceDocumentMutationEntries,
  workspaceDocumentMutationEntryIdentities,
  workspaceDocumentMutations,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { handleListRevisions } from "../../src/tools/file/commands/list-revisions";
import {
  handlePinRevision,
  handleUnpinRevision,
} from "../../src/tools/file/commands/pin-revision";
import type { DispatchContext } from "../../src/tools/file/dispatch";
import {
  legacyWorkspaceRestoreFailure,
  resolveWorkspaceHistoryRevisionTarget,
} from "../../src/tools/file/workspace-history";

let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let otherOwnerId: string;
let agentId: string;
let otherAgentId: string;
const artifactIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [owner, otherOwner] = await db
    .insert(users)
    .values([
      { name: "canonical-history", email: `canonical-history-${suffix}@test.local` },
      { name: "canonical-history-other", email: `canonical-history-other-${suffix}@test.local` },
    ])
    .returning({ id: users.id });
  if (!owner || !otherOwner) throw new Error("owner seed failed");
  ownerId = owner.id;
  otherOwnerId = otherOwner.id;
  const [agent, otherAgent] = await db
    .insert(agents)
    .values([
      { handle: `canonical-history-${suffix}` },
      { handle: `canonical-history-other-${suffix}` },
    ])
    .returning({ id: agents.id });
  if (!agent || !otherAgent) throw new Error("agent seed failed");
  agentId = agent.id;
  otherAgentId = otherAgent.id;
});

afterAll(async () => {
  if (!db) return;
  await db.delete(workspaceDocumentMutations).where(
    inArray(workspaceDocumentMutations.ownerId, [ownerId, otherOwnerId]),
  );
  for (const id of artifactIds) {
    await db.delete(artifacts).where(eq(artifacts.id, id));
  }
  await db.delete(fileRevisions).where(
    inArray(fileRevisions.ownerId, [ownerId, otherOwnerId]),
  );
  await db.delete(users).where(inArray(users.id, [ownerId, otherOwnerId]));
  await db.end();
});

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    zoneCtx: { workspaceRoot: "", currentFolder: null },
    ownerId,
    agentId,
    turnId: "history-read-turn",
    ...overrides,
  };
}

async function seedCanonical(input: {
  ownerId?: string;
  agentId?: string;
  logicalPath: string;
  createdAt: Date;
  turnId: string;
  groupPaths?: readonly string[];
}): Promise<readonly string[]> {
  const scopedOwner = input.ownerId ?? ownerId;
  const scopedAgent = input.agentId ?? agentId;
  const paths = input.groupPaths ?? [input.logicalPath];
  const operationId = `history-read:${randomUUID()}`;
  const [mutation] = await db
    .insert(workspaceDocumentMutations)
    .values({
      operationId,
      requestDigest: "a".repeat(64),
      revisionGroupId: `history-group:${randomUUID()}`,
      ownerId: scopedOwner,
      agentId: scopedAgent,
      actorKind: "agent",
      actorId: scopedAgent,
      lane: "file_tool",
      turnId: input.turnId,
      outboxBatchIdempotencyKey: `history-outbox:${randomUUID()}`,
      createdAt: input.createdAt,
    })
    .returning({ id: workspaceDocumentMutations.id });
  if (!mutation) throw new Error("mutation seed failed");

  const revisionIds: string[] = [];
  for (const [sequence, logicalPath] of paths.entries()) {
    const artifactId = randomUUID();
    artifactIds.push(artifactId);
    await db.insert(artifacts).values({
      id: artifactId,
      artifactId: `artifact-${randomUUID()}`,
      path: logicalPath,
      mimeType: "text/plain",
      size: 5,
      storageUri: `file:///canonical-history/${artifactId}`,
      revision: 2,
    });
    const [entry] = await db
      .insert(workspaceDocumentMutationEntries)
      .values({
        mutationId: mutation.id,
        sequence,
        mutationKind: "update",
        artifactInternalId: artifactId,
        beforeLogicalPath: logicalPath,
        afterLogicalPath: logicalPath,
        beforeRevision: 1,
        afterRevision: 2,
        beforeSha256: "b".repeat(64),
        afterSha256: "c".repeat(64),
        beforeSize: 4,
        afterSize: 5,
        beforeStorageUri: `file:///canonical-history/${artifactId}-before`,
        afterStorageUri: `file:///canonical-history/${artifactId}-after`,
        beforeMimeType: "text/plain",
        afterMimeType: "text/plain",
        historyOperation: "str_replace",
        historyEligible: true,
        checkpoint: false,
        createdAt: input.createdAt,
      })
      .returning({ id: workspaceDocumentMutationEntries.id });
    if (!entry) throw new Error("entry seed failed");
    const revisionId = randomUUID();
    revisionIds.push(revisionId);
    await db.insert(workspaceDocumentMutationEntryIdentities).values({
      mutationEntryId: entry.id,
      kind: "revision",
      sequence: 0,
      value: revisionId,
    });
  }
  return revisionIds;
}

async function seedLegacy(createdAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(fileRevisions).values({
    id,
    ownerId,
    agentId,
    turnId: "legacy-turn",
    absolutePath: `/legacy/${id}`,
    workspacePath: "legacy.md",
    workspaceArtifactId: randomUUID(),
    workspacePathBefore: "legacy.md",
    workspacePathAfter: "legacy.md",
    workspaceOperationId: randomUUID(),
    preSha256: "d".repeat(64),
    preSize: 6,
    kind: "blob",
    blobRef: `legacy/${id}`,
    blobSize: 6,
    operation: "write",
    createdAt,
  });
  return id;
}

function parseList(value: string) {
  return JSON.parse(value) as {
    revisions: Array<{
      revisionId: string;
      path: string;
      pinned: boolean;
      historySource: "canonical" | "legacy";
      restoreVerification: "verified" | "unverifiable";
      createdAt: string;
    }>;
    truncated: boolean;
  };
}

describe("D448 canonical Workspace history read cutover", () => {
  test("merges canonical and read-only legacy rows in stable newest-first order", async () => {
    const legacyId = await seedLegacy(new Date("2026-07-24T09:00:00.000Z"));
    const [canonicalId] = await seedCanonical({
      logicalPath: "notes.md",
      createdAt: new Date("2026-07-24T10:00:00.000Z"),
      turnId: "canonical-turn",
    });
    const first = parseList(await handleListRevisions(
      { command: "list_revisions" },
      ctx(),
    ));
    const ids = first.revisions.map((row) => row.revisionId);
    expect(ids.indexOf(canonicalId!)).toBeLessThan(ids.indexOf(legacyId));
    expect(first.revisions.find((row) => row.revisionId === canonicalId))
      .toMatchObject({
        path: "notes.md",
        historySource: "canonical",
        restoreVerification: "verified",
      });
    expect(first.revisions.find((row) => row.revisionId === legacyId))
      .toMatchObject({
        path: "legacy.md",
        historySource: "legacy",
        restoreVerification: "unverifiable",
      });
    const second = parseList(await handleListRevisions(
      { command: "list_revisions" },
      ctx(),
    ));
    expect(second.revisions.map((row) => row.revisionId)).toEqual(
      first.revisions.map((row) => row.revisionId),
    );
  });

  test("logical path filters canonical history only with explicit Workspace zone", async () => {
    const [revisionId] = await seedCanonical({
      logicalPath: "filtered/path.md",
      createdAt: new Date("2026-07-24T11:00:00.000Z"),
      turnId: "filtered-turn",
    });
    const result = parseList(await handleListRevisions({
      command: "list_revisions",
      zone: "workspace",
      path: "filtered/path.md",
    }, ctx()));
    expect(result.revisions.map((row) => row.revisionId)).toContain(revisionId!);
    expect(result.revisions.every((row) => row.path === "filtered/path.md")).toBe(true);
  });

  test("owner and agent scope make foreign and missing ids indistinguishable", async () => {
    const [foreignAgentId] = await seedCanonical({
      agentId: otherAgentId,
      logicalPath: "foreign-agent.md",
      createdAt: new Date("2026-07-24T12:00:00.000Z"),
      turnId: "foreign-agent-turn",
    });
    const [foreignOwnerId] = await seedCanonical({
      ownerId: otherOwnerId,
      logicalPath: "foreign-owner.md",
      createdAt: new Date("2026-07-24T12:01:00.000Z"),
      turnId: "foreign-owner-turn",
    });
    for (const revisionId of [foreignAgentId!, foreignOwnerId!, randomUUID()]) {
      const response = JSON.parse(await handlePinRevision({
        command: "pin_revision",
        revisionId,
      }, ctx())) as Record<string, unknown>;
      expect(response).toMatchObject({ error: "revision_not_found", revisionId });
      expect(Object.keys(response).sort()).toEqual(["error", "hint", "revisionId"]);
    }
  });

  test("pin and unpin update the complete canonical mutation group", async () => {
    const ids = await seedCanonical({
      logicalPath: "group-a.md",
      groupPaths: ["group-a.md", "group-b.md"],
      createdAt: new Date("2026-07-24T13:00:00.000Z"),
      turnId: "group-turn",
    });
    expect(JSON.parse(await handlePinRevision({
      command: "pin_revision",
      revisionId: ids[0]!,
    }, ctx()))).toEqual({ ok: true, revisionId: ids[0], pinned: true });
    const pinned = parseList(await handleListRevisions({
      command: "list_revisions",
      includePinnedOnly: true,
    }, ctx()));
    expect(ids.every((id) =>
      pinned.revisions.some((row) => row.revisionId === id && row.pinned),
    )).toBe(true);
    expect(JSON.parse(await handleUnpinRevision({
      command: "unpin_revision",
      revisionId: ids[1]!,
    }, ctx()))).toEqual({ ok: true, revisionId: ids[1], pinned: false });
  });

  test("fresh DB connection observes the same stable canonical revision id", async () => {
    const [revisionId] = await seedCanonical({
      logicalPath: "restart.md",
      createdAt: new Date("2026-07-24T14:00:00.000Z"),
      turnId: "restart-turn",
    });
    const restarted = createDirectDb(1);
    const [persisted] = await restarted
      .select({ value: workspaceDocumentMutationEntryIdentities.value })
      .from(workspaceDocumentMutationEntryIdentities)
      .where(eq(workspaceDocumentMutationEntryIdentities.value, revisionId!));
    await restarted.end();
    expect(persisted?.value).toBe(revisionId);
    const listed = parseList(await handleListRevisions({
      command: "list_revisions",
      zone: "workspace",
      path: "restart.md",
    }, ctx()));
    expect(listed.revisions.map((row) => row.revisionId)).toContain(revisionId!);
  });

  test("legacy ids remain enumerable but pin and restore are fail-closed", async () => {
    const revisionId = await seedLegacy(new Date("2026-07-24T15:00:00.000Z"));
    const target = await resolveWorkspaceHistoryRevisionTarget({
      ownerId,
      agentId,
      revisionId,
    });
    expect(target).toMatchObject({
      kind: "legacy",
      restoreVerification: "unverifiable",
    });
    expect(JSON.parse(await handlePinRevision({
      command: "pin_revision",
      revisionId,
    }, ctx()))).toMatchObject({
      error: "legacy_history_read_only",
      revisionId,
    });
    expect(JSON.parse(legacyWorkspaceRestoreFailure(revisionId))).toMatchObject({
      error: "legacy_history_unverifiable",
      revisionId,
    });
    const [row] = await db.select({ pinned: fileRevisions.pinned })
      .from(fileRevisions)
      .where(eq(fileRevisions.id, revisionId));
    expect(row?.pinned).toBe(false);
  });
});
