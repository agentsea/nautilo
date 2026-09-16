/**
 * Tests for conversation-shell-copy helpers (ISSUE-D145).
 *
 * Pin every shellState branch for both helpers so a future change
 * cannot silently regress:
 *   1. The "guest copy renders to authenticated-disconnected user"
 *      bug (the original D145 issue).
 *   2. The "tooltip stale during reconnect" regression caught in
 *      PR #173 review (authenticated_resuming was falling through
 *      to "Waiting for server connection" instead of "Server
 *      unreachable …").
 *
 * Hard-reload-during-outage acceptance pin:
 *   When the bearer is in localStorage and the server is unreachable,
 *   `auth.session.state` resolves to "signed-in" from Logto SDK
 *   storage (independent of server liveness), and shell state
 *   resolves to `authenticated_disconnected`. This test pins that
 *   the empty-state copy in that scenario is the honest
 *   "Connection required …" placeholder, NEVER the guest copy.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import {
  pickConversationEmptyCopy,
  pickComposerDisabledTitle,
} from "./conversation-shell-copy";
import {
  getInitialLastOpenAt,
  markHasEverBeenOpen,
  __resetHasEverBeenOpenForTests,
} from "./persisted-ws-history";
import { deriveRuntimeShellState } from "../adapters/runtime-shell-state";
import { installLocalStorageShim } from "../test-helpers/local-storage-shim";

beforeAll(() => {
  installLocalStorageShim();
});

beforeEach(() => {
  __resetHasEverBeenOpenForTests();
});

afterEach(() => {
  __resetHasEverBeenOpenForTests();
});

// ---------- pickConversationEmptyCopy ----------

describe("pickConversationEmptyCopy", () => {
  const GUEST_COPY = "Hey — I'm here when you're ready. What's on your mind?";
  const NEW_CHAT_COPY =
    "New conversation - send a message to get started.";
  const DISCONNECTED_COPY =
    "Connection required to load messages for this room. Reconnecting…";

  test("authenticated_disconnected → 'Connection required …' (the bug-fix branch)", () => {
    const result = pickConversationEmptyCopy({
      shellState: { kind: "authenticated_disconnected", lastOpenAt: 1000 },
      verified: true,
      activeRoomLabel: "stack-2 verif",
    });
    expect(result).toBe(DISCONNECTED_COPY);
  });

  test("authenticated_resuming → 'Connection required …' (PR #173 review fix)", () => {
    const result = pickConversationEmptyCopy({
      shellState: { kind: "authenticated_resuming", reconnectStartedAt: 2000 },
      verified: true,
      activeRoomLabel: "stack-2 verif",
    });
    expect(result).toBe(DISCONNECTED_COPY);
  });

  test("hard-reload-during-outage acceptance pin (PR #173 review-fix-3): persistence-mediated", () => {
    // Models the actual hard-reload-during-outage flow end-to-end —
    // NOT a fake construction with a hand-passed lastOpenAt:
    //
    //   1. A prior session opened the WS → mark persisted
    //      to localStorage. (markHasEverBeenOpen)
    //   2. User hard-reloads. React state initializes from
    //      `getInitialLastOpenAt()`, which reads the persisted bit
    //      and seeds `lastOpenAt = Date.now()`.
    //   3. Server is dead — WS handshake fails → wsState stays
    //      "connecting" (or "closed").
    //   4. Logto SDK reads bearer from its own localStorage and
    //      reports signed-in (independent of server liveness).
    //   5. Whoami can't run → verified=false, activeRoomLabel=null.
    //
    // Pre-fix: derivation returned `authenticated_connecting`
    // because lastOpenAt was null on the fresh React mount. Helper
    // returned guest copy. The original D145 bug.
    //
    // Post-fix: lastOpenAt is non-null (seeded by
    // `getInitialLastOpenAt()`), derivation returns
    // `authenticated_disconnected`, helper returns the honest
    // "Connection required …" placeholder.
    markHasEverBeenOpen();
    const lastOpenAt = getInitialLastOpenAt();
    expect(lastOpenAt).not.toBeNull();

    const shell = deriveRuntimeShellState({
      authState: "signed-in",
      wsState: "connecting",
      lastOpenAt,
      reconnectStartedAt: null,
    });
    expect(shell.kind).toBe("authenticated_disconnected");

    const result = pickConversationEmptyCopy({
      shellState: shell,
      // Whoami can't run because the server is dead — the most
      // adversarial signal set we'd see in production on this path.
      verified: false,
      activeRoomLabel: null,
    });
    expect(result).not.toBe(GUEST_COPY);
    expect(result).toBe(DISCONNECTED_COPY);
  });

  test("delete-the-body sanity for the acceptance pin: removing the persistence call would fail", () => {
    // If `markHasEverBeenOpen()` were never called (or
    // `getInitialLastOpenAt()` always returned null), the chain
    // breaks: derivation produces authenticated_connecting and
    // the helper returns guest copy. This test pins that the
    // pre-fix world is RECOGNIZED as wrong.
    // (We deliberately do NOT call markHasEverBeenOpen here —
    // simulating a true never-connected first paint.)
    const lastOpenAt = getInitialLastOpenAt();
    expect(lastOpenAt).toBeNull();
    const shell = deriveRuntimeShellState({
      authState: "signed-in",
      wsState: "connecting",
      lastOpenAt,
      reconnectStartedAt: null,
    });
    expect(shell.kind).toBe("authenticated_connecting");
    const result = pickConversationEmptyCopy({
      shellState: shell,
      verified: false,
      activeRoomLabel: null,
    });
    // True first-paint-never-connected → guest copy is correct
    // copy for that audience. The asymmetry vs the test above is
    // exactly the design: persistence distinguishes "device with
    // history" from "device without history."
    expect(result).toBe(GUEST_COPY);
  });

  test("authenticated_connected + verified + new-chat → new-conversation copy", () => {
    const result = pickConversationEmptyCopy({
      shellState: { kind: "authenticated_connected" },
      verified: true,
      activeRoomLabel: "New chat 12:30",
    });
    expect(result).toBe(NEW_CHAT_COPY);
  });

  test("authenticated_connected + verified + non-new-chat label → guest copy (existing behavior)", () => {
    const result = pickConversationEmptyCopy({
      shellState: { kind: "authenticated_connected" },
      verified: true,
      activeRoomLabel: "stack-2 verif",
    });
    expect(result).toBe(GUEST_COPY);
  });

  test("unauthenticated → guest copy (the only legitimate audience for this string)", () => {
    const result = pickConversationEmptyCopy({
      shellState: { kind: "unauthenticated" },
      verified: false,
      activeRoomLabel: null,
    });
    expect(result).toBe(GUEST_COPY);
  });

  test("bootstrapping → guest copy (silent first paint; AuthGate covers above this layer)", () => {
    const result = pickConversationEmptyCopy({
      shellState: { kind: "bootstrapping" },
      verified: false,
      activeRoomLabel: null,
    });
    expect(result).toBe(GUEST_COPY);
  });

  test("authenticated_connecting (genuine first-paint never-connected) → guest copy", () => {
    // Post PR #173 review-fix-3, `authenticated_connecting` is reachable
    // ONLY when the device has never observed a successful WS open
    // (the persisted has-ever-been-open bit is unset). On that path
    // the user has no prior frame to show, so the standard empty
    // copy is correct; the "Connection required …" treatment is
    // reserved for devices with a history of successful connects.
    const result = pickConversationEmptyCopy({
      shellState: { kind: "authenticated_connecting" },
      verified: true,
      activeRoomLabel: "general",
    });
    expect(result).toBe(GUEST_COPY);
  });

  test("authenticated_idle (D146-reserved) → guest copy (intentional close, not an outage)", () => {
    const result = pickConversationEmptyCopy({
      shellState: { kind: "authenticated_idle" },
      verified: true,
      activeRoomLabel: "general",
    });
    expect(result).toBe(GUEST_COPY);
  });
});

// ---------- pickComposerDisabledTitle ----------

describe("pickComposerDisabledTitle", () => {
  const SERVER_UNREACHABLE =
    "Server unreachable — your message will send when reconnected.";
  const WAITING = "Waiting for server connection";
  const NO_ROOM = "Select an available room before sending";

  test("not roomReady wins over everything else", () => {
    const result = pickComposerDisabledTitle({
      shellState: { kind: "authenticated_connected" },
      wsOpen: true,
      roomReady: false,
    });
    expect(result).toBe(NO_ROOM);
  });

  test("authenticated_disconnected → 'Server unreachable …'", () => {
    const result = pickComposerDisabledTitle({
      shellState: { kind: "authenticated_disconnected", lastOpenAt: 1 },
      wsOpen: false,
      roomReady: true,
    });
    expect(result).toBe(SERVER_UNREACHABLE);
  });

  test("authenticated_resuming → 'Server unreachable …' (PR #173 review fix)", () => {
    // The bug: pre-fix, this fell through to "Waiting for server
    // connection" because the disconnected-only tooltip branch
    // didn't include the resuming variant. Mid-reconnect the user
    // saw stale copy that suggested a fresh connection attempt
    // rather than continuity from their just-failed turn.
    const result = pickComposerDisabledTitle({
      shellState: { kind: "authenticated_resuming", reconnectStartedAt: 1 },
      wsOpen: false,
      roomReady: true,
    });
    expect(result).toBe(SERVER_UNREACHABLE);
  });

  test("authenticated_connecting + ws not open → 'Waiting for server connection'", () => {
    const result = pickComposerDisabledTitle({
      shellState: { kind: "authenticated_connecting" },
      wsOpen: false,
      roomReady: true,
    });
    expect(result).toBe(WAITING);
  });

  test("ws open + roomReady + connected shell → undefined (composer enabled)", () => {
    const result = pickComposerDisabledTitle({
      shellState: { kind: "authenticated_connected" },
      wsOpen: true,
      roomReady: true,
    });
    expect(result).toBeUndefined();
  });

  test("authenticated_idle (D146 reserved) + ws closed → 'Waiting for server connection'", () => {
    // Idle-by-policy means we *will* reopen the moment the user
    // does something. The "your message will send when reconnected"
    // tooltip is too alarmist for a backgrounded-tab experience.
    // Falls back to the generic copy.
    const result = pickComposerDisabledTitle({
      shellState: { kind: "authenticated_idle" },
      wsOpen: false,
      roomReady: true,
    });
    expect(result).toBe(WAITING);
  });

  test("not roomReady + authenticated_disconnected → roomReady tooltip (NO_ROOM wins)", () => {
    // Defensive: if we ever land in this combo (e.g., outage during
    // a partial room load), the roomReady-false copy is more
    // actionable to the user than the generic disconnected tooltip.
    // Pinning the precedence so a future refactor doesn't flip it.
    const result = pickComposerDisabledTitle({
      shellState: { kind: "authenticated_disconnected", lastOpenAt: 1 },
      wsOpen: false,
      roomReady: false,
    });
    expect(result).toBe(NO_ROOM);
  });
});
