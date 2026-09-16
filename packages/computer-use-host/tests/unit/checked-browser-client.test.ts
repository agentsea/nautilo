import { expect, test } from "bun:test";

import type { ComputerUseHostAuthorityScope } from "@nautilo/computer-use-host-protocol";

import { CuaCheckedBrowserClient } from "../../src/checked-browser-client.ts";
import type { CuaCheckedContextPort } from "../../src/native-cua-lifecycle.ts";
import type { ComputerUseContextScope } from "../../src/native-context-registry.ts";

const authority: ComputerUseHostAuthorityScope = { authorityLeaseId: "lease", authorityGeneration: 1 };
const scope = { computerUseContextId: "lease" } as unknown as ComputerUseContextScope;

test("checked browser bridge retains one private session and strips unsupported inner session fields", async () => {
  const calls: Array<Readonly<{ name: string; args: Readonly<Record<string, unknown>> }>> = [];
  const ended: string[] = [];
  const port = {
    generation: "generation",
    startBrowserContext: async () => ({
      ok: true as const,
      generation: "generation",
      sessionId: "provider-private-session",
      health: { permission: "ready" as const, health: "ready" as const },
    }),
    callBrowserTool: async (
      _scope: ComputerUseContextScope,
      sessionId: string,
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => {
      expect(sessionId).toBe("provider-private-session");
      calls.push({ name, args });
      return {
        ok: true as const,
        generation: "generation",
        sessionId,
        result: { content: [], isError: false, structuredContent: { status: "ok" } },
      };
    },
    endContextLease: async (_scope: ComputerUseContextScope, generation: string, sessionId: string) => {
      expect(generation).toBe("generation");
      ended.push(sessionId);
    },
  } as unknown as CuaCheckedContextPort;
  const client = new CuaCheckedBrowserClient({ port, scopeForAuthority: () => scope });
  const session = `nautilo-browser_${"a".repeat(43)}`;
  const callContext = { authority } as const;

  await client.callTool("start_session", { session }, callContext);
  await client.callTool("list_windows", { pid: 42, session }, callContext);
  await client.callTool("bring_to_front", { pid: 42, window_id: 77, session }, callContext);
  await client.callTool("hotkey", {
    pid: 42,
    window_id: 77,
    keys: ["cmd", "t"],
    delivery_mode: "foreground",
    session,
  }, callContext);
  await client.callTool("end_session", { session }, callContext);

  expect(calls).toEqual([
    { name: "list_windows", args: { pid: 42 } },
    { name: "bring_to_front", args: { pid: 42, window_id: 77 } },
    {
      name: "hotkey",
      args: {
        pid: 42,
        window_id: 77,
        keys: ["cmd", "t"],
        delivery_mode: "foreground",
        session: "provider-private-session",
      },
    },
  ]);
  expect(ended).toEqual(["provider-private-session"]);
});
