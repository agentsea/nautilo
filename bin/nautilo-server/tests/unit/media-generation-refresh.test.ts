import { describe, expect, test } from "bun:test";
import { createMediaGenerationCredentialRefresh } from "../../src/media-generation-refresh";

describe("media generation credential refresh", () => {
  test("reinstalls only across absent, add, rotate, and remove transitions", () => {
    let key: string | null = null;
    let runtimeInstalls = 0;
    let workerInstalls = 0;
    const refresh = createMediaGenerationCredentialRefresh({
      resolveKey: () => key,
      installRuntime: () => { runtimeInstalls += 1; return Boolean(key?.trim()); },
      installWorker: () => { workerInstalls += 1; return Boolean(key?.trim()); },
    });

    refresh(); // unrelated reload while still absent
    key = " first-key ";
    refresh();
    refresh(); // unrelated reload with the same effective key
    key = "second-key";
    refresh();
    key = "  ";
    refresh();
    refresh(); // unrelated reload after removal

    expect(runtimeInstalls).toBe(3);
    expect(workerInstalls).toBe(3);
  });

  test("retries the same credential until both installers report success", () => {
    let key: string | null = null;
    let runtimeInstalls = 0;
    let workerInstalls = 0;
    let workerReady = false;
    const refresh = createMediaGenerationCredentialRefresh({
      resolveKey: () => key,
      installRuntime: () => { runtimeInstalls += 1; return true; },
      installWorker: () => { workerInstalls += 1; return workerReady; },
    });

    key = "new-key";
    refresh();
    workerReady = true;
    refresh();
    refresh();

    expect(runtimeInstalls).toBe(2);
    expect(workerInstalls).toBe(2);
  });
});
