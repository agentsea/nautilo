import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { browserObservationSettleExpression } from "../../electron/browser-observation-settle";

type SettleResult = { ready: boolean };

function createHarness(html: string, timeoutMs = 3_000) {
  const window = new Window({ url: "https://example.test/search" });
  window.document.write(html);

  const elementPrototype = window.HTMLElement.prototype as unknown as {
    checkVisibility: () => boolean;
    getBoundingClientRect: () => { width: number; height: number };
  };
  elementPrototype.checkVisibility = function checkVisibility() {
    return !(this as unknown as { hidden: boolean }).hidden;
  };
  elementPrototype.getBoundingClientRect = () => ({ width: 100, height: 20 });

  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const cancelledFrames: number[] = [];
  let now = 0;
  const performance = { now: () => now };
  const requestAnimationFrame = (callback: () => void) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number | undefined) => {
    if (id === undefined) return;
    cancelledFrames.push(id);
    frames.delete(id);
  };
  const setTimeout = (callback: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);

  // Execute the exact fixed page expression with deterministic browser clocks.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(
    "document",
    "location",
    "performance",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setTimeout",
    "clearTimeout",
    `return ${browserObservationSettleExpression(timeoutMs)};`,
  ) as (
    document: unknown,
    location: unknown,
    performance: { now: () => number },
    requestAnimationFrame: (callback: () => void) => number,
    cancelAnimationFrame: (id: number | undefined) => void,
    setTimeout: (callback: () => void) => number,
    clearTimeout: (id: number) => void,
  ) => Promise<SettleResult>;

  const result = evaluate(
    window.document,
    window.location,
    performance,
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
  );

  return {
    window,
    result,
    cancelledFrames,
    advanceTime(milliseconds: number) {
      now += milliseconds;
    },
    runFrame() {
      const entry = frames.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error("No animation frame is pending");
      frames.delete(entry[0]);
      entry[1]();
    },
    runTimeout() {
      const entry = timers.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
      if (!entry) throw new Error("No timeout is pending");
      timers.delete(entry[0]);
      entry[1].callback();
    },
    runCadence() {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 50);
      if (!entry) throw new Error("No settle cadence is pending");
      timers.delete(entry[0]);
      entry[1].callback();
    },
    pendingFrames: () => frames.size,
    pendingCadences: () => [...timers.values()].filter(timer => timer.delay === 50).length,
  };
}

