import { describe, expect, test } from "bun:test";
import {
  DormantCryptoServerBoundaryError,
  createDormantCryptoServerBoundary,
} from "../../src/server/index.ts";

describe("dormant crypto server boundary", () => {
  test("rejects every Wave 7 operation before opening the lazy crypto pool", async () => {
    let poolOpenCount = 0;
    let operationRunCount = 0;
    const boundary = createDormantCryptoServerBoundary({
      activation: { stage: "disabled" },
      openCryptoConnection() {
        poolOpenCount += 1;
        return Promise.resolve({ kind: "crypto-connection" });
      },
    });

    for (const operation of [
      "first_device_bootstrap",
      "additional_device_approval",
      "device_recovery",
      "recovery_rotation",
      "device_revocation",
      "human_membership_transition",
      "background_authorization",
      "stenographer_protected_transform",
    ] as const) {
      expect(
        boundary.execute({
          operation,
          run() {
            operationRunCount += 1;
            return Promise.resolve("unreachable");
          },
        }),
      ).rejects.toMatchObject({
        code: "activation_disabled",
        operation,
      });
    }

    expect(poolOpenCount).toBe(0);
    expect(operationRunCount).toBe(0);
  });

  test("construction is lazy and unsupported activation input cannot bypass it", () => {
    let poolOpenCount = 0;
    const openCryptoConnection = () => {
      poolOpenCount += 1;
      return Promise.resolve({});
    };

    createDormantCryptoServerBoundary({
      activation: { stage: "disabled" },
      openCryptoConnection,
    });
    expect(poolOpenCount).toBe(0);

    for (const activation of [
      undefined,
      true,
      { stage: "enabled" },
      { stage: "disabled", hiddenOverride: true },
    ]) {
      expect(() =>
        createDormantCryptoServerBoundary({
          activation,
          openCryptoConnection,
        })
      ).toThrow(DormantCryptoServerBoundaryError);
    }
    expect(poolOpenCount).toBe(0);
  });
});
