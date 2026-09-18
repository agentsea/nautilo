import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SendMessageResponse } from "@nautilo/types";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("chat M074 coalesce HTTP shape (stub)", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({
      suiteName: "rmod074",
      createAppExtras: {
        chatRoutesDeps: {
          createForegroundJob: async () => ({
            id: "22222222-2222-4222-8222-222222222222",
            virtualJobId: "22222222-2222-4222-8222-222222222222",
          }),
        },
      },
    });
    bearer = await fx.mintOwnerBearer();
  });

  afterAll(async () => {
    await fx?.cleanup();
  });

  test("POST /api/chat returns the virtual job id + coalesced true (stub)", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/chat",
      bearer,
      payload: { message: "hello", laneKey: "lane:m074-stub" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as SendMessageResponse;
    expect(body.jobId).toBe("22222222-2222-4222-8222-222222222222");
    expect(body.coalesced).toBe(true);
  });
});
