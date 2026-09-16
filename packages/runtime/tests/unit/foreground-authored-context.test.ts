import { describe, expect, test } from "bun:test";

import { loadForegroundAuthoredContext } from
  "../../src/executors/foreground-authored-context";

function dependencies() {
  const calls = { config: 0, skills: 0 };
  return {
    calls,
    deps: {
      getExecutionConfigByAgentId: async () => {
        calls.config += 1;
        return { name: "Genie", defaultModel: "model", soulFile: "secret soul" };
      },
      resolveEnabledBodies: async () => {
        calls.skills += 1;
        return [{
          id: "skill-1",
          name: "authored",
          description: "description",
          body: "secret skill body",
          requiresTools: [],
        }];
      },
    },
  };
}

describe("foreground authored context", () => {
  test("Full loads the existing authored Soul and Skill context", async () => {
    const { calls, deps } = dependencies();
    expect(await loadForegroundAuthoredContext({
      agentId: "agent-1",
      ownerId: "owner-1",
      isGuest: false,
    }, deps)).toMatchObject({
      profile: { name: "Genie", defaultModel: "model", soulFile: "secret soul" },
      soulFile: "secret soul",
      skills: [expect.objectContaining({ body: "secret skill body" })],
    });
    expect(calls).toEqual({ config: 1, skills: 1 });
  });

  test("Shadow preserves ordinary Profile and Skill loading", async () => {
    const { calls, deps } = dependencies();
    expect(await loadForegroundAuthoredContext({
      agentId: "agent-1",
      ownerId: "owner-1",
      isGuest: false,
    }, deps)).toMatchObject({
      soulFile: "secret soul",
      skills: [{ body: "secret skill body" }],
    });
    expect(calls).toEqual({ config: 1, skills: 1 });
  });

  test("guest behavior remains empty without invoking loaders", async () => {
    const { calls, deps } = dependencies();
    expect(await loadForegroundAuthoredContext({
      agentId: "agent-1",
      ownerId: "owner-1",
      isGuest: true,
    }, deps)).toMatchObject({ soulFile: "", skills: [] });
    expect(calls).toEqual({ config: 0, skills: 0 });
  });
});
