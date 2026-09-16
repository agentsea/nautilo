import { beforeEach, expect, test } from "bun:test";
import { interruptMediaForRecording, subscribeMediaInterruption } from "./media-playback-interruption";

let stopFirst: (() => void) | undefined;
let stopSecond: (() => void) | undefined;

beforeEach(() => {
  stopFirst?.();
  stopSecond?.();
  stopFirst = undefined;
  stopSecond = undefined;
});

test("interrupts each current device-local playback listener once and removes exact subscriptions", () => {
  let first = 0;
  let second = 0;
  stopFirst = subscribeMediaInterruption(() => { first += 1; });
  stopSecond = subscribeMediaInterruption(() => { second += 1; });

  interruptMediaForRecording();
  expect([first, second]).toEqual([1, 1]);

  stopFirst();
  interruptMediaForRecording();
  expect([first, second]).toEqual([1, 2]);
});

test("one failed native player cannot block the remaining interruptions or recording", () => {
  let paused = false;
  stopFirst = subscribeMediaInterruption(() => { throw new Error("decoder released"); });
  stopSecond = subscribeMediaInterruption(() => { paused = true; });
  expect(() => interruptMediaForRecording()).not.toThrow();
  expect(paused).toBe(true);
});
