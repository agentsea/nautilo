import { expect, test } from "bun:test";
import { SpeechCapacity } from "../../src/realtime/speech-capacity";

test("provider capacity admits waiting owners in order and removes cancellation", async () => {
  const capacity = new SpeechCapacity();
  const signal = new AbortController().signal;
  const first = await capacity.acquire(signal);
  const second = await capacity.acquire(signal);
  const cancelled = new AbortController();
  const skipped = capacity.acquire(cancelled.signal);
  const rejection = skipped.catch(error => error as Error);
  const order: number[] = [];
  const third = capacity.acquire(signal).then(release => { order.push(3); return release; });
  const fourth = capacity.acquire(signal).then(release => { order.push(4); return release; });
  cancelled.abort();
  const error = await rejection;
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Cancelled admission unexpectedly succeeded");
  expect(error.message).toBe("Aborted");
  await Promise.resolve(); expect(order).toEqual([]);
  first(); const releaseThird = await third;
  expect(order).toEqual([3]);
  first(); // Releasing twice must not admit an extra provider request.
  await Promise.resolve(); expect(order).toEqual([3]);
  second(); const releaseFourth = await fourth;
  expect(order).toEqual([3, 4]);
  releaseThird(); releaseFourth();
});

test("the provider's current maximum adjusts capacity without cancelling active requests", async () => {
  const capacity = new SpeechCapacity(); const signal = new AbortController().signal;
  const first = await capacity.acquire(signal); const second = await capacity.acquire(signal);
  let admitted = false;
  const pending = capacity.acquire(signal).then(release => { admitted = true; return release; });
  capacity.observeMaximum("NaN"); capacity.observeMaximum("0");
  await Promise.resolve(); expect(admitted).toBe(false);
  capacity.observeMaximum("3"); const third = await pending;
  expect(admitted).toBe(true);
  capacity.observeMaximum("1");
  let nextAdmitted = false;
  const next = capacity.acquire(signal).then(release => { nextAdmitted = true; return release; });
  first(); second(); await Promise.resolve(); expect(nextAdmitted).toBe(false);
  third(); const last = await next; expect(nextAdmitted).toBe(true); last();
});
