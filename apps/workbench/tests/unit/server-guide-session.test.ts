import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  beginIncompleteServerGuideSession,
  beginServerGuideSession,
  completeServerGuide,
  endServerGuideSession,
  isServerGuideCompleted,
  isServerGuideSessionActive,
} from "../../src/lib/server-guide-session";

describe("server guide session", () => {
  const previous = globalThis.sessionStorage;
  const previousLocal = globalThis.localStorage;
  const values = new Map<string, string>();
  const durableValues = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    durableValues.clear();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => durableValues.get(key) ?? null,
        setItem: (key: string, value: string) => durableValues.set(key, value),
      },
    });
  });

  afterAll(() => {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    } else {
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: previous,
      });
    }
    if (previousLocal === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousLocal });
  });

  test("is session-scoped and explicitly dismissible", () => {
    expect(isServerGuideSessionActive()).toBe(false);
    beginServerGuideSession();
    expect(isServerGuideSessionActive()).toBe(true);
    endServerGuideSession();
    expect(isServerGuideSessionActive()).toBe(false);
  });

  test("completed setup stays ended while the guide remains available for explicit revisits", () => {
    beginIncompleteServerGuideSession("server-a");
    expect(isServerGuideSessionActive()).toBe(true);
    completeServerGuide("server-a");
    expect(isServerGuideCompleted("server-a")).toBe(true);
    expect(isServerGuideSessionActive()).toBe(false);

    beginIncompleteServerGuideSession("server-a");
    expect(isServerGuideSessionActive()).toBe(false);
    beginIncompleteServerGuideSession("server-b");
    expect(isServerGuideSessionActive()).toBe(true);
  });
});
