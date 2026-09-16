import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { NautiloApiClient } from "../../src/client";

test("public reference lookup is authenticated, room scoped, and returns null only for 404", async () => {
  let status = 200;
  const calls: { url: string; authorization: string | null }[] = [];
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl: async (target, options) => {
    calls.push({ url: target instanceof Request ? target.url : String(target), authorization: new Headers(options?.headers).get("Authorization") });
    return new Response(JSON.stringify(status === 200 ? { artifactId: "public-id", id: "row" } : { error: "Denied" }), { status, headers: { "Content-Type": "application/json" } });
  } });
  client.setToken("test-session");
  expect(await client.getWorkspaceArtifactByPublicId("public-id", { roomId: "room/one" })).toMatchObject({ artifactId: "public-id" });
  expect(calls).toEqual([{ url: "https://nautilo.test/api/workspace/artifacts/by-public-id/public-id?roomId=room%2Fone", authorization: "Bearer test-session" }]);
  status = 404; expect(await client.getWorkspaceArtifactByPublicId("missing")).toBeNull();
  status = 403; await rejects(client.getWorkspaceArtifactByPublicId("denied"), { status: 403 });
});
