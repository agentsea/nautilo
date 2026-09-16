import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PreparedMutationJournalIndex,
  PreparedMutationJournalVaultPort,
} from "../../src/client/memory/prepared-mutation-journal.ts";
import {
  createAdditionalDeviceTargetPlanJournal,
  createAdditionalDeviceTransitionCampaignJournal,
  type AdditionalDeviceTransitionCampaignVault,
} from "../../src/device/additional-device-transition-journal.ts";
import {
  createElectronPreparedMutationJournalVault,
  type ElectronSafeStoragePort,
} from "../../src/client/electron/index.ts";

function safeStorage(): ElectronSafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf8"),
    decryptString: (ciphertext) => {
      const value = ciphertext.toString("utf8");
      if (!value.startsWith("protected:")) throw new Error("safeStorage corrupt");
      return value.slice("protected:".length);
    },
  };
}

class MemoryVault implements AdditionalDeviceTransitionCampaignVault {
  index: PreparedMutationJournalIndex | undefined;
  body: Uint8Array | undefined;

  unlock() {
    return Promise.resolve({ status: "available" as const });
  }

  putSealed(input: Readonly<{
    index: PreparedMutationJournalIndex;
    canonicalBody: Uint8Array;
  }>) {
    if (this.index !== undefined) {
      return Promise.resolve(
        this.index.authenticatedRequestDigestBase64url
            === input.index.authenticatedRequestDigestBase64url
          ? "exact_duplicate" as const
          : "collision" as const,
      );
    }
    this.index = Object.freeze({ ...input.index });
    this.body = input.canonicalBody.slice();
    return Promise.resolve("inserted" as const);
  }

  listIndexes() {
    return Promise.resolve(this.index === undefined ? [] : [this.index]);
  }

  async withOpenedBody<Result>(
    operationId: string,
    digest: string,
    use: (bytes: Uint8Array) => Promise<Result> | Result,
  ) {
    if (
      this.index?.operationId !== operationId
      || this.index.authenticatedRequestDigestBase64url !== digest
      || this.body === undefined
    ) throw new Error("missing");
    const owned = this.body.slice();
    try {
      return await use(owned);
    } finally {
      owned.fill(0);
    }
  }

  updateIndex(
    expected: PreparedMutationJournalIndex,
    replacement: PreparedMutationJournalIndex,
  ) {
    if (JSON.stringify(this.index) !== JSON.stringify(expected)) {
      return Promise.resolve(false);
    }
    this.index = Object.freeze({ ...replacement });
    return Promise.resolve(true);
  }

  removeExact(operationId: string, digest: string) {
    if (
      this.index?.operationId !== operationId
      || this.index.authenticatedRequestDigestBase64url !== digest
    ) return Promise.resolve(false);
    this.index = undefined;
    this.body?.fill(0);
    this.body = undefined;
    return Promise.resolve(true);
  }
}

const HASH = "A".repeat(43);
const enrollment = {
  formatVersion: 1 as const,
  operationId: "operation-1",
  challengeId: "challenge-1",
  userId: "00000000-0000-4000-8000-000000000001",
  humanActorId: "00000000-0000-4000-8000-000000000002",
  deviceId: "device-target",
  clientKind: "electron" as const,
  installationLineageDigestBase64url: HASH,
  deviceGeneration: 1 as const,
  signingPublicKeyBase64url: HASH,
  encryptionPublicKeyBase64url: "A".repeat(87),
  method: "device_approval" as const,
  idempotencyKey: "idempotency-1",
  authorizationEvidenceDigestBase64url: HASH,
  authorizationDigestBase64url: HASH,
  expectedCustodyRevision: 1,
  expectedRecoveryGeneration: 1,
  inventoryRevision: 1,
  inventoryCount: 0,
  inventoryDigestBase64url: HASH,
  deviceRevision: 0 as const,
  status: "pending" as const,
  issuedAt: 1_000,
  expiresAt: 2_000,
};

