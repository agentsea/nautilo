import { expect, test } from "bun:test";
import { SpeechCapacity, SpeechCapacityPool } from "../../src/realtime/speech-capacity";

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

test("provider limits remain isolated to the exact paid account", async () => {
  const pool = new SpeechCapacityPool();
  const signal = new AbortController().signal;
  const personal = pool.forAccount("elevenlabs:personal-a");
  const server = pool.forAccount("elevenlabs:server");
  personal.observeMaximum("1");
  server.observeMaximum("2");

  const releasePersonal = await personal.acquire(signal);
  let secondPersonalAdmitted = false;
  const secondPersonal = personal.acquire(signal).then(release => {
    secondPersonalAdmitted = true;
    return release;
  });
  const releaseServerA = await server.acquire(signal);
  const releaseServerB = await server.acquire(signal);

  await Promise.resolve();
  expect(secondPersonalAdmitted).toBe(false);
  releaseServerA();
  releaseServerB();
  await Promise.resolve();
  expect(secondPersonalAdmitted).toBe(false);
  releasePersonal();
  const releasePersonalB = await secondPersonal;
  expect(secondPersonalAdmitted).toBe(true);
  releasePersonalB();
});

test("retires expired idle accounts without replacing active account semaphores", async () => {
  let now = 0;
  const pool = new SpeechCapacityPool(() => now, 100);
  const first = pool.forAccount("account-a");
  const release = await first.acquire(new AbortController().signal);

  now = 101;
  pool.forAccount("account-b");
  expect(pool.forAccount("account-a")).toBe(first);

  release();
  now = 202;
  pool.forAccount("account-c");
  expect(pool.forAccount("account-a")).not.toBe(first);
});
