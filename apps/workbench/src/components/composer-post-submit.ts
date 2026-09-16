/**
 * Composer post-submit cleanup — extracted from `conversation.tsx` so
 * the regression below can be pinned without rendering the full
 * Conversation component (which has ~30 React-context dependencies).
 *
 * # Why this is its own module
 *
 * The conversation composer maintains a `hasText` boolean in React
 * state that gates the mic button visibility (`showMic = isSupported
 * && !hasText`). `hasText` is updated ONLY by the textarea's
 * `onChange` handler — but `composerRuntime.reset()` clears the
 * textarea PROGRAMMATICALLY, and **React `onChange` does NOT fire
 * for programmatic value changes**. Without an explicit
 * `setHasText(false)` after the reset, the local boolean stays stuck
 * at `true` forever after the first send, and the mic button never
 * comes back.
 *
 * This bug has regressed multiple times historically (operator quote
 * 2026-05-16: "Regression on mic button from earlier commits that
 * once I type the mic button never comes back"). The trap is subtle
 * enough that anyone refactoring `submitComposer` is liable to drop
 * the manual reset.
 *
 * # Contract pinned by `composer-post-submit.test.ts`
 *
 *   - `sent === true`: ALL three cleanups fire (drafts clear, runtime
 *     reset, local hasText reset). The hasText reset is the
 *     load-bearing one; the test calls it out explicitly.
 *   - `sent === false`: ZERO cleanups fire (composer keeps user's
 *     text + draft so they can fix whatever blocked the send).
 *   - `sent === true` + `activeRoomId === null`: drafts step is
 *     skipped (no room to key against) but the other two still fire.
 *
 * # If you refactor `submitComposer` in `conversation.tsx`
 *
 * Either keep the call to `applyComposerPostSubmit(...)` intact, OR
 * if you inline the cleanup back into `submitComposer`, copy the
 * `setHasText(false)` line AND the comment that explains why it's
 * load-bearing. The regression test in this module's `.test.ts` will
 * still pass because it tests this helper — that's a feature, not a
 * bug, because the test exists to keep the contract documented even
 * if a future refactor drops the helper.
 */

export interface ComposerPostSubmitDeps {
  /**
   * Map of room-id → in-flight draft. Cleared for the active room on
   * successful send so a returning user starts with an empty composer
   * for that room. Optional — when `activeRoomId` is null (no room
   * selected, edge case), the drafts step is skipped.
   */
  readonly draftsByRoom?: Map<string, string>;
  /**
   * The assistant-ui `composerRuntime`'s `reset()` method. Called to
   * clear the textarea's controlled value. **MUST be paired with
   * `resetHasText(false)` below** because this is a programmatic
   * mutation and React `onChange` won't fire.
   */
  readonly resetComposerRuntime: () => void | Promise<void>;
  /**
   * Setter for the local `hasText` React state in conversation.tsx.
   * Reset to `false` post-send because `resetComposerRuntime()`
   * empties the textarea programmatically (see module header).
   */
  readonly resetHasText: (next: false) => void;
}

export interface ComposerPostSubmitInput {
  /** Whether the send actually succeeded (server accepted, etc.). */
  readonly sent: boolean;
  /** Active room id at the time of submit; null when no room selected. */
  readonly activeRoomId: string | null;
}

/**
 * Apply the post-submit composer cleanup. Returns a Promise that
 * resolves once `resetComposerRuntime` settles (the runtime reset
 * may be async).
 *
 * No-op when `sent === false` — the composer keeps the user's text
 * so they can fix whatever blocked the send and retry.
 */
export async function applyComposerPostSubmit(
  input: ComposerPostSubmitInput,
  deps: ComposerPostSubmitDeps,
): Promise<void> {
  if (!input.sent) return;
  if (input.activeRoomId !== null && deps.draftsByRoom !== undefined) {
    deps.draftsByRoom.set(input.activeRoomId, "");
  }
  await Promise.resolve(deps.resetComposerRuntime());
  // LOAD-BEARING — see module header. Do not drop this line in
  // refactors without first removing the `composerRuntime.reset()`
  // call above. The two cleanups must always travel together.
  deps.resetHasText(false);
}
