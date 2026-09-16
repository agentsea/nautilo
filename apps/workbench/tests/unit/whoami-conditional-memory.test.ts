import { describe, expect, test } from "bun:test";
import type {
  ConditionalReadResult,
} from "@nautilo/api-client/browser";
import type { WhoamiResponse } from "@nautilo/types";
import {
  readWhoamiWithMemoryCache,
  type WhoamiMemoryCache,
} from "../../src/hooks/use-auth";

function whoami(
  sessionUserId: string,
  instanceId = "instance-1",
): WhoamiResponse {
  return {
    sessionUserId,
    sessionActorId: `actor-${sessionUserId}`,
    userIdentity: `id:${sessionUserId}`,
    handle: sessionUserId,
    displayName: sessionUserId,
    externalId: `sub-${sessionUserId}`,
    instanceId,
    mustChangePassword: false,
    groups: [],
    capabilities: [],
    features: { office: { enabled: false } },
    highestRole: "member",
  };
}

describe("useViewerAuth whoami conditional memory", () => {
  test("sends the current ETag and reuses the typed body on 304", async () => {
    const body = whoami("user-1");
    const cache: WhoamiMemoryCache = { body, etag: 'W/"who-v1"' };
    const seen: Array<{ ifNoneMatch?: string } | undefined> = [];

    const result = await readWhoamiWithMemoryCache(cache, async (options) => {
      seen.push(options);
      return { status: 304, etag: 'W/"who-v1"' };
    });

    expect(seen).toEqual([{ ifNoneMatch: 'W/"who-v1"' }]);
    expect(result).toBe(body);
    expect(cache).toEqual({ body, etag: 'W/"who-v1"' });
  });

  test("304 without a body retries immediately without a validator", async () => {
    const body = whoami("user-1");
    const cache: WhoamiMemoryCache = { body: null, etag: 'W/"orphan"' };
    const seen: Array<{ ifNoneMatch?: string } | undefined> = [];
    const responses: ConditionalReadResult<WhoamiResponse>[] = [
      { status: 304, etag: 'W/"orphan"' },
      { status: 200, body, etag: 'W/"who-v2"' },
    ];

    const result = await readWhoamiWithMemoryCache(cache, async (options) => {
      seen.push(options);
      return responses.shift()!;
    });

    expect(seen).toEqual([
      { ifNoneMatch: 'W/"orphan"' },
      undefined,
    ]);
    expect(result).toBe(body);
    expect(cache).toEqual({ body, etag: 'W/"who-v2"' });
  });

  test("a user or instance switch replaces both prior body and validator", async () => {
    const oldBody = whoami("user-1", "instance-1");
    const nextBody = whoami("user-2", "instance-2");
    const cache: WhoamiMemoryCache = { body: oldBody, etag: 'W/"old-viewer"' };

    await readWhoamiWithMemoryCache(cache, async () => ({
      status: 200,
      body: nextBody,
      etag: 'W/"new-viewer"',
    }));

    expect(cache.body).toBe(nextBody);
    expect(cache.etag).toBe('W/"new-viewer"');
    expect(cache.body).not.toBe(oldBody);
  });
});
