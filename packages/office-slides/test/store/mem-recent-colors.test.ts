import { describe, it, expect } from 'vitest';
import { MemSlidesStore } from '../../src/store/memory';

describe('MemSlidesStore.pushRecentColor', () => {
  it('defaults Meta.recentColors to undefined', () => {
    const store = new MemSlidesStore();
    expect(store.read().meta.recentColors).toBeUndefined();
  });

  it('records a color as the first recent', () => {
    const store = new MemSlidesStore();
    store.batch(() => store.pushRecentColor('#ff0000'));
    expect(store.read().meta.recentColors).toEqual(['#ff0000']);
  });

  it('keeps most-recent-first order and de-dupes', () => {
    const store = new MemSlidesStore();
    store.batch(() => store.pushRecentColor('#ff0000'));
    store.batch(() => store.pushRecentColor('#00ff00'));
    store.batch(() => store.pushRecentColor('#ff0000'));
    expect(store.read().meta.recentColors).toEqual(['#ff0000', '#00ff00']);
  });

  it('preserves more than eight colors in recency order', () => {
    const store = new MemSlidesStore();
    for (let i = 0; i < 12; i++) {
      const hex = `#0000${i.toString(16).padStart(2, '0')}`;
      store.batch(() => store.pushRecentColor(hex));
    }
    expect(store.read().meta.recentColors).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => `#0000${(11 - i).toString(16).padStart(2, '0')}`,
      ),
    );
  });
});
