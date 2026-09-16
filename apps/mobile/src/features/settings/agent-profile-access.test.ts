/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { isAgentProfileRequiredError, requireAgentProfile } from "./agent-profile-access";

describe("Mobile Agent profile access", () => {
  test("does not mislabel a public profile projection as an expired session", () => {
    let error: unknown = null;
    try {
      requireAgentProfile({
        viewerRole: "stranger",
        agent: {
          name: "Genie",
          avatar: { kind: "preset", id: "shell" },
          avatarUrl: "/api/profile/avatar",
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      status: 403,
      code: "agent_profile_required",
      message: "This signed-in account does not have an Agent profile on this server.",
    });
    expect(isAgentProfileRequiredError(error)).toBe(true);
    expect(isAgentProfileRequiredError(Object.assign(new Error("expired"), { status: 401 }))).toBe(false);
  });

  test("every Mobile profile read explicitly requests a fresh session bearer", async () => {
    const sources = await Promise.all([
      Bun.file(new URL("./model-default-controller.ts", import.meta.url)).text(),
      Bun.file(new URL("./agent-profile-controller.ts", import.meta.url)).text(),
      Bun.file(new URL("./voice-settings-controller.ts", import.meta.url)).text(),
    ]);

    for (const source of sources) {
      expect(source).toContain("getProfile({ fresh: true })");
    }
  });
});
