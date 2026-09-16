import { describe, expect, it } from 'vitest';
import { indentedListLevel } from '../../src/model/list-level.js';
import { createBlock } from '../../src/model/types.js';
import { computeListCounters } from '../../src/view/layout.js';

describe('exact list-level arithmetic', () => {
  it('supports ordinary deep indentation and the last exact integer step', () => {
    expect(indentedListLevel(12)).toBe(13);
    expect(indentedListLevel(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Infinity, NaN, -1, 1.5])('refuses an unrepresentable indent from %s', level => {
    expect(() => indentedListLevel(level)).toThrow(RangeError);
  });
  it('counts sparse levels and resets deeper counters without visiting empty levels', () => {
    const levels = [0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER];
    const blocks = levels.map(listLevel => ({
      ...createBlock('list-item'), listKind: 'ordered' as const, listLevel,
    }));
    expect([...computeListCounters(blocks).values()]).toEqual(['1.', 'a.', 'b.', '2.', 'a.']);
  });
});
