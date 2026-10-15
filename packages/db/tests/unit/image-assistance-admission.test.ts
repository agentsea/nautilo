import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ImageAssistanceAdmission } from "@nautilo/types";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  ImageAssistanceAdmissionError,
  claimImageAssistanceDispatchWith,
  pinImageAssistanceAdmissionWith,
  readImageAssistanceAdmissionWith,
  type ImageAssistanceAdmissionIdentity,
} from "../../src/queries/image-assistance-admission";

const identity = (): ImageAssistanceAdmissionIdentity => ({
  jobId: "job-1",
  humanUserId: "human-1",
  roomId: "room-1",
  agentId: "agent-1",
  turnId: "turn-1",
  entrypoint: "foreground.main",
  mainModelId: "openai:gpt-main",
  inputCommitment: `hmac-sha256:${"a".repeat(64)}`,
  parentFundingKind: "server",
});

const admission = (
  patch: Partial<ImageAssistanceAdmission> = {},
): ImageAssistanceAdmission => ({
  formatVersion: 1,
  jobId: "job-1",
  humanUserId: "human-1",
  roomId: "room-1",
  agentId: "agent-1",
  turnId: "turn-1",
  entrypoint: "foreground.main",
  mainModelId: "openai:gpt-main",
  inputCommitment: `hmac-sha256:${"a".repeat(64)}`,
  operationId: "image-assistance:job-1",
  modelId: "openai:gpt-image-helper",
  preferenceRevision: 1,
  serverSelection: "server-default",
  funding: { kind: "server", providerRoute: "openai" },
  state: "admitted",
  ...patch,
});

type Row = {
  id: string;
  requestorId: string;
  roomId: string;
  type: string;
  status: string;
  metadata: Record<string, unknown>;
};

function fakeDb(initialMetadata: Record<string, unknown> = {}) {
  const row: Row = {
    id: "job-1",
    requestorId: "human-1",
    roomId: "room-1",
    type: "foreground",
    status: "running",
    metadata: initialMetadata,
  };
  const selects: Array<{ predicate?: SQL; lock?: string }> = [];
  const updates: Array<{ predicate?: SQL; metadata?: Record<string, unknown> }> = [];
  let transactionTail = Promise.resolve();

  const connection = {
    select: () => {
      const event: { predicate?: SQL; lock?: string } = {};
      selects.push(event);
      const builder = {
        from: () => builder,
        where: (predicate: SQL) => { event.predicate = predicate; return builder; },
        limit: () => builder,
        for: async (lock: string) => { event.lock = lock; return [row]; },
        then: (
          resolve: (rows: Row[]) => unknown,
          reject: (error: unknown) => unknown,
        ) => Promise.resolve([row]).then(resolve, reject),
      };
      return builder;
    },
    update: () => {
      const event: { predicate?: SQL; metadata?: Record<string, unknown> } = {};
      updates.push(event);
      const builder = {
        set: (value: { metadata: Record<string, unknown> }) => {
          event.metadata = value.metadata;
          return builder;
        },
        where: (predicate: SQL) => { event.predicate = predicate; return builder; },
        returning: async () => {
          row.metadata = event.metadata!;
          return [{ id: row.id }];
        },
      };
      return builder;
    },
  };
  const db = {
    ...connection,
    transaction: <T>(callback: (tx: typeof connection) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const predecessor = transactionTail;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      return predecessor.then(() => callback(connection)).finally(release);
    },
  } as unknown as DirectDatabase;
  return { db, row, selects, updates };
}

function compiled(predicate: SQL | undefined) {
  return new PgDialect().sqlToQuery(predicate!);
}

