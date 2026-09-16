import { describe, test, expect, spyOn, afterEach } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import { createListMyUsersTool } from "../../src/tools/memory/list-my-users";

function env(agentId: string): MemoryAccessEnvelope {
  return {
    ownerId: "00000000-0000-0000-0000-000000000001",
    actorId: "00000000-0000-0000-0000-000000000002",
    agentId,
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  };
}

describe("list_my_users tool (M078)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const s of spies.splice(0)) {
      s.mockRestore();
    }
  });

  test("missing agentId → readable error", async () => {
    const tool = createListMyUsersTool({});
    const out = await tool.invoke({});
    expect(out).toContain("Cannot list users");
  });

  test("empty roster → readable message (not JSON array)", async () => {
    spies.push(spyOn(trust, "listAgentUsers").mockResolvedValue([]));
    const tool = createListMyUsersTool({ memoryAccessEnvelope: env("00000000-0000-0000-0000-000000000099") });
    const out = await tool.invoke({});
    expect(out).toContain("No users found");
    expect(out).not.toContain("[");
  });

  test("serializes rows as JSON with expected fields", async () => {
    spies.push(
      spyOn(trust, "listAgentUsers").mockResolvedValue([
        {
          userId: "00000000-0000-0000-0000-0000000000aa",
          handle: "alice",
          displayName: "Alice",
          role: "owner",
        },
      ]),
    );
    const tool = createListMyUsersTool({
      memoryAccessEnvelope: env("00000000-0000-0000-0000-000000000099"),
    });
    const out = await tool.invoke({});
    expect(out).toContain('"handle": "alice"');
    expect(out).toContain('"displayName": "Alice"');
    expect(out).toContain('"role": "owner"');
  });
});
