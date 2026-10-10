import { afterAll, beforeAll } from "bun:test";

// A test file owns its lifetime, including teardown. Bun 1.3.11 on Windows can otherwise spin
// without advancing unref timers (including its own test timeout) when a fake
// application has no referenced native handles. Production timers keep their
// original unref semantics; only the test runner holds this reference.
if (process.platform === "win32") {
  let reference: ReturnType<typeof setInterval> | undefined;
  const clearReference = () => {
    if (reference !== undefined) clearInterval(reference);
    reference = undefined;
  };
  beforeAll(() => {
    if (reference === undefined) reference = setInterval(() => {}, 1000);
  });
  afterAll(clearReference);
}
