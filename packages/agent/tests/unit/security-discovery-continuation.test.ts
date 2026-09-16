import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { unfinishedFileDiscovery } from "../../src/tools/security/discovery-continuation";

function page(id: string, args: Record<string, unknown>, result: Record<string, unknown>) {
  return [new AIMessage({ content: "", tool_calls: [{ id, name: "file", args }] }),
    new ToolMessage({ name: "file", tool_call_id: id, content: JSON.stringify(result) })];
}
function recoveryCall(messages: Parameters<typeof unfinishedFileDiscovery>[0]): Record<string, unknown> {
  const error = unfinishedFileDiscovery(messages);
  expect(error).not.toBeNull();
  return JSON.parse(error!.split("\n")[1]!) as Record<string, unknown>;
}
describe("security discovery obligations", () => {
  test("finalization supplies the two exact unfinished searches instead of making a coordinator guess after handoff", () => {
    const authSearch = { command: "grep", path: "src/server", query: "requireAuth|authenticate|bearer|sessionMiddleware|requireSession", zone: "current" };
    const processSearch = { command: "grep", path: "src/desktop", query: "execFile|spawn|spawnSync|exec\\(|execSync|child_process", zone: "current" };
    const messages = [
      ...page("auth", authSearch, { command: "grep", nextCursor: "auth-page-2" }),
      ...page("process", processSearch, { command: "grep", nextCursor: "process-page-2" }),
      // Unrelated successful searches and a reviewer handoff do not consume
      // either pending page, even when original inputs leave the model window.
      new AIMessage("Report review accepted; coordinator may finalize."),
      ...page("unrelated", { command: "grep", path: "src", query: "whoami" }, { command: "grep", nextCursor: null }),
    ];
    expect(unfinishedFileDiscovery(messages)).toContain("2 file request(s)");
    const first = recoveryCall(messages);
    expect(first).toEqual({ ...authSearch, discoveryCursor: "auth-page-2" });
    messages.push(...page("auth-tail", first, { command: "grep", nextCursor: null }));
    expect(unfinishedFileDiscovery(messages)).toContain("1 file request(s)");
    const second = recoveryCall(messages);
    expect(second).toEqual({ ...processSearch, discoveryCursor: "process-page-2" });
    messages.push(...page("process-tail", second, { command: "grep", nextCursor: null }));
    expect(unfinishedFileDiscovery(messages)).toBeNull();
  });
  test("recovery preserves query filters and caller page size while advancing to the latest cursor", () => {
    const args = { command: "grep", path: "src with spaces", zone: "current", query: 'literal "quote"\\b',
      includeIgnored: true, hidden: "include", caseMode: "sensitive", globs: ["*.ts", "!*.test.ts"], limit: 3 };
    const first = page("a", args, { command: "grep", nextCursor: "cursor_a" });
    const recovery = recoveryCall(first);
    expect(recovery).toEqual({ ...args, discoveryCursor: "cursor_a" });
    expect(recoveryCall([...first, ...page("b", recovery, { command: "grep", nextCursor: "cursor_b" })]))
      .toEqual({ ...args, discoveryCursor: "cursor_b" });
  });
  test("read recovery returns the original requested range and readCursor without widening it", () => {
    const args = { command: "read", zone: "current", path: "long-line.ts", lineRange: { from: 20, to: 20 }, limit: 1 };
    expect(recoveryCall(page("read", args, { command: "read", nextCursor: "remaining-bytes" })))
      .toEqual({ ...args, readCursor: "remaining-bytes" });
  });
  test("narrower search or unrelated exhausted search cannot close the missing page", () => {
    const first = page("a", { command: "grep", path: "src", query: "authorize", limit: 2 }, { command: "grep", nextCursor: "cursor_a", count: 2 });
    expect(unfinishedFileDiscovery([...first, ...page("b", { command: "grep", path: "src/api", query: "authorize" }, { command: "grep", nextCursor: null })])).toContain("unread continuation");
    expect(unfinishedFileDiscovery([...first, ...page("c", { command: "grep", path: "src", query: "authorize", discoveryCursor: "cursor_a" }, { command: "grep", nextCursor: null })])).toBeNull();
  });
  test("a failed continuation remains pending, a successful exact-query restart replaces stale discovery", () => {
    const first = page("a", { command: "glob", pattern: "**/*.ts", path: "src" }, { command: "glob", nextCursor: "cursor_a" });
    expect(unfinishedFileDiscovery([...first, ...page("b", { command: "glob", discoveryCursor: "cursor_a" }, { ok: false, command: "glob", error: "stale", nextCursor: null })])).not.toBeNull();
    expect(unfinishedFileDiscovery([...first, ...page("c", { path: "src", pattern: "**/*.ts", command: "glob" }, { command: "glob", nextCursor: null })])).toBeNull();
  });
  test("a complete requested line window does not require reading every later line", () => {
    expect(unfinishedFileDiscovery(page("read", { command: "read", path: "large.ts", offset: 900, limit: 20 }, { command: "read", nextCursor: null, nextLineOffset: 920 }))).toBeNull();
    const partial = page("fragment", { command: "read", path: "large.ts", offset: 900 }, { command: "read", nextCursor: "read_tail" });
    expect(unfinishedFileDiscovery(partial)).toContain("readCursor");
    expect(unfinishedFileDiscovery([...partial, ...page("tail", { command: "read", path: "large.ts", readCursor: "read_tail" }, { command: "read", nextCursor: null })])).toBeNull();
  });
  test("unpaired tool text cannot create or satisfy an obligation", () => {
    const first = page("a", { command: "list", path: "src" }, { command: "list", nextCursor: "cursor_a" });
    expect(unfinishedFileDiscovery([first[1]!])).toBeNull();
    expect(unfinishedFileDiscovery([...first, page("b", { command: "list", path: "src", discoveryCursor: "cursor_a" }, { command: "list", nextCursor: null })[1]!])).not.toBeNull();
  });
});