describe("browser observation settling", () => {
  it("settles an ordinary page after two matching rendered frames", async () => {
    const harness = createHarness("<main>Ready</main>");

    harness.runFrame();
    harness.runFrame();

    expect(await harness.result).toEqual({ ready: true });
  });

  it("settles through timer cadence when animation frames never fire", async () => {
    const harness = createHarness("<main>Ready</main>");

    harness.runCadence();
    harness.runCadence();

    expect(await harness.result).toEqual({ ready: true });
    expect(harness.pendingFrames()).toBe(0);
    expect(harness.pendingCadences()).toBe(0);
  });

  it("cancels the alternate cadence when an animation frame advances", async () => {
    const harness = createHarness("<main>Ready</main>");

    expect(harness.pendingCadences()).toBe(1);
    harness.runFrame();
    expect(harness.pendingCadences()).toBe(1);
    harness.runFrame();

    expect(await harness.result).toEqual({ ready: true });
    expect(harness.pendingCadences()).toBe(0);
  });

  it("keeps delayed combobox readiness semantics without animation frames", async () => {
    const harness = createHarness('<input role="combobox" aria-expanded="false">');
    const field = harness.window.document.querySelector("input")!;
    field.focus();

    harness.runCadence();
    harness.advanceTime(1200);
    harness.runCadence();
    harness.runCadence();

    expect(await harness.result).toEqual({ ready: true });
  });

  it("waits for delayed visible options in an expanded combobox", async () => {
    const harness = createHarness(`
      <input role="combobox" aria-expanded="true" aria-controls="choices" value="MAD">
      <div id="choices" role="listbox"></div>
    `);
    const field = harness.window.document.querySelector("input")!;
    field.focus();

    harness.runFrame();
    harness.runFrame();
    expect(harness.pendingFrames()).toBe(1);

    harness.window.document.querySelector("#choices")!.innerHTML = '<div role="option">Madrid</div>';
    harness.runFrame();
    harness.runFrame();

    expect(await harness.result).toEqual({ ready: true });
  });

  it("settles an expanded blank combobox after the autocomplete grace", async () => {
    const harness = createHarness(`
      <input role="combobox" aria-expanded="true" aria-controls="choices" value="">
      <div id="choices" role="listbox"></div>
    `);
    harness.window.document.querySelector("input")!.focus();

    harness.runFrame();
    harness.advanceTime(1200);
    harness.runFrame();
    harness.runFrame();

    expect(await harness.result).toEqual({ ready: true });
  });

  it("keeps a collapsed autocomplete open long enough to observe its delayed popup", async () => {
    const harness = createHarness('<input role="combobox" aria-expanded="false">');
    const field = harness.window.document.querySelector("input")!;
    field.focus();

    harness.runFrame();
    harness.runFrame();
    expect(harness.pendingFrames()).toBe(1);

    field.setAttribute("aria-expanded", "true");
    field.setAttribute("aria-controls", "choices");
    field.insertAdjacentHTML(
      "afterend",
      '<div id="choices" role="listbox"><div role="option">Madrid</div></div>',
    );
    harness.runFrame();
    harness.runFrame();

    expect(await harness.result).toEqual({ ready: true });
  });

  it("does not settle while an associated response is aria-busy", async () => {
    const harness = createHarness(`
      <input role="combobox" aria-expanded="true" aria-controls="choices">
      <div id="choices" role="listbox" aria-busy="true"><div role="option">Madrid</div></div>
    `);
    harness.window.document.querySelector("input")!.focus();

    harness.runFrame();
    harness.runFrame();
    expect(harness.pendingFrames()).toBe(1);

    harness.window.document.querySelector("#choices")!.removeAttribute("aria-busy");
    harness.runFrame();
    harness.runFrame();

    expect(await harness.result).toEqual({ ready: true });
  });

  it("accepts associated no-results text as a completed response", async () => {
    const harness = createHarness(`
      <input role="combobox" aria-expanded="true" aria-controls="choices">
      <div id="choices" role="status">No matching flights</div>
    `);
    harness.window.document.querySelector("input")!.focus();

    harness.runFrame();
    harness.advanceTime(1200);
    harness.runFrame();
    harness.runFrame();

    expect(await harness.result).toEqual({ ready: true });
  });

  it("does not treat unrelated preexisting status text as an expanded combobox response", async () => {
    const harness = createHarness(`
      <div role="status">Account connected</div>
      <input role="combobox" aria-expanded="true" value="MAD">
    `);
    harness.window.document.querySelector("input")!.focus();

    harness.runFrame();
    harness.advanceTime(1200);
    harness.runFrame();
    harness.runFrame();
    expect(harness.pendingFrames()).toBe(1);

    harness.runTimeout();
    expect(await harness.result).toEqual({ ready: false });
  });

  it("returns not ready at the deadline and cancels its pending frame", async () => {
    const harness = createHarness(`
      <input role="combobox" aria-expanded="true" aria-controls="choices" value="MAD">
      <div id="choices" role="listbox"></div>
    `);
    harness.window.document.querySelector("input")!.focus();
    harness.runFrame();
    expect(harness.pendingFrames()).toBe(1);

    harness.runTimeout();

    expect(await harness.result).toEqual({ ready: false });
    expect(harness.pendingFrames()).toBe(0);
    expect(harness.cancelledFrames).toHaveLength(1);
  });
});
