import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../electron/relay.ts", import.meta.url), "utf8");
const begin = source.indexOf("export function getLocalExecutionCustodyScope()");
const end = source.indexOf("function assertRelayCandidateMayBegin", begin);
if (begin < 0 || end < begin) throw new Error("Relay custody projection missing");
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(`
let activeRelaySession = session;
let pendingRelayCandidate = null;
let custodyRetirements = 0;
let relayLifecycleGeneration = 1;
${source.slice(begin, end).replace("export function", "function")}
return { read: getLocalExecutionCustodyScope,
 pending: (value) => { pendingRelayCandidate = value ? {session} : null; },
 retiring: (value) => { custodyRetirements = value; },
 nextGeneration: () => { relayLifecycleGeneration++; },
 detach: () => { activeRelaySession = null; },
 replace: () => { activeRelaySession = { ...session }; } };
`);
type Scope = { roots: readonly string[]; grantIds: readonly string[]; isCurrent: () => boolean };
function fixture() {
  let roots = ["/workspace/old"];
  let grants = ["grant-a"];
  let terminals: { sandboxed: boolean }[] = [];
  const session = { localExecution: { retainedContainedRoots: () => roots, retainedContainedGrantIds: () => grants } };
  const factory = runInNewContext(`(function(session,listSessions) {${javascript}})`) as (session: unknown, list: () => unknown) => {
    read(): Scope | null; pending(value: boolean): void; retiring(count: number): void;
    nextGeneration(): void; detach(): void; replace(): void;
  };
  return { ...factory(session, () => terminals), setRoots: (value: string[]) => { roots = value; },
    setGrants: (value: string[]) => { grants = value; }, setTerminals: (value: typeof terminals) => { terminals = value; } };
}

test("actual Relay projection fences pending candidates, detached cleanup and generation changes", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.pending(true),
    (f: ReturnType<typeof fixture>) => { f.detach(); f.retiring(1); },
    (f: ReturnType<typeof fixture>) => f.nextGeneration(),
    (f: ReturnType<typeof fixture>) => f.replace(),
  ]) {
    const f = fixture(); const captured = f.read();
    expect(captured?.isCurrent()).toBe(true);
    mutate(f);
    expect(captured?.isCurrent()).toBe(false);
  }
  const f = fixture();
  f.pending(true); expect(f.read()).toBeNull();
  f.pending(false); f.detach(); f.retiring(1); expect(f.read()).toBeNull();
  f.retiring(0); expect(f.read()?.roots).toEqual([]);
});

test("legacy contained PTYs deny custody while existing Human shells do not impersonate contained grants", () => {
  const f = fixture(); const captured = f.read();
  f.setTerminals([{ sandboxed: true }]);
  expect(captured?.isCurrent()).toBe(false); expect(f.read()).toBeNull();
  f.setTerminals([{ sandboxed: false }]);
  expect(f.read()?.isCurrent()).toBe(true);
});

test("new retained roots or grant IDs invalidate a previously captured writable view", () => {
  const f = fixture(); const initial = f.read();
  f.setRoots(["/workspace/old", "/workspace/new"]);
  expect(initial?.isCurrent()).toBe(false);
  const next = f.read();
  expect(next?.roots).toEqual(["/workspace/old", "/workspace/new"]);
  f.setGrants(["grant-a", "grant-b"]);
  expect(next?.isCurrent()).toBe(false);
  expect(f.read()?.grantIds).toEqual(["grant-a", "grant-b"]);
});
