/**
 * Unit tests for `deriveRuntimeShellState` (ISSUE-D145).
 *
 * Pin every branch of the discriminated-union derivation so a future
 * change to the auth/ws state machine cannot silently regress the
 * "authenticated-but-disconnected ≠ unauthenticated" distinction
 * that fixed the guest-screen-on-disconnect bug.
 */

import { describe, test, expect } from "bun:test";
import {
  deriveRuntimeShellState,
  type DeriveShellStateInput,
} from "./runtime-shell-state";

function input(overrides: Partial<DeriveShellStateInput>): DeriveShellStateInput {
  return {
    authState: "signed-in",
    wsState: "open",
    lastOpenAt: null,
    reconnectStartedAt: null,
    ...overrides,
  };
}

describe("deriveRuntimeShellState", () => {
  test("authState=unknown → bootstrapping (regardless of ws)", () => {
    expect(deriveRuntimeShellState(input({ authState: "unknown" }))).toEqual({
      kind: "bootstrapping",
    });
    expect(
      deriveRuntimeShellState(
        input({ authState: "unknown", wsState: "open", lastOpenAt: 1 }),
      ),
    ).toEqual({ kind: "bootstrapping" });
  });

  test("authState=signed-out → unauthenticated", () => {
    expect(
      deriveRuntimeShellState(input({ authState: "signed-out" })),
    ).toEqual({ kind: "unauthenticated" });
  });

  test("authState=signing-in → unauthenticated", () => {
    expect(
      deriveRuntimeShellState(input({ authState: "signing-in" })),
    ).toEqual({ kind: "unauthenticated" });
  });

  test("signed-in + ws open → authenticated_connected", () => {
    expect(
      deriveRuntimeShellState(input({ wsState: "open", lastOpenAt: 1234 })),
    ).toEqual({ kind: "authenticated_connected" });
  });

  test("signed-in + ws closed + no prior open → authenticated_connecting", () => {
    expect(
      deriveRuntimeShellState(
        input({ wsState: "closed", lastOpenAt: null }),
      ),
    ).toEqual({ kind: "authenticated_connecting" });
  });

  test("signed-in + ws connecting + no prior open → authenticated_connecting", () => {
    expect(
      deriveRuntimeShellState(
        input({ wsState: "connecting", lastOpenAt: null }),
      ),
    ).toEqual({ kind: "authenticated_connecting" });
  });

  test("signed-in + ws closed + had prior open + reconnect underway → authenticated_resuming", () => {
    const r = deriveRuntimeShellState(
      input({
        wsState: "connecting",
        lastOpenAt: 1000,
        reconnectStartedAt: 2000,
      }),
    );
    expect(r).toEqual({ kind: "authenticated_resuming", reconnectStartedAt: 2000 });
  });

  test("signed-in + ws closed + had prior open + no reconnect timestamp → authenticated_disconnected", () => {
    const r = deriveRuntimeShellState(
      input({ wsState: "closed", lastOpenAt: 5000, reconnectStartedAt: null }),
    );
    expect(r).toEqual({ kind: "authenticated_disconnected", lastOpenAt: 5000 });
  });

  test("signed-in + ws closed + hidden + had prior open → authenticated_idle (D146)", () => {
    expect(
      deriveRuntimeShellState(
        input({
          wsState: "closed",
          lastOpenAt: 5000,
          reconnectStartedAt: null,
          visibilityHidden: true,
        }),
      ),
    ).toEqual({ kind: "authenticated_idle" });
  });

  test("signed-in + ws closed + visible + had prior open → authenticated_disconnected", () => {
    const r = deriveRuntimeShellState(
      input({
        wsState: "closed",
        lastOpenAt: 5000,
        reconnectStartedAt: null,
        visibilityHidden: false,
      }),
    );
    expect(r).toEqual({ kind: "authenticated_disconnected", lastOpenAt: 5000 });
  });

  test("signed-in + ws closed + hidden + never opened → authenticated_connecting (not idle)", () => {
    expect(
      deriveRuntimeShellState(
        input({
          wsState: "closed",
          lastOpenAt: null,
          visibilityHidden: true,
        }),
      ),
    ).toEqual({ kind: "authenticated_connecting" });
  });

  test("visibility hidden + closed + reconnect marker → authenticated_idle (wins over resuming)", () => {
    const r = deriveRuntimeShellState(
      input({
        wsState: "closed",
        lastOpenAt: 1000,
        reconnectStartedAt: 2000,
        visibilityHidden: true,
      }),
    );
    expect(r).toEqual({ kind: "authenticated_idle" });
  });

  test("without visibilityHidden, matrix inputs never yield authenticated_idle", () => {
    const matrix: DeriveShellStateInput[] = [
      input({ authState: "unknown" }),
      input({ authState: "signed-out" }),
      input({ authState: "signing-in" }),
      input({ wsState: "open", lastOpenAt: 1 }),
      input({ wsState: "closed", lastOpenAt: null }),
      input({ wsState: "connecting", lastOpenAt: null }),
      input({ wsState: "closed", lastOpenAt: 1, reconnectStartedAt: 2 }),
      input({ wsState: "closed", lastOpenAt: 1 }),
      input({ wsState: "authenticating", lastOpenAt: null }),
    ];
    for (const i of matrix) {
      expect(deriveRuntimeShellState(i).kind).not.toBe("authenticated_idle");
    }
  });
});