function zeroDomainPage() {
  return {
    formatVersion: 2 as const,
    enrollment,
    approver: {
      deviceId: "device-approver",
      signingPublicKeyBase64url: HASH,
    },
    personalAuthority: null,
    domainCount: 0,
    page: {
      start: 0,
      end: 0,
      nextStart: null,
      pageDigestBase64url: HASH,
    },
    domains: [],
  };
}

describe("additional-device restart journals", () => {
  test("seals one exact complete transition request and rejects changed bytes", async () => {
    const vault = new MemoryVault();
    const journal = createAdditionalDeviceTransitionCampaignJournal({
      vault,
      now: () => 1_000,
    });
    const request = {
      requestVersion: 2 as const,
      approverDeviceId: "device-approver",
      inventoryRevision: 1,
      inventoryCount: 0,
      inventoryDigestBase64url: HASH,
      domainCount: 0,
      transitions: [],
    };
    const input = {
      operationId: "operation-1",
      targetDeviceId: "device-target",
      targetClientKind: "electron" as const,
      verificationCode: "AAAAAA-BBBBBB-CCCCCC",
      candidateProfileDigestBase64url: HASH,
      candidateProfileGeneration: 2,
      request,
    };
    const first = await journal.putBeforeSend(input);
    expect(first.status).toBe("inserted");
    expect((await journal.putBeforeSend(input)).status).toBe("duplicate");
    expect(journal.putBeforeSend({
      ...input,
      request: { ...request, inventoryRevision: 2 },
    })).rejects.toThrow("collided");
    expect(await journal.withRequest(first.index, (opened) => opened))
      .toEqual(request);
  });

  test("keeps the complete target plan and authenticated delivery manifest", async () => {
    const vault = new MemoryVault();
    const journal = createAdditionalDeviceTargetPlanJournal({
      vault,
      now: () => 1_000,
    });
    const index = await journal.putBeforeMutation({
      operationId: "operation-1",
      targetDeviceId: "device-target",
      verificationCode: "AAAAAA-BBBBBB-CCCCCC",
      pages: [zeroDomainPage()],
    });
    expect(await journal.withPages(index, (pages) => pages.length)).toBe(1);
    const recorded = await journal.recordDeliveryManifest(index, {
      highWatermark: 7,
      messages: [{
        messageId: "message-1",
        recipientSequence: 7,
        payloadHashBase64url: HASH,
      }],
    });
    expect(recorded.deliveryHighWatermark).toBe(7);
    expect(recorded.deliveryManifest).toHaveLength(1);
    expect(await journal.removeExact(recorded)).toBe(true);
  });

  test("uses the platform-neutral sealed-vault contract", () => {
    const vault: PreparedMutationJournalVaultPort = new MemoryVault();
    expect(typeof vault.putSealed).toBe("function");
  });

  test("reopens an exact transition campaign from Electron sealed storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-device-campaign-"));
    const request = {
      requestVersion: 2 as const,
      approverDeviceId: "device-approver",
      inventoryRevision: 1,
      inventoryCount: 0,
      inventoryDigestBase64url: HASH,
      domainCount: 0,
      transitions: [],
    };
    try {
      const firstVault = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: safeStorage(),
      });
      expect(await firstVault.unlock()).toEqual({ status: "available" });
      const first = createAdditionalDeviceTransitionCampaignJournal({
        vault: firstVault,
        now: () => 1_000,
      });
      await first.putBeforeSend({
        operationId: "operation-restart",
        targetDeviceId: "device-target",
        targetClientKind: "electron",
        verificationCode: "AAAAAA-BBBBBB-CCCCCC",
        candidateProfileDigestBase64url: HASH,
        candidateProfileGeneration: 2,
        request,
      });
      await firstVault.lock();

      const restartedVault = createElectronPreparedMutationJournalVault({
        directory,
        safeStorage: safeStorage(),
      });
      expect(await restartedVault.unlock()).toEqual({ status: "available" });
      const restarted = createAdditionalDeviceTransitionCampaignJournal({
        vault: restartedVault,
        now: () => 2_000,
      });
      const index = (await restarted.list())[0]!;
      expect(await restarted.withRequest(index, (opened) => opened))
        .toEqual(request);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
