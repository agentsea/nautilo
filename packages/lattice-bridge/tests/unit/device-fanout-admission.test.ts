import { describe, expect, test } from "bun:test";
import {
  createDeviceFanoutAdmission,
  type VerifiedAdditionalDeviceApproval,
} from "../../src/index.ts";
import {
  createVerifiedDeviceFanoutAdmissionFixture,
} from "./device-fanout-admission-fixture.ts";

describe("device fanout admission", () => {
  test("turns the exact cryptographically verified approval into deterministic delivery rows", async () => {
    const { crypto, approval: verified } =
      await createVerifiedDeviceFanoutAdmissionFixture();
    const first = createDeviceFanoutAdmission({
      crypto,
      approval: verified,
      now: 20_000,
    });
    const second = createDeviceFanoutAdmission({
      crypto,
      approval: verified,
      now: 20_000,
    });

    expect(first).toEqual(second);
    expect(first.sourceDeviceId).toBe("device_alice_current");
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({
      kind: "device_transfer",
      recipientDeviceId: "device_alice_pending",
      createdAt: 20_000,
    });
    expect(first.aggregatePayloadBytes).toBe(
      verified.plan.aggregatePayloadBytes,
    );
    expect(first.outbox.payloadBytes.length).toBeGreaterThan(0);
    expect(first.outbox.payloadBytes.length).toBeLessThanOrEqual(4_096);
  });

  test("rejects a structural look-alike even when every public field is copied", async () => {
    const { crypto, approval: verified } =
      await createVerifiedDeviceFanoutAdmissionFixture();
    const forged = {
      ...verified,
      manifest: {
        ...verified.manifest,
        signature: new Uint8Array(64).fill(0x41),
      },
    } as VerifiedAdditionalDeviceApproval;

    expect(() => createDeviceFanoutAdmission({
      crypto,
      approval: forged,
      now: 20_000,
    })).toThrow("not cryptographically verified");
    expect(() => createDeviceFanoutAdmission({
      crypto,
      approval: structuredClone(verified),
      now: 20_000,
    })).toThrow("not cryptographically verified");
  });

  test("rejects mutation after cryptographic verification", async () => {
    const { crypto, approval: verified } =
      await createVerifiedDeviceFanoutAdmissionFixture();
    verified.plan.inventoryDigest[0] =
      verified.plan.inventoryDigest[0]! ^ 1;

    expect(() => createDeviceFanoutAdmission({
      crypto,
      approval: verified,
      now: 20_000,
    })).toThrow("not cryptographically verified");
  });
});
