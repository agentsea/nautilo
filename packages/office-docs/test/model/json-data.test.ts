import { describe, expect, it } from 'vitest';
import { cloneJsonData, stringifyJsonData } from '../../src/model/json-data.js';

describe('document JSON data', () => {
  it('matches native JSON bytes for plain model values and optional fields', () => {
    const shared = { text: 'quote " slash \\ newline\n tab\t lone \ud800', n: -0 };
    const value = {
      omitted: undefined, infinity: Infinity, nan: NaN,
      entries: [shared, shared, undefined, ...new Array<unknown>(1), null, true, false, 1.5],
      'line\nkey': { '2': 2, '1': 1, ordinary: 'text' },
    };
    expect(stringifyJsonData(value)).toBe(JSON.stringify(value));
    expect(cloneJsonData(value)).toEqual(JSON.parse(JSON.stringify(value)));
    expect(cloneJsonData(value).entries[0]).not.toBe(shared);
  });

  it('preserves a changed 20000-level document subtree through serialization and cloning', () => {
    let root: Record<string, unknown> = { text: 'leaf' };
    const leaf = root;
    for (let i = 0; i < 20000; i++) root = { child: root };
    leaf.text = 'edited';
    let copy = cloneJsonData(root);
    for (let i = 0; i < 20000; i++) copy = copy.child as Record<string, unknown>;
    expect(copy.text).toBe('edited');
  });

  it('rejects cycles and bigint instead of silently dropping unsupported data', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => stringifyJsonData(value)).toThrow('Circular');
    expect(() => stringifyJsonData({ number: 1n })).toThrow(TypeError);
  });
});
