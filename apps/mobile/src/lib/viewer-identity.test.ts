import { describe, expect, test } from "bun:test";
import type { WhoamiResponse } from "@nautilo/types";

import { viewerFromWhoami } from "./viewer-identity";

function whoami(features?: WhoamiResponse["features"]): WhoamiResponse {
  return {
    sessionUserId: "user-1",
    sessionActorId: "actor-1",
    userIdentity: "@casey@example.test",
    handle: "casey",
    displayName: "Casey",
    externalId: "external-1",
    instanceId: "instance-1",
    mustChangePassword: false,
    groups: [],
    capabilities: [],
    ...(features ? { features } : {}),
    highestRole: "member",
  };
}

describe("verified viewer feature projection", () => {
  test("retains explicit room-discoverability support", () => {
    expect(viewerFromWhoami(whoami({
      office: { enabled: false },
      roomDiscoverability: true,
    }))).toMatchObject({ roomDiscoverability: true });
  });

  test("does not infer support from an older response with no feature flag", () => {
    expect(viewerFromWhoami(whoami({ office: { enabled: false } })))
      .not.toHaveProperty("roomDiscoverability");
    expect(viewerFromWhoami(whoami()))
      .not.toHaveProperty("roomDiscoverability");
  });
});
