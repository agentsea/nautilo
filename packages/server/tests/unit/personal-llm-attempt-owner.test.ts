import { describe, expect, test } from "bun:test";
import { createPersonalLlmAttemptOwnerRuntime } from "../../src/lib/personal-llm-attempt-owner";

const OWNER_TOKEN = "99999999-9999-4999-8999-999999999999";

describe("foreground personal LLM attempt owner", () => {
  test("closing an app that never listened performs no database work", async () => {
    let databaseCalls = 0;
    const runtime = createPersonalLlmAttemptOwnerRuntime({
      renew: async () => { databaseCalls += 1; return 0; },
      recover: async () => { databaseCalls += 1; return 0; },
      interruptOwned: async () => { databaseCalls += 1; return 0; },
    });
    await runtime.stop();
    expect(databaseCalls).toBe(0);
  });

  test("drains every due renewal page before recovering expired work", async () => {
    const events: string[] = [];
    const renewalPages = [100, 100, 2];
    const recovered = Promise.withResolvers<void>();
    let intervalCallback: (() => void) | undefined;
    const runtime = createPersonalLlmAttemptOwnerRuntime({
      createOwnerToken: () => OWNER_TOKEN,
      installOwner: (ownerToken) => {
        events.push(`install:${ownerToken}`);
        return () => { events.push(`uninstall:${ownerToken}`); };
      },
      renew: async ({ ownerToken, limit }) => {
        events.push(`renew:${ownerToken}:${limit}`);
        return renewalPages.shift() ?? 0;
      },
      recover: async ({ limit }) => {
        events.push(`recover:${limit}`);
        recovered.resolve();
        return 0;
      },
      interruptOwned: async () => 0,
      setInterval: (callback) => {
        intervalCallback = callback;
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
      yieldToRuntime: async () => { events.push("yield"); },
    });

    runtime.start();
    await recovered.promise;
    expect(intervalCallback).toBeFunction();
    expect(events.filter((event) => event.startsWith("renew:"))).toHaveLength(3);
    expect(events.filter((event) => event === "yield")).toHaveLength(2);
    expect(events.at(-1)).toBe("recover:100");
    await runtime.stop();
  });

  test("coalesces wakes and shutdown removes admission before exact-owner interruption", async () => {
    const events: string[] = [];
    const firstRenew = Promise.withResolvers<void>();
    const secondRenew = Promise.withResolvers<void>();
    const allowRenew = Promise.withResolvers<void>();
    let renewCalls = 0;
    const shutdownPages = [100, 1];
    const runtime = createPersonalLlmAttemptOwnerRuntime({
      createOwnerToken: () => OWNER_TOKEN,
      installOwner: () => () => { events.push("uninstall"); },
      renew: async () => {
        renewCalls += 1;
        if (renewCalls === 1) {
          firstRenew.resolve();
          await allowRenew.promise;
        } else if (renewCalls === 2) {
          secondRenew.resolve();
        }
        return 0;
      },
      recover: async () => 0,
      interruptOwned: async ({ ownerToken, limit }) => {
        events.push(`interrupt:${ownerToken}:${limit}`);
        return shutdownPages.shift() ?? 0;
      },
      setInterval: () => ({ unref() {} }) as ReturnType<typeof setInterval>,
      clearInterval: () => { events.push("clear"); },
      yieldToRuntime: async () => { events.push("yield"); },
    });
    runtime.start();
    await firstRenew.promise;
    runtime.wake();
    runtime.wake();
    allowRenew.resolve();
    await secondRenew.promise;
    expect(renewCalls).toBe(2);

    await runtime.stop();
    expect(events.indexOf("uninstall")).toBeLessThan(events.findIndex((event) => event.startsWith("interrupt:")));
    expect(events.filter((event) => event.startsWith("interrupt:"))).toEqual([
      `interrupt:${OWNER_TOKEN}:100`,
      `interrupt:${OWNER_TOKEN}:100`,
    ]);
  });

  test("two replicas retain distinct process fences", async () => {
    const tokens: string[] = [];
    const make = (token: string) => createPersonalLlmAttemptOwnerRuntime({
      createOwnerToken: () => token,
      installOwner: () => () => {},
      renew: async ({ ownerToken }) => { tokens.push(ownerToken); return 0; },
      recover: async () => 0,
      interruptOwned: async () => 0,
      setInterval: () => ({ unref() {} }) as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      yieldToRuntime: async () => {},
    });
    const first = make("11111111-1111-4111-8111-111111111111");
    const second = make("22222222-2222-4222-8222-222222222222");
    first.start();
    second.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(tokens).toContain(first.ownerToken);
    expect(tokens).toContain(second.ownerToken);
    await first.stop();
    await second.stop();
  });
});
