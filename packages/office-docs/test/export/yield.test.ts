import { afterEach, describe, expect, it, vi } from 'vitest';
import { yieldToPaint, yieldToPaintedFrame } from '../../src/export/yield.js';

const originalMessageChannel = globalThis.MessageChannel;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  vi.useRealTimers();
  globalThis.MessageChannel = originalMessageChannel;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

describe('export yielding', () => {
  it('closes both MessageChannel ports after the macrotask', async () => {
    const close1 = vi.fn();
    const close2 = vi.fn();
    let deliver: (() => void) | undefined;
    class FakeMessageChannel {
      port1 = { onmessage: null as (() => void) | null, close: close1 };
      port2 = {
        postMessage: () => { deliver = () => this.port1.onmessage?.(); },
        close: close2,
      };
    }
    globalThis.MessageChannel = FakeMessageChannel as unknown as typeof MessageChannel;

    const pending = yieldToPaint();
    expect(close1).not.toHaveBeenCalled();
    deliver?.();
    await pending;
    expect(close1).toHaveBeenCalledOnce();
    expect(close2).toHaveBeenCalledOnce();
  });

  it('cancels a pending animation frame when the 100 ms fallback wins', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let lateFrame: (() => void) | undefined;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      lateFrame = () => callback(0);
      return 42;
    });
    globalThis.cancelAnimationFrame = cancel;

    const pending = yieldToPaintedFrame();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(cancel).toHaveBeenCalledWith(42);

    lateFrame?.();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
