import { expect, test } from "bun:test";
import { PersonalPolicyResolver } from "../../src/personal-policy-resolver";
import type { MemoryAccessEnvelope } from "../../src/types";
import { isLocalExecutionReadArgs } from "@nautilo/types";
const envelope = (access: "require_prove_it" | "forbidden") => ({ ownerId: "human-fixture", actorId: "actor-fixture", agentId: "agent-fixture", roomId: "room-fixture", readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: { write_stdin: access } }) as MemoryAccessEnvelope;
test("observation does not ask for Workstation activation but retains actor denial", async () => {
  const resolver = new PersonalPolicyResolver("human-fixture");
  const call = { name: "write_stdin", args: { session_id: "execution-fixture", cursor: 0, yield_time_ms: 1000 }, id: "call-fixture" };
  expect(await resolver.checkToolAccess("actor-fixture", call, envelope("require_prove_it"))).toEqual({ type: "read_only" });
  expect((await resolver.checkToolAccess("actor-fixture", call, envelope("forbidden"))).type).toBe("forbidden");
});
test("read classification rejects all effectful and malformed variations", () => {
  for (const extra of [{ chars: "input" }, { cancel: true }, { command: "unexpected" }, { cursor: -1 }, { cursor: 0.5 }, { max_output_bytes: 3 }, { yield_time_ms: 2147483648 }, { chars: null }, { cancel: "false" }]) {
    expect(isLocalExecutionReadArgs({ session_id: "execution-fixture", ...extra })).toBe(false);
  }
  expect(isLocalExecutionReadArgs({ session_id: "" })).toBe(false);
  expect(isLocalExecutionReadArgs({ session_id: "execution-fixture", chars: "", cancel: false })).toBe(true);
});

test("Human Terminal observation uses ordinary read policy without bypassing actor denial", async () => {
  const resolver = new PersonalPolicyResolver("human-fixture");
  for (const access of ["require_prove_it", "forbidden"] as const) {
    const policy = { ...envelope(access), toolPolicy: { human_terminal: access } };
    const call = { name: "human_terminal", args: { action: "read", cursor: 0 }, id: "call-fixture" };
    expect((await resolver.checkToolAccess("actor-fixture", call, policy)).type).toBe(access === "forbidden" ? "forbidden" : "read_only");
  }
});
