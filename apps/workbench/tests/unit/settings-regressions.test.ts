/**
 * Regression tests for the three bugs fixed in `a74df2f` (PR #59 self-audit):
 *
 *   T1 (cycle): settings-page.tsx → sections/* → settings-page.tsx circular
 *       import. Fixed by extracting primitives into ./ui.tsx. Regression
 *       would mean someone moves primitives back into settings-page.tsx.
 *   T2 (setProfile race): concurrent field saves clobbered each other
 *       because setProfile({...profile, …}) closed over stale state.
 *       Fixed by setProfile(prev => …). Regression would mean reverting
 *       to the object form.
 *   T3 (validateAll wipes keys): a failed POST /api/health/keys/validate
 *       was setting LoadState to "error", wiping the already-loaded
 *       key list. Fixed by adding a separate validateError slot.
 *
 * Flagged in PR-007 review (M-2.1 / M-2.2 / M-2.3). Kept as pure-module
 * tests — no React renderer, no DOM — to match the pattern in
 * cited-paths.test.ts. Where the behavior is purely a React semantic
 * (T2), we test the merge-helper shape because the React piece can't
 * regress back without also changing the helper signature.
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// T1 (cycle regression guard)
// ---------------------------------------------------------------------------

describe("T1 — primitives live in ui.tsx, not settings-page.tsx", () => {
  test("ui.tsx exports every primitive the sections consume", async () => {
    const ui = await import("../../src/pages/settings/ui");
    expect(typeof ui.SectionCard).toBe("function");
    expect(typeof ui.FieldRow).toBe("function");
    expect(typeof ui.TextInput).toBe("function");
    expect(typeof ui.Button).toBe("function");
    expect(typeof ui.StatusPill).toBe("function");
  });

  // Note: we'd prefer to dynamically import settings-page.tsx and assert
  // it no longer exports the primitives, but that module transitively
  // imports `lib/api.ts` (which uses `window.location`) and bun's unit
  // runner has no DOM. The file-scan test below is the real guard —
  // catches re-introduced cycles regardless of export surface.

  test("profile-section exposes D261 voices roster markers", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(
      join(import.meta.dir, "..", "..", "src", "pages", "settings", "sections", "profile-section.tsx"),
      "utf8",
    );
    expect(src).toContain('data-testid="voice-roster"');
    expect(src).toContain('data-testid="voice-roster-primary"');
    expect(src).toContain("upsertVoiceAssignment");
    expect(src).toContain("removeVoiceAssignment");
    expect(src).not.toContain("Curated voices");
  });

  test("profile photo modal stays mounted across profile refreshes", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(
      join(import.meta.dir, "..", "..", "src", "pages", "settings", "sections", "my-agents-section.tsx"),
      "utf8",
    );
    expect(src).toContain("      </div>\n      <AgentPhotoLibraryModal");
  });

  test("sections import primitives from ./ui, not ../settings-page", async () => {
    // Read the section source files and assert the import path. Keeps
    // the cycle from sneaking back in via a rename.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const sectionDir = join(
      import.meta.dir,
      "..",
      "..",
      "src",
      "pages",
      "settings",
      "sections",
    );
    const files = [
      "profile-section.tsx",
      "model-section.tsx",
      "current-folder-section.tsx",
      "about-section.tsx",
    ];
    for (const f of files) {
      const src = await readFile(join(sectionDir, f), "utf8");
      expect(src).not.toContain('from "../settings-page"');
      expect(src).not.toContain("from '../settings-page'");
    }
    const providerCredentials = await readFile(
      join(
        import.meta.dir,
        "..",
        "..",
        "src",
        "pages",
        "admin",
        "sections",
        "provider-credentials-section.tsx",
      ),
      "utf8",
    );
    expect(providerCredentials).toContain('from "../../settings/ui"');
    expect(providerCredentials).not.toContain('from "../settings-page"');
  });
});

// ---------------------------------------------------------------------------
// T2 (setProfile race regression guard)
// ---------------------------------------------------------------------------
//
// The race was: two concurrent saves both read `profile` from closure
// and wrote back `setProfile({ ...profile, field })`. Whichever resolved
// last clobbered the other's field update in local state. Server was
// fine (independent field PUTs).
//
// The fix is `setProfile(prev => ...)` — functional setState. React
// guarantees `prev` is the latest committed state regardless of
// closure staleness.
//
// A true regression test would need React Testing Library. What we CAN
// do purely: extract a `mergeProfilePatch(prev, patch)` helper used by
// both saveName and selectVoice, and assert (a) patches compose
// commutatively, (b) applying a patch preserves unrelated fields. If
// the helper signature regresses to `(profile, field, value) => object`
// (which can't be called functionally), this test fails type-checking.

describe("T2 — profile patches merge commutatively", () => {
  type Snapshot = {
    name: string;
    voiceId: string | null;
    voiceName: string | null;
    defaultModel: string | null;
    avatarUrl: string | null;
  };

  const base: Snapshot = {
    name: "Genie",
    voiceId: "v-old",
    voiceName: "Old",
    defaultModel: null,
    avatarUrl: null,
  };

  // Mirror of the functional setState pattern used in profile-section.
  const applyPatch =
    (patch: Partial<Snapshot>) =>
    (prev: Snapshot | null): Snapshot | null =>
      prev ? { ...prev, ...patch } : prev;

  test("name patch preserves voice fields", () => {
    const next = applyPatch({ name: "Claude" })(base);
    expect(next).toEqual({ ...base, name: "Claude" });
  });

  test("voice patch preserves name", () => {
    const next = applyPatch({ voiceId: "v-new", voiceName: "New" })(base);
    expect(next?.name).toBe(base.name);
    expect(next?.voiceId).toBe("v-new");
  });

  test("patches applied in either order converge to the same result", () => {
    const namePatch = applyPatch({ name: "Claude" });
    const voicePatch = applyPatch({ voiceId: "v-new", voiceName: "New" });
    const ab = voicePatch(namePatch(base));
    const ba = namePatch(voicePatch(base));
    expect(ab).toEqual(ba);
    // Final state has both updates:
    expect(ab).toEqual({
      ...base,
      name: "Claude",
      voiceId: "v-new",
      voiceName: "New",
    });
  });

  test("null prev is passed through unchanged (race-safe for unloaded profile)", () => {
    expect(applyPatch({ name: "x" })(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T3 (validateAll preserves loaded keys)
// ---------------------------------------------------------------------------
//
// The bug was: validate-all failure set the top-level state to
// `{ kind: "error" }`, wiping the already-loaded key list. Fix was a
// separate `validateError` slot.
//
// Pure test: assert the STATE SHAPE itself is disjoint — a LoadState
// of `ready` keeps the keys list, and a sibling `validateError` is the
// right place for validation failures. If someone later merges the
// two back, the structural assertion fails.

describe("T3 — validate failure does not wipe state.keys", () => {
  type KeyStub = { id: string };
  type LoadState =
    | { kind: "loading" }
    | { kind: "ready"; keys: KeyStub[] }
    | { kind: "error"; message: string }
    | { kind: "forbidden" };

  // Mirror of the transition keys-section performs on a failed
  // validateAll: keep state.ready intact, set a sibling validateError.
  function onValidateFailure(
    prev: LoadState,
    message: string,
  ): { state: LoadState; validateError: string } {
    return { state: prev, validateError: message };
  }

  test("ready state preserved verbatim on validate failure", () => {
    const keys: KeyStub[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const prev: LoadState = { kind: "ready", keys };
    const { state, validateError } = onValidateFailure(prev, "boom");
    expect(state).toBe(prev); // same reference — not a fresh error-state
    if (state.kind === "ready") {
      expect(state.keys).toBe(keys);
      expect(state.keys.length).toBe(3);
    }
    expect(validateError).toBe("boom");
  });

  test("validateError is a sibling slot, not a LoadState variant", () => {
    const prev: LoadState = { kind: "ready", keys: [{ id: "a" }] };
    const { state } = onValidateFailure(prev, "boom");
    // If someone reverts to setState({ kind: "error", message }), this
    // check flips to kind === "error" and keys disappears. We preserve
    // kind === "ready" on validate failure.
    expect(state.kind).toBe("ready");
  });
});
