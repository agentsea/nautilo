import { describe, expect, test } from "bun:test";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";
import {
  additionalDevicePendingProgress,
  createPostgresAdditionalDeviceComposition,
  currentEnrollmentSyncReason,
} from "../../src/server/device/production-additional-device.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

describe("production additional-device pending enrollment", () => {
  test("gates activation only on current Human Domain membership", async () => {
    const missing = new ScriptedConnection([[
      {
        target_count: 1,
        required_domains: 2,
        covered_domains: 1,
      },
    ]]);
    expect(await currentEnrollmentSyncReason(missing, "device-browser"))
      .toBe("current_domain_sync_required");
    expect(missing.statements[0]).toContain("crypto_domain_devices");
    expect(missing.statements[0]).not.toContain("grant_domain");
    expect(missing.statements[0]).not.toContain("namespace_key_recipient");

    const covered = new ScriptedConnection([[
      {
        target_count: 1,
        required_domains: 2,
        covered_domains: 2,
      },
    ]]);
    expect(await currentEnrollmentSyncReason(covered, "device-browser"))
      .toBeNull();
  });

  test("keeps an approved operation visible before its first transition step", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [{ device_id: "device-browser" }],
      [],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const composition = createPostgresAdditionalDeviceComposition({
      getHandle: () => Promise.resolve(handle),
    });

    expect(await composition.pendingV2({
      authority: {
        userId: "00000000-0000-4000-8000-000000000001",
        humanActorId: "00000000-0000-4000-8000-000000000002",
      },
      approverDeviceId: "device-browser",
    })).toEqual([]);
    expect(connection.statements[2]).toContain(
      "SELECT 1 FROM crypto_device_epoch_operations e",
    );
  });

  test("offers key transfer—not repeated approval—after admission", () => {
    expect(additionalDevicePendingProgress({
      operationState: "awaiting_committer",
      transitionStepCount: 0,
      joinPackageCount: 0,
      admissionPresent: true,
    })).toBe("transfer_ready");
    expect(additionalDevicePendingProgress({
      operationState: "requested",
      transitionStepCount: 0,
      joinPackageCount: 0,
      admissionPresent: false,
    })).toBe("approval_required");
    expect(additionalDevicePendingProgress({
      operationState: "awaiting_delivery",
      transitionStepCount: 1,
      joinPackageCount: 1,
      admissionPresent: true,
    })).toBe("awaiting_target");
    expect(additionalDevicePendingProgress({
      operationState: "awaiting_committer",
      transitionStepCount: 1,
      joinPackageCount: 0,
      admissionPresent: true,
    })).toBe("awaiting_target");
    expect(additionalDevicePendingProgress({
      operationState: "awaiting_committer",
      transitionStepCount: 1,
      joinPackageCount: 1,
      admissionPresent: true,
    })).toBe("transfer_ready");
  });
});
