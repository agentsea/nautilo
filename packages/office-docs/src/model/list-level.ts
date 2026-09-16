/** The next editable level must remain an exact integer in the JS model. */
export function indentedListLevel(level = 0): number {
  const next = level + 1;
  if (level < 0 || !Number.isSafeInteger(level) || !Number.isSafeInteger(next)) {
    throw new RangeError('Cannot indent this list further: its level cannot be represented exactly. Reduce its indentation first.');
  }
  return next;
}
