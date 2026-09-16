/**
 * D154 Phase 2.3 — cold-boot `shellStateOnBoot` seeds `lastOpenAt` so
 * `deriveRuntimeShellState` matches mid-session disconnect semantics.
 *
 * `computeInitialLastOpenAtSeed` is duplicated here (not imported from
 * `lib/desktop.ts`) because other unit tests `mock.module` the desktop
 * barrel; importing the real module would pick up a partial mock.
 * **Keep in sync with** `computeInitialLastOpenAtSeed` in `desktop.ts`.
 *
 * Vacuous-test guard mirrors Phase 1 R1 (`use-auth-viewer-resilience.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveRuntimeShellState } from "../../src/adapters/runtime-shell-state";

/** @see `computeInitialLastOpenAtSeed` in `../../src/lib/desktop.ts` */
function computeInitialLastOpenAtSeed(input: {
  hasEverBeenOpen: boolean;
  shellStateOnBoot: "live" | "disconnected" | "wrong-server" | "no-pairing" | null;
  now: number;
}): number | null {
  const base = input.hasEverBeenOpen ? input.now : null;
  const boot = input.shellStateOnBoot;
  if (boot != null && boot !== "live" && base === null) {
    return input.now;
  }
  return base;
}

const NOW = 1_700_000_000_000;

function shellFromBoot(
  boot: "live" | "disconnected" | "wrong-server" | "no-pairing" | null,
  hasEverBeenOpen: boolean,
  wsState: "open" | "closed",
): ReturnType<typeof deriveRuntimeShellState> {
  const lastOpenAt = computeInitialLastOpenAtSeed({
    hasEverBeenOpen,
    shellStateOnBoot: boot,
    now: NOW,
  });
  return deriveRuntimeShellState({
    authState: "signed-in",
    wsState,
    lastOpenAt,
    reconnectStartedAt: null,
  });
}

describe("computeInitialLastOpenAtSeed + deriveRuntimeShellState (D154 cold boot)", () => {
  test("desktop.ts pins computeInitialLastOpenAtSeed (static slice; catches mock-module drift)", () => {
    const path = join(import.meta.dir, "../../src/lib/desktop.ts");
    const src = readFileSync(path, "utf8");
    const fnStart = src.indexOf("export function computeInitialLastOpenAtSeed");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnSlice = src.slice(fnStart, fnStart + 450);
    expect(fnSlice).toContain('boot !== "live"');
    expect(fnSlice).toContain("base === null");
  });

  test("1 LOAD-BEARING: disconnected boot + no has-ever-open bit → authenticated_disconnected (not connecting)", () => {
    const shell = shellFromBoot("disconnected", false, "closed");
    expect(shell.kind).toBe("authenticated_disconnected");
    if (shell.kind === "authenticated_disconnected") {
      expect(shell.lastOpenAt).toBe(NOW);
    }
  });

  test("2: shellStateOnBoot live + has-ever-open + WS open → authenticated_connected", () => {
    const shell = shellFromBoot("live", true, "open");
    expect(shell.kind).toBe("authenticated_connected");
  });

  test("3: wrong-server boot + no has-ever-open → treated as disconnected surface", () => {
    const shell = shellFromBoot("wrong-server", false, "closed");
    expect(shell.kind).toBe("authenticated_disconnected");
  });

  test("4: no-pairing boot + no has-ever-open → treated as disconnected surface", () => {
    const shell = shellFromBoot("no-pairing", false, "closed");
    expect(shell.kind).toBe("authenticated_disconnected");
  });

  test("5: browser / old desktop (shellStateOnBoot null) + no has-ever-open → unchanged connecting", () => {
    const shell = shellFromBoot(null, false, "closed");
    expect(shell.kind).toBe("authenticated_connecting");
  });

  test("vacuous guard: without D154 tiebreaker seed stays null → connecting (would fail if tiebreaker removed)", () => {
    expect(
      deriveRuntimeShellState({
        authState: "signed-in",
        wsState: "closed",
        lastOpenAt: null,
        reconnectStartedAt: null,
      }).kind,
    ).toBe("authenticated_connecting");

    const seeded = computeInitialLastOpenAtSeed({
      hasEverBeenOpen: false,
      shellStateOnBoot: "disconnected",
      now: NOW,
    });
    expect(seeded).toBe(NOW);
    expect(
      deriveRuntimeShellState({
        authState: "signed-in",
        wsState: "closed",
        lastOpenAt: seeded,
        reconnectStartedAt: null,
      }).kind,
    ).toBe("authenticated_disconnected");
  });
});
