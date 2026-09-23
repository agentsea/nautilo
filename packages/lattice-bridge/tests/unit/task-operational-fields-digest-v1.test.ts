import { describe, expect, test } from "bun:test";
import {
  encodeTaskOperationalFieldsV1,
  fingerprintTaskDualPublicationFieldsV1,
  fingerprintTaskOperationalFieldsV1,
} from "../../src/task/task-operational-fields-digest-v1.ts";
import { encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";

describe("Task operational fields digest", () => {
  test("object key order is canonical, including nested selection fields", () => {
    const first = {
      scheduleKind: "now",
      selectionSpec: { objective: "smart", absoluteFloors: { privacy: 1, maxCost: 3 } },
    };
    const second = {
      selectionSpec: { absoluteFloors: { maxCost: 3, privacy: 1 }, objective: "smart" },
      scheduleKind: "now",
    };
    expect(encodeTaskOperationalFieldsV1("create", first))
      .toEqual(encodeTaskOperationalFieldsV1("create", second));
    expect(fingerprintTaskOperationalFieldsV1("create", first))
      .toEqual(fingerprintTaskOperationalFieldsV1("create", second));
  });

  test("does not accept absent task, present undefined, content, or update-only scope changes", () => {
    for (const value of [undefined, null, { cron: undefined }, { prompt: "secret" },
      { selectionSpec: { objective: "smart", band: undefined } }]) {
      expect(() => fingerprintTaskOperationalFieldsV1("create", value)).toThrow();
    }
    expect(() => fingerprintTaskOperationalFieldsV1("update", { useScope: true })).toThrow();
    expect(() => fingerprintTaskOperationalFieldsV1("create", {})).not.toThrow();
  });

  test("changed operational values and ordered tool arrays change the digest", () => {
    const task = { tools: ["read", "write"], requestedModelId: "first" };
    const original = fingerprintTaskOperationalFieldsV1("create", task);
    task.requestedModelId = "second";
    expect(fingerprintTaskOperationalFieldsV1("create", task)).not.toEqual(original);
    task.requestedModelId = "first";
    task.tools.reverse();
    expect(fingerprintTaskOperationalFieldsV1("create", task)).not.toEqual(original);
    expect(fingerprintTaskOperationalFieldsV1("create", {}))
      .not.toEqual(fingerprintTaskOperationalFieldsV1("create", { requestedModelId: null }));
  });

  test("rejects getters, cycles and non-JSON objects without invoking them", () => {
    let getterCalled = false;
    const getter = Object.defineProperty({}, "timezone", {
      enumerable: true, get() { getterCalled = true; return "UTC"; },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic["selectionSpec"] = cyclic;
    for (const value of [getter, cyclic, new Date(), { tools: [undefined] }]) {
      expect(() => fingerprintTaskOperationalFieldsV1("create", value)).toThrow();
    }
    expect(getterCalled).toBe(false);
  });

  test("dual publication digest binds operation, operational fields, and canonical content", () => {
    const first = encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "first private prompt",
      expectedOutput: null,
      protectedMetadata: {},
    });
    const second = encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "second private prompt",
      expectedOutput: null,
      protectedMetadata: {},
    });
    try {
      const digest = fingerprintTaskDualPublicationFieldsV1(
        "create",
        { scheduleKind: "now" },
        first,
      );
      expect(digest).toHaveLength(32);
      expect(fingerprintTaskDualPublicationFieldsV1(
        "create", { scheduleKind: "now" }, second,
      )).not.toEqual(digest);
      expect(fingerprintTaskDualPublicationFieldsV1(
        "create", { scheduleKind: "cron", cron: "0 9 * * *" }, first,
      )).not.toEqual(digest);
      expect(fingerprintTaskDualPublicationFieldsV1("update", {}, first))
        .not.toEqual(fingerprintTaskDualPublicationFieldsV1("create", {}, first));
      expect(() => fingerprintTaskDualPublicationFieldsV1(
        "create",
        {},
        new TextEncoder().encode('{"prompt":"not canonical"}'),
      )).toThrow();
    } finally {
      first.fill(0);
      second.fill(0);
    }
  });
});
