import { describe, expect, test } from "bun:test";
import {
  CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE,
  CLIENT_ACTION_BINDING_TTL_MS,
  CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET,
} from "@nautilo/types";
import { ClientActionBindingRegistry } from "../../src/realtime/client-action-binding-registry";

function sessionId(suffix: string): string {
  return `${"A".repeat(21)}${suffix}`;
}

function socket() {
  let close: (() => void) | undefined;
  return {
    on(_event: "close", handler: () => void) { close = handler; },
    close() { close?.(); },
  };
}

function live(registry: ClientActionBindingRegistry, actorId = "actor-a", surface: unknown = undefined) {
  const s = socket();
  const id = sessionId(actorId.endsWith("b") ? "B" : "A");
  expect(registry.registerLiveSession({ socket: s, clientActionSessionId: id, actorId, initiatingClientSurface: surface })).toBe(true);
  return { s, id };
}

describe("client action binding registry", () => {
  test("speech routing survives one-shot guidance but expires with the original binding", () => {
    let now = 1000;
    const registry = new ClientActionBindingRegistry(() => now);
    const { s, id } = live(registry);
    const handle = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    registry.bind(handle, "turn-a");
    expect(registry.inspectTurnSocket("turn-a")).toBe(s);
    expect(registry.consumeOnce("turn-a")?.socket).toBe(s);
    expect(registry.consumeOnce("turn-a")).toBeNull();
    expect(registry.inspectTurnSocket("turn-a")).toBe(s);
    now += CLIENT_ACTION_BINDING_TTL_MS;
    expect(registry.inspectTurnSocket("turn-a")).toBeNull();
  });

  test("consumed speech routes do not survive disconnect or session replacement", () => {
    const registry = new ClientActionBindingRegistry();
    const { s, id } = live(registry);
    const handle = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    registry.bind(handle, "turn-a"); registry.consumeOnce("turn-a");
    s.close();
    expect(registry.inspectTurnSocket("turn-a")).toBeNull();
    live(registry);
    expect(registry.inspectTurnSocket("turn-a")).toBeNull();
    const next = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    registry.bind(next, "turn-b"); registry.consumeOnce("turn-b");
    live(registry);
    expect(registry.inspectTurnSocket("turn-b")).toBeNull();
  });
  test("binds immutably once and consumes exactly once", () => {
    const registry = new ClientActionBindingRegistry();
    const { id } = live(registry);
    const handle = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" });
    expect(handle).toBeString();
    expect(registry.bind(handle!, "turn-a")).toBe(true);
    expect(registry.bind(handle!, "turn-b")).toBe(false);
    expect(registry.consumeOnce("turn-a")).toMatchObject({ initiatingClientSurface: "unknown" });
    expect(registry.consumeOnce("turn-a")).toBeNull();
    expect(registry.size()).toBe(0);
  });

  test("rejects a sibling session and actor mismatch without rejecting other work", () => {
    const registry = new ClientActionBindingRegistry();
    const first = live(registry, "actor-a");
    const second = live(registry, "actor-b");
    expect(registry.reserve({ clientActionSessionId: first.id, actorId: "actor-b" })).toBeNull();
    expect(registry.reserve({ clientActionSessionId: second.id, actorId: "actor-a" })).toBeNull();
    expect(registry.reserve({ clientActionSessionId: first.id, actorId: "actor-a" })).toBeString();
  });

  test("disconnect deletes reservations and bindings", () => {
    const deleted: string[] = [];
    const registry = new ClientActionBindingRegistry(Date.now, (id) => deleted.push(id));
    const { s, id } = live(registry);
    const handle = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    registry.bind(handle, "turn-a");
    s.close();
    expect(registry.consumeOnce("turn-a")).toBeNull();
    expect(registry.size()).toBe(0);
    expect(deleted).toEqual([id]);
  });

  test("prunes expiry, rolling admission, and derived live maximum", () => {
    let now = 1_000_000;
    const registry = new ClientActionBindingRegistry(() => now);
    const { id } = live(registry);
    for (let batch = 0; batch < CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET / CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE; batch++) {
      for (let i = 0; i < CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE; i++) {
        expect(registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })).toBeString();
      }
      if (batch === 0) expect(registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })).toBeNull();
      if (batch + 1 < CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET / CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE) {
        now += 60_001;
      }
    }
    expect(registry.size()).toBe(CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET);
    expect(registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })).toBeNull();
    now += CLIENT_ACTION_BINDING_TTL_MS + 1;
    expect(registry.size()).toBe(0);
  });

  test("rejects malformed or missing sessions", () => {
    const registry = new ClientActionBindingRegistry();
    live(registry);
    expect(registry.reserve({ clientActionSessionId: "not-a-session", actorId: "actor-a" })).toBeNull();
    expect(registry.reserve({ clientActionSessionId: null, actorId: "actor-a" })).toBeNull();
  });

  test("direct candidate binds only after a successful canonical human append", () => {
    const registry = new ClientActionBindingRegistry();
    const { id } = live(registry);
    const handle = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    const candidate = registry.createForegroundTurnCandidate(handle);
    candidate.onMainTurn("turn-a");
    expect(registry.consumeOnce("turn-a")).toBeNull();
    registry.onHumanPersistence("turn-a", true);
    expect(registry.consumeOnce("turn-a")).not.toBeNull();
  });

  test("candidates carry a session-local opaque coalescing token that rotates on reconnect", () => {
    const registry = new ClientActionBindingRegistry();
    const first = live(registry);
    const firstHandle = registry.reserve({ clientActionSessionId: first.id, actorId: "actor-a" })!;
    const siblingHandle = registry.reserve({ clientActionSessionId: first.id, actorId: "actor-a" })!;
    const firstToken = registry.createForegroundTurnCandidate(firstHandle).coalescingContext?.clientSessionToken;
    expect(registry.createForegroundTurnCandidate(siblingHandle).coalescingContext?.clientSessionToken).toBe(firstToken);
    expect(registry.createForegroundTurnCandidate(firstHandle).coalescingContext?.initiatingClientSurface).toBe("unknown");

    first.s.close();
    const reconnected = live(registry);
    const nextHandle = registry.reserve({ clientActionSessionId: reconnected.id, actorId: "actor-a" })!;
    expect(registry.createForegroundTurnCandidate(nextHandle).coalescingContext?.clientSessionToken).not.toBe(firstToken);
  });

  test("retains only the closed surface beside each live session", () => {
    const registry = new ClientActionBindingRegistry();
    const web = live(registry, "actor-a", "mobile.web");
    const webHandle = registry.reserve({ clientActionSessionId: web.id, actorId: "actor-a" })!;
    expect(registry.coalescingContextForHandle(webHandle)?.initiatingClientSurface).toBe("mobile.web");

    const unknown = live(registry, "actor-b", "forged.surface");
    const unknownHandle = registry.reserve({ clientActionSessionId: unknown.id, actorId: "actor-b" })!;
    expect(registry.coalescingContextForHandle(unknownHandle)?.initiatingClientSurface).toBe("unknown");
  });

  test("inspects exact live Browser eligibility without consuming an admission", () => {
    const registry = new ClientActionBindingRegistry();
    const browser = live(registry, "actor-a", "workbench.browser");

    expect(registry.inspectLiveSession({
      clientActionSessionId: browser.id,
      actorId: "actor-a",
    })).toEqual({ initiatingClientSurface: "workbench.browser" });
    expect(registry.inspectLiveSession({
      clientActionSessionId: browser.id,
      actorId: "actor-b",
    })).toBeNull();
    expect(registry.size()).toBe(0);

    expect(registry.reserve({
      clientActionSessionId: browser.id,
      actorId: "actor-a",
    })).toBeString();
  });

  test("failed append, fork, and coalesced continuation delete the candidate", () => {
    const registry = new ClientActionBindingRegistry();
    const { id } = live(registry);
    const failed = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    const failedCandidate = registry.createForegroundTurnCandidate(failed);
    failedCandidate.onMainTurn("turn-failed");
    registry.onHumanPersistence("turn-failed", false);
    expect(registry.size()).toBe(0);

    const coalesced = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    registry.createForegroundTurnCandidate(coalesced).onIneligible();
    expect(registry.size()).toBe(0);
  });

  test("group burst binds one persisted turn but cancels every mixed covered turn", () => {
    const registry = new ClientActionBindingRegistry();
    const { id } = live(registry);
    const one = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    registry.holdGroupTurn(one, "turn-one");
    registry.resolveGroupTurns(["turn-one"]);
    expect(registry.consumeOnce("turn-one")).not.toBeNull();

    const a = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    const b = registry.reserve({ clientActionSessionId: id, actorId: "actor-a" })!;
    registry.holdGroupTurn(a, "turn-a");
    registry.holdGroupTurn(b, "turn-b");
    registry.resolveGroupTurns(["turn-a", "turn-b"]);
    expect(registry.consumeOnce("turn-a")).toBeNull();
    expect(registry.consumeOnce("turn-b")).toBeNull();
  });
});