describe("image assistance admission persistence", () => {
  test("reads only a live exact foreground job and returns an absent admission", async () => {
    const fake = fakeDb();
    expect(await readImageAssistanceAdmissionWith(fake.db, identity())).toBeNull();
    const query = compiled(fake.selects[0]!.predicate);
    for (const value of ["job-1", "human-1", "room-1", "foreground", "running"]) {
      expect(query.params).toContain(value);
    }
  });

  test("serializes pin and dispatch so one retained binding and one claim win", async () => {
    const fake = fakeDb({ unrelated: { retained: true } });
    const first = admission();
    const editedPreferences = admission({
      modelId: "openai:gpt-new-preference",
      preferenceRevision: 2,
      serverSelection: "changed-default",
    });
    const [pinnedFirst, pinnedAfterEdit] = await Promise.all([
      pinImageAssistanceAdmissionWith(fake.db, identity(), first),
      pinImageAssistanceAdmissionWith(fake.db, identity(), editedPreferences),
    ]);
    expect(pinnedFirst).toEqual(first);
    expect(pinnedAfterEdit).toEqual(first);
    expect(fake.updates).toHaveLength(1);
    expect(fake.row.metadata["unrelated"]).toEqual({ retained: true });
    expect(fake.selects.slice(0, 2).every((event) => event.lock === "update")).toBe(true);

    const claims = await Promise.all([
      claimImageAssistanceDispatchWith(fake.db, identity(), pinnedFirst),
      claimImageAssistanceDispatchWith(fake.db, identity(), pinnedFirst),
    ]);
    expect(claims).toEqual([true, false]);
    expect(fake.updates).toHaveLength(2);
    expect(fake.row.metadata["imageAssistanceAdmission"]).toMatchObject({
      modelId: first.modelId,
      preferenceRevision: first.preferenceRevision,
      state: "dispatched",
    });
    const updateQuery = compiled(fake.updates[1]!.predicate);
    for (const value of ["job-1", "human-1", "room-1", "foreground", "running"]) {
      expect(updateQuery.params).toContain(value);
    }
  });

  test("fails sanitized on malformed retained state or identity mismatch", async () => {
    const malformed = fakeDb({ imageAssistanceAdmission: { question: "private" } });
    const mismatched = fakeDb({
      imageAssistanceAdmission: admission({ turnId: "another-turn" }),
    });
    const stopped = fakeDb();
    stopped.row.status = "completed";
    for (const action of [
      () => readImageAssistanceAdmissionWith(malformed.db, identity()),
      () => readImageAssistanceAdmissionWith(mismatched.db, identity()),
      () => readImageAssistanceAdmissionWith(stopped.db, identity()),
      () => readImageAssistanceAdmissionWith(
        fakeDb().db,
        { ...identity(), inputCommitment: "invalid" },
      ),
    ]) {
      const error = await action().then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ImageAssistanceAdmissionError);
      expect((error as Error).message).toBe("Image assistance admission is unavailable");
      expect((error as Error).message).not.toContain("private");
    }
  });

  test("rejects parent-source changes and mutated dispatch bindings", async () => {
    const fake = fakeDb();
    const personal = admission({
      funding: {
        kind: "personal",
        providerRoute: "openai",
        credentialId: "10000000-0000-4000-8000-000000000001",
        credentialRevision: 1,
      },
    });
    expect(await pinImageAssistanceAdmissionWith(fake.db, identity(), personal)
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(ImageAssistanceAdmissionError);

    const retained = await pinImageAssistanceAdmissionWith(fake.db, identity(), admission());
    expect(await claimImageAssistanceDispatchWith(fake.db, identity(), {
      ...retained,
      modelId: "openai:gpt-mutated",
    }).then(() => null, (error: unknown) => error)).toBeInstanceOf(ImageAssistanceAdmissionError);
    expect(await claimImageAssistanceDispatchWith(fake.db, identity(), {
      ...retained,
      preferenceRevision: 2,
    }).then(() => null, (error: unknown) => error)).toBeInstanceOf(ImageAssistanceAdmissionError);
    expect(fake.updates).toHaveLength(1);
  });
});
