import { describe, expect, test } from "bun:test";

import {
  parseLaunchReceipt,
  validateLaunchReceiptTransition,
  type LaunchReceipt,
} from "../../src";

const t0 = "2026-08-03T12:00:00.000Z";
const t1 = "2026-08-03T12:01:00.000Z";

function receipt(overrides: Partial<LaunchReceipt> = {}): LaunchReceipt {
  return {
    schemaVersion: 1,
    launchId: "launch-488",
    backend: "railway",
    revision: 0,
    stage: "planned",
    resources: [],
    cleanup: { state: "not-required" },
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

describe("launch receipt schema", () => {
  test("accepts a non-secret V1 receipt and preserves exact provider references", () => {
    const value = receipt({
      revision: 2,
      stage: "provisioning",
      resources: [
        { kind: "project", id: "89e7bbd0-91d2-44bf", name: "Nautilo" },
        { kind: "service", id: "server-42", name: "nautilo-server" },
      ],
      lastFailure: {
        kind: "rate-limited",
        operation: "create-service",
        retryable: true,
        occurredAt: t1,
      },
      updatedAt: t1,
    });

    expect(parseLaunchReceipt(value)).toEqual({ ok: true, receipt: value });
  });

  test("rejects future versions and unknown fields", () => {
    expect(parseLaunchReceipt({ ...receipt(), schemaVersion: 2 })).toEqual({
      ok: false,
      code: "unsupported-version",
      path: "$.schemaVersion",
    });
    expect(parseLaunchReceipt({ ...receipt(), statusText: "okay" })).toEqual({
      ok: false,
      code: "unknown-field",
      path: "$.statusText",
    });
  });

  test("rejects secret-bearing fields and values without echoing the secret", () => {
    expect(parseLaunchReceipt({ ...receipt(), accessToken: "opaque" })).toEqual({
      ok: false,
      code: "secret-material",
      path: "$.accessToken",
    });
    expect(
      parseLaunchReceipt({
        ...receipt(),
        resources: [{ kind: "project", id: "sk-abcdefghijklmnopqrstuvwxyz" }],
      }),
    ).toEqual({
      ok: false,
      code: "secret-material",
      path: "$.resources[0].id",
    });
    expect(
      parseLaunchReceipt({
        ...receipt(),
        resources: [
          { kind: "project", id: "project-1", name: "https://user:pass@example.com" },
        ],
      }),
    ).toMatchObject({ ok: false, code: "secret-material" });
    expect(
      parseLaunchReceipt({
        ...receipt(),
        resources: [
          { kind: "project", id: "project-1", name: "https://example.com/launch" },
        ],
      }),
    ).toEqual({
      ok: false,
      code: "invalid-value",
      path: "$.resources[0].name",
    });
    expect(
      parseLaunchReceipt({
        ...receipt(),
        lastFailure: {
          kind: "provider",
          operation: "create-service",
          retryable: true,
          occurredAt: t1,
          message: "provider response",
        },
      }),
    ).toEqual({
      ok: false,
      code: "secret-material",
      path: "$.lastFailure.message",
    });
    expect(parseLaunchReceipt({ ...receipt(), env: { MODEL_KEY: "opaque" } })).toEqual({
      ok: false,
      code: "secret-material",
      path: "$.env",
    });
  });

  test("rejects duplicate and conflicting realized resources", () => {
    expect(
      parseLaunchReceipt({
        ...receipt(),
        resources: [
          { kind: "service", id: "one", name: "server" },
          { kind: "service", id: "one", name: "server" },
        ],
      }),
    ).toMatchObject({ ok: false, code: "duplicate-resource" });
    expect(
      parseLaunchReceipt({
        ...receipt(),
        resources: [
          { kind: "service", id: "one", name: "server" },
          { kind: "service", id: "two", name: "server" },
        ],
      }),
    ).toMatchObject({ ok: false, code: "conflicting-resource" });
  });

  test("requires claim and verified-cleanup evidence to match their states", () => {
    expect(parseLaunchReceipt({ ...receipt(), stage: "claimable" })).toMatchObject({
      ok: false,
      path: "$.claimableAt",
    });
    expect(
      parseLaunchReceipt({
        ...receipt(),
        cleanup: { state: "verified", verifiedAt: t1 },
        resources: [{ kind: "project", id: "project-1" }],
      }),
    ).toMatchObject({ ok: false, path: "$.resources" });
  });
});

describe("launch receipt transitions", () => {
  test("allows a same-stage resource checkpoint and one-stage progression", () => {
    const previous = receipt({
      revision: 1,
      stage: "provisioning",
      resources: [{ kind: "project", id: "project-1" }],
      updatedAt: t0,
    });
    const checkpoint = receipt({
      revision: 2,
      stage: "provisioning",
      resources: [
        { kind: "project", id: "project-1" },
        { kind: "service", id: "server-1" },
      ],
      updatedAt: t1,
    });
    expect(validateLaunchReceiptTransition(previous, checkpoint)).toEqual({ ok: true });
    expect(
      validateLaunchReceiptTransition(checkpoint, {
        ...checkpoint,
        revision: 3,
        stage: "bootstrapping",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects identity changes, skipped/regressed stages, and bad revisions", () => {
    const previous = receipt({ revision: 3, stage: "provisioning" });
    expect(
      validateLaunchReceiptTransition(previous, {
        ...previous,
        launchId: "another-launch",
        revision: 4,
      }),
    ).toMatchObject({ ok: false, path: "$.launchId" });
    expect(
      validateLaunchReceiptTransition(previous, {
        ...previous,
        revision: 5,
      }),
    ).toMatchObject({ ok: false, path: "$.revision" });
    expect(
      validateLaunchReceiptTransition(previous, {
        ...previous,
        revision: 4,
        stage: "claimable",
        claimableAt: t1,
      }),
    ).toMatchObject({ ok: false, path: "$.stage" });
  });

  test("retains known resources until an explicit cleanup transition", () => {
    const previous = receipt({
      revision: 1,
      resources: [{ kind: "project", id: "project-1" }],
    });
    expect(
      validateLaunchReceiptTransition(previous, {
        ...previous,
        revision: 2,
        resources: [],
      }),
    ).toMatchObject({ ok: false, path: "$.resources" });
    expect(
      validateLaunchReceiptTransition(
        { ...previous, cleanup: { state: "pending" } },
        {
          ...previous,
          revision: 2,
          resources: [],
          cleanup: { state: "in-progress" },
        },
      ),
    ).toEqual({ ok: true });
  });

  test("does not advance launch stages after cleanup begins", () => {
    const previous = receipt({
      revision: 2,
      stage: "provisioning",
      cleanup: { state: "pending" },
      updatedAt: t0,
    });
    expect(
      validateLaunchReceiptTransition(previous, {
        ...previous,
        revision: 3,
        stage: "bootstrapping",
        cleanup: { state: "in-progress" },
        updatedAt: t1,
      }),
    ).toMatchObject({ ok: false, path: "$.stage" });
  });
});
