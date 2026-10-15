import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ImageAssistanceAdmission } from "@nautilo/types";
import {
  createDirectDb,
  ensureDatabase,
  eq,
  ImageAssistanceAdmissionError,
  jobs,
  namespaces,
  pinImageAssistanceAdmissionWith,
  claimImageAssistanceDispatchWith,
  readImageAssistanceAdmissionWith,
  rooms,
  users,
  type DirectDatabase,
  type ImageAssistanceAdmissionIdentity,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const REQUESTED_TEST_INSTANCE = process.env["NAUTILO_IMAGE_ASSISTANCE_ADMISSION_TEST_INSTANCE"]?.trim();
const CONFIGURED_INSTANCE = process.env["NAUTILO_INSTANCE_ID"]?.trim();
const RUN_LIVE_DB = REQUESTED_TEST_INSTANCE !== undefined
  && REQUESTED_TEST_INSTANCE !== ""
  && CONFIGURED_INSTANCE === REQUESTED_TEST_INSTANCE
  && !["default", "(default)"].includes(REQUESTED_TEST_INSTANCE.toLowerCase());
const FIXTURE_PREFIX = "image-assistance-admission-integration";

let firstDb: DirectDatabase;
let secondDb: DirectDatabase;
const jobIds: string[] = [];
const roomIds: string[] = [];
const namespaceIds: string[] = [];
const userIds: string[] = [];

type Fixture = Readonly<{
  identity: ImageAssistanceAdmissionIdentity;
  admission: ImageAssistanceAdmission;
  otherHumanId: string;
}>;

async function createUser(label: string): Promise<string> {
  const [row] = await firstDb.insert(users).values({
    name: `${FIXTURE_PREFIX}:${label}:${randomUUID()}`,
  }).returning({ id: users.id });
  if (!row) throw new Error("Image-assistance admission fixture user was not created");
  userIds.push(row.id);
  return row.id;
}

async function createFixture(label: string): Promise<Fixture> {
  const humanUserId = await createUser(`${label}:requestor`);
  const otherHumanId = await createUser(`${label}:other`);
  const [namespace] = await firstDb.insert(namespaces).values({
    scope: "private",
    label: `${FIXTURE_PREFIX}:${label}:${randomUUID()}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("Image-assistance admission fixture Namespace was not created");
  namespaceIds.push(namespace.id);

  const [room] = await firstDb.insert(rooms).values({
    ownerId: humanUserId,
    type: "private",
    label: `${FIXTURE_PREFIX}:${label}`,
    graphThreadId: `${FIXTURE_PREFIX}:${randomUUID()}`,
    namespaceId: namespace.id,
  }).returning({ id: rooms.id });
  if (!room) throw new Error("Image-assistance admission fixture Room was not created");
  roomIds.push(room.id);

  const [job] = await firstDb.insert(jobs).values({
    ownerId: humanUserId,
    requestorId: humanUserId,
    roomId: room.id,
    type: "foreground",
    status: "running",
    metadata: { unrelated: { retained: true }, fixture: FIXTURE_PREFIX },
  }).returning({ id: jobs.id });
  if (!job) throw new Error("Image-assistance admission fixture Job was not created");
  jobIds.push(job.id);

  const agentId = randomUUID();
  const turnId = randomUUID();
  const inputCommitment = `hmac-sha256:${"a".repeat(64)}`;
  return {
    otherHumanId,
    identity: {
      jobId: job.id,
      humanUserId,
      roomId: room.id,
      agentId,
      turnId,
      entrypoint: "foreground.main",
      mainModelId: "openai:gpt-main",
      inputCommitment,
      parentFundingKind: "server",
    },
    admission: {
      formatVersion: 1,
      jobId: job.id,
      humanUserId,
      roomId: room.id,
      agentId,
      turnId,
      entrypoint: "foreground.main",
      mainModelId: "openai:gpt-main",
      inputCommitment,
      operationId: `image-assistance:${job.id}`,
      modelId: "openai:gpt-image-helper",
      preferenceRevision: 7,
      serverSelection: "openai:gpt-image-helper",
      funding: { kind: "server", providerRoute: "openai" },
      state: "admitted",
    },
  };
}

async function expectAdmissionError(operation: Promise<unknown>): Promise<void> {
  const error = await operation.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ImageAssistanceAdmissionError);
  expect((error as Error).message).toBe("Image assistance admission is unavailable");
}

describe.skipIf(!RUN_LIVE_DB)("image assistance admission persistence with PostgreSQL", () => {
  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    // Separate single-connection pools prove that row locking, rather than one
    // process-local queue, serializes competing admission mutations.
    firstDb = createDirectDb(1);
    secondDb = createDirectDb(1);
  }, 120_000);

  afterAll(async () => {
    if (firstDb) {
      for (const jobId of jobIds) await firstDb.delete(jobs).where(eq(jobs.id, jobId));
      for (const roomId of roomIds) await firstDb.delete(rooms).where(eq(rooms.id, roomId));
      for (const namespaceId of namespaceIds) {
        await firstDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
      }
      for (const userId of userIds) await firstDb.delete(users).where(eq(users.id, userId));
    }
    await Promise.all([firstDb?.end(), secondDb?.end()]);
  });

  test("serializes concurrent pin and claim while preserving unrelated Job metadata", async () => {
    const fixture = await createFixture("concurrency");
    const competingAdmission: ImageAssistanceAdmission = {
      ...fixture.admission,
      modelId: "anthropic:competing-image-helper",
      preferenceRevision: 8,
      serverSelection: null,
      funding: { kind: "server", providerRoute: "anthropic" },
    };

    const pinned = await Promise.all([
      pinImageAssistanceAdmissionWith(firstDb, fixture.identity, fixture.admission),
      pinImageAssistanceAdmissionWith(secondDb, fixture.identity, competingAdmission),
    ]);
    expect(pinned[0]).toEqual(pinned[1]);
    expect([fixture.admission, competingAdmission]).toContainEqual(pinned[0]);

    const [afterPin] = await firstDb.select({ metadata: jobs.metadata })
      .from(jobs).where(eq(jobs.id, fixture.identity.jobId));
    expect(afterPin?.metadata["unrelated"]).toEqual({ retained: true });
    expect(afterPin?.metadata["fixture"]).toBe(FIXTURE_PREFIX);
    expect(afterPin?.metadata["imageAssistanceAdmission"]).toEqual(pinned[0]);

    const claims = await Promise.all([
      claimImageAssistanceDispatchWith(firstDb, fixture.identity, pinned[0]),
      claimImageAssistanceDispatchWith(secondDb, fixture.identity, pinned[0]),
    ]);
    expect([...claims].sort()).toEqual([false, true]);

    const retained = await readImageAssistanceAdmissionWith(firstDb, fixture.identity);
    expect(retained).toEqual({ ...pinned[0], state: "dispatched" });
    const [afterClaim] = await firstDb.select({ metadata: jobs.metadata })
      .from(jobs).where(eq(jobs.id, fixture.identity.jobId));
    expect(afterClaim?.metadata["unrelated"]).toEqual({ retained: true });
    expect(afterClaim?.metadata["fixture"]).toBe(FIXTURE_PREFIX);
  });

  test("rejects incorrect Job authority and leaves the retained admission unchanged", async () => {
    const fixture = await createFixture("authority");
    const retained = await pinImageAssistanceAdmissionWith(
      firstDb,
      fixture.identity,
      fixture.admission,
    );

    const invalidIdentities: ImageAssistanceAdmissionIdentity[] = [
      { ...fixture.identity, jobId: randomUUID() },
      { ...fixture.identity, humanUserId: fixture.otherHumanId },
      { ...fixture.identity, roomId: randomUUID() },
    ];
    for (const identity of invalidIdentities) {
      await expectAdmissionError(readImageAssistanceAdmissionWith(firstDb, identity));
      await expectAdmissionError(
        claimImageAssistanceDispatchWith(firstDb, identity, retained),
      );
    }

    await firstDb.update(jobs).set({ status: "completed" })
      .where(eq(jobs.id, fixture.identity.jobId));
    await expectAdmissionError(readImageAssistanceAdmissionWith(firstDb, fixture.identity));
    await expectAdmissionError(
      claimImageAssistanceDispatchWith(firstDb, fixture.identity, retained),
    );

    const [afterRejections] = await firstDb.select({ metadata: jobs.metadata })
      .from(jobs).where(eq(jobs.id, fixture.identity.jobId));
    expect(afterRejections?.metadata["imageAssistanceAdmission"]).toEqual(retained);
    expect(afterRejections?.metadata["unrelated"]).toEqual({ retained: true });
  });
});
