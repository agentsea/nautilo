/**
 * Cross-platform keyboard combo helpers, copied from
 * `packages/sheets/src/view/keymap.ts`. We copy rather than import to
 * avoid a slides → sheets dependency (sheets pulls in antlr4ts and
 * the formula engine — neither is wanted here).
 *
 * If you change either copy, change the other. There is no automated
 * sync.
 */

type KeyEventLike = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>;

/**
 * Returns true when the platform modifier is pressed (Cmd on macOS, Ctrl on
 * Windows/Linux). We intentionally treat either meta or ctrl as "mod" to make
 * shortcut checks platform-agnostic.
 */
export const isModPressed = (event: KeyEventLike): boolean =>
  event.metaKey || event.ctrlKey;

export type KeyRule = {
  match: (e: KeyboardEvent) => boolean;
  run: (e: KeyboardEvent) => Promise<void> | void;
};

/**
 * Runs the first matching keyboard rule and returns whether a rule handled it.
 */
export const runKeyRules = async (
  e: KeyboardEvent,
  rules: Array<KeyRule>,
): Promise<boolean> => {
  for (const rule of rules) {
    if (!rule.match(e)) continue;
    await rule.run(e);
    return true;
  }
  return false;
};
