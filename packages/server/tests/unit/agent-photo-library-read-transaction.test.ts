import { describe, expect, test } from "bun:test";
import { AgentPhotoLibraryReadService } from "../../src/lib/agent-photo-library-read-service";

const authority = {
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  viewerUserId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
};

describe("Agent photo library read transaction policy", () => {
  test("uses a repeatable-read, read-only snapshot for ordinary projections", async () => {
    const configs: unknown[] = [];
    const sentinel = new Error("stop before query");
    const db = {
      transaction: async (_work: unknown, config: unknown) => {
        configs.push(config);
        throw sentinel;
      },
    } as never;
    const service = new AgentPhotoLibraryReadService({ db, blobExists: () => true });
    for (const operation of [
      () => service.current(authority),
      () => service.list(authority, { projection: "recent", limit: 1 }),
      () => service.presets(authority),
      () => service.entry(authority, "44444444-4444-4444-8444-444444444444"),
    ]) {
      await operation().catch((error: unknown) => expect(error).toBe(sentinel));
    }
    expect(configs).toEqual(Array.from({ length: 4 }, () => ({ isolationLevel: "repeatable read", accessMode: "read only" })));
  });
});
