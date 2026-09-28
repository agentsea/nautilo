import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrowserBackgroundAuthorizationClientV2,
  createBrowserHumanPeerLiveShadowMessageReceiver,
  createBrowserLiveShadowMessageClient,
  createBrowserLiveShadowMessageReceiver,
  createBrowserRoomHistoryShadowMessageReader,
  createBrowserSharedAgentLiveShadowMessageReceiver,
  createBrowserSharedAgentOutputLiveShadowReceiver,
  deriveBrowserCryptoDeviceId,
} from "../../src/client/browser/index.ts";
import {
  createElectronBackgroundAuthorizationClientV2,
  createElectronHumanPeerLiveShadowMessageReceiver,
  createElectronHumanMemoryClient,
  createElectronForegroundShadowCustody,
  createElectronLiveShadowMessageClient,
  createElectronLiveShadowMessageReceiver,
  createElectronRoomHistoryShadowMessageReader,
  createElectronSharedAgentLiveShadowMessageReceiver,
  createElectronSharedAgentOutputLiveShadowReceiver,
  deriveElectronCryptoDeviceId,
  type ElectronForegroundShadowCustody,
  type ElectronSafeStoragePort,
} from "../../src/client/electron/index.ts";
import { bindEncryptionDataOperationOwner } from "../../src/transition/encryption-data-operation-owner.ts";

const dataOperationOwner = bindEncryptionDataOperationOwner({ policy: {
  resolve: async () => ({ policy: { mode: "shadow_encryption", shadowBehavior: "fallback" }, revalidationToken: 1 }),
  revalidate: () => Promise.resolve(),
} });

const identity = Object.freeze({
  serverScope: "https://nautilo.test",
  userId: "user-1",
  humanActorId: "human-1",
  installationId: "installation-1",
});

const inaccessibleSafeStorage: ElectronSafeStoragePort = Object.freeze({
  isEncryptionAvailable: () => {
    throw new Error("factory construction must not access custody");
  },
  encryptString: () => {
    throw new Error("factory construction must not access custody");
  },
  decryptString: () => {
    throw new Error("factory construction must not access custody");
  },
});

const testSafeStorage: ElectronSafeStoragePort = Object.freeze({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "keychain",
  encryptString: (plaintext: string): Buffer => Buffer.from(plaintext, "utf8"),
  decryptString: (ciphertext: Buffer): string => ciphertext.toString("utf8"),
});

const constructionOnlyDomainApi = Object.freeze(Object.fromEntries([
  "planDomainKeyAuthorityV2",
  "publishDomainKeyAuthorityV2",
  "requestDomainKeyRecipientV2",
  "listPendingDomainKeyRequestsV2",
  "fulfilDomainKeyRecipientV2",
  "fetchDomainKeyEnvelopeV2",
  "acknowledgeDomainKeyEnvelopeV2",
  "planDomainNamespaceBundleV2",
  "publishDomainNamespaceBundleV2",
].map((method) => [method, () => {
  throw new Error(`${method} must not run during factory construction`);
}])));

const browserBase = Object.freeze({
  ...identity,
  dataOperationOwner,
  api: constructionOnlyDomainApi as never,
  now: () => 1_700_000_000_000,
});
const electronBase = Object.freeze({
  ...browserBase,
  directory: "/not-opened/foreground-shadow-contract",
  safeStorage: inaccessibleSafeStorage,
});

function publicShape(value: object): readonly string[] {
  return Object.freeze(Object.keys(value).sort());
}

describe("foreground Shadow client composition", () => {
  test("opens Memory retry custody on first use and after a local lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-memory-retry-custody-"));
    const custody = createElectronForegroundShadowCustody({
      directory,
      safeStorage: testSafeStorage,
    });
    try {
      const client = createElectronHumanMemoryClient({
        ...browserBase,
        api: {
          ...constructionOnlyDomainApi,
          ...Object.fromEntries([
            "listProtectedMemories", "getProtectedMemory", "getProtectedMemoryBrief",
            "planProtectedMemoryCreate", "archiveProtectedMemory", "transitionProtectedMemoryTier",
            "restoreProtectedMemory", "planProtectedMemoryAccess", "commitProtectedMemoryAccess",
            "planProtectedMemoryRepair", "commitProtectedMemoryRepair",
          ].map((method) => [method, () => {
            throw new Error(`${method} must not run for an empty retry journal`);
          }])),
        } as never,
        foregroundCustody: custody,
        resolveDeviceAdmissionStatus: async () => {
          throw new Error("An empty retry journal requires no device admission request");
        },
      });
      expect(await custody.preparedMutationJournalVault.availability()).toEqual({ status: "locked" });
      expect(await client.retryPendingMutations()).toBe(0);
      expect(await custody.preparedMutationJournalVault.availability()).toEqual({ status: "available" });
      await custody.lock();
      expect(await client.retryPendingMutations()).toBe(0);
      expect(await custody.preparedMutationJournalVault.availability()).toEqual({ status: "available" });
    } finally {
      await custody.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps Browser and Electron public device IDs stable and kind-separated", () => {
    const browser = deriveBrowserCryptoDeviceId(identity);
    const electron = deriveElectronCryptoDeviceId(identity);

    expect(deriveBrowserCryptoDeviceId(identity)).toBe(browser);
    expect(deriveElectronCryptoDeviceId(identity)).toBe(electron);
    expect(electron).not.toBe(browser);
  });

  test("constructs sender parity without opening platform custody", () => {
    const browser = createBrowserLiveShadowMessageClient({
      ...browserBase,
      normalizeContent: (content) => content.trim(),
      createIdempotencyKey: () => "operation-1",
    });
    const electron = createElectronLiveShadowMessageClient({
      ...electronBase,
      normalizeContent: (content) => content.trim(),
      createIdempotencyKey: () => "operation-1",
    });

    expect(publicShape(electron)).toEqual(publicShape(browser));
  });

  test("constructs one shared automatic background responder for Browser and Electron", () => {
    const browser = createBrowserBackgroundAuthorizationClientV2({
      ...browserBase,
      api: constructionOnlyDomainApi as never,
    });
    const electron = createElectronBackgroundAuthorizationClientV2({
      ...electronBase,
      api: constructionOnlyDomainApi as never,
    });

    expect(publicShape(electron)).toEqual(publicShape(browser));
    expect(browser.deviceId).toBe(deriveBrowserCryptoDeviceId(identity));
    expect(electron.deviceId).toBe(deriveElectronCryptoDeviceId(identity));
  });

  test("keeps disabled Browser and Electron sends byte-equivalent on zero custody", async () => {
    const browserPlans: unknown[] = [];
    const electronPlans: unknown[] = [];
    const browserSends: unknown[] = [];
    const electronSends: unknown[] = [];
    const api = (plans: unknown[], sends: unknown[]) => ({
      planLiveShadowRoomMessage: (_roomId: string, request: unknown) => {
        plans.push(structuredClone(request));
        return Promise.resolve({
          responseVersion: 1 as const,
          status: "disabled" as const,
          mode: "plaintext_only" as const,
        });
      },
      sendRoomMessage: (_roomId: string, body: unknown) => {
        sends.push(structuredClone(body));
        return Promise.resolve({
          messageId: 1,
          jobId: null,
          accepted: true,
          attachments: [],
          coalesced: false,
        });
      },
    });
    const browser = createBrowserLiveShadowMessageClient({
      ...browserBase,
      api: api(browserPlans, browserSends) as never,
      normalizeContent: (content) => content.trim(),
      createIdempotencyKey: () => "operation:m300:disabled",
    });
    const electron = createElectronLiveShadowMessageClient({
      ...electronBase,
      api: api(electronPlans, electronSends) as never,
      normalizeContent: (content) => content.trim(),
      createIdempotencyKey: () => "operation:m300:disabled",
    });
    const body = Object.freeze({
      content: " ordinary ",
      clientActionSessionId: "client-action:m300",
    });

    await browser.send("room:m300", body);
    await electron.send("room:m300", body);

    const browserPlan = browserPlans[0] as Record<string, unknown>;
    const electronPlan = electronPlans[0] as Record<string, unknown>;
    const { clientDeviceId: browserDeviceId, ...browserPlanBytes } = browserPlan;
    const { clientDeviceId: electronDeviceId, ...electronPlanBytes } = electronPlan;
    expect(electronPlanBytes).toEqual(browserPlanBytes);
    expect(browserDeviceId).toBe(deriveBrowserCryptoDeviceId(identity));
    expect(electronDeviceId).toBe(deriveElectronCryptoDeviceId(identity));
    expect(electronSends).toEqual(browserSends);
    expect(electronSends).toEqual([body]);
  });

  test("constructs every receiver and history reader with Browser parity", () => {
    const pairs = [
      [
        createBrowserLiveShadowMessageReceiver(browserBase),
        createElectronLiveShadowMessageReceiver(electronBase),
      ],
      [
        createBrowserHumanPeerLiveShadowMessageReceiver(browserBase),
        createElectronHumanPeerLiveShadowMessageReceiver(electronBase),
      ],
      [
        createBrowserSharedAgentLiveShadowMessageReceiver(browserBase),
        createElectronSharedAgentLiveShadowMessageReceiver(electronBase),
      ],
      [
        createBrowserSharedAgentOutputLiveShadowReceiver(browserBase),
        createElectronSharedAgentOutputLiveShadowReceiver(electronBase),
      ],
      [
        createBrowserRoomHistoryShadowMessageReader({
          ...browserBase,
          createIdempotencyKey: () => "history-1",
        }),
        createElectronRoomHistoryShadowMessageReader({
          ...electronBase,
          createIdempotencyKey: () => "history-1",
        }),
      ],
    ] as const;

    for (const [browser, electron] of pairs) {
      expect(publicShape(electron)).toEqual(publicShape(browser));
    }
  });

  test("reuses one supplied Electron custody across every factory", () => {
    const owned = createElectronForegroundShadowCustody({
      directory: "/not-opened/shared-foreground-shadow-contract",
      safeStorage: inaccessibleSafeStorage,
    });
    const reads = { profile: 0, journal: 0, namespace: 0 };
    const foregroundCustody: ElectronForegroundShadowCustody = Object.freeze({
      get profileVault() {
        reads.profile += 1;
        return owned.profileVault;
      },
      get preparedMutationJournalVault() {
        reads.journal += 1;
        return owned.preparedMutationJournalVault;
      },
      get namespaceGenerationCacheVault() {
        reads.namespace += 1;
        return owned.namespaceGenerationCacheVault;
      },
      lock: () => owned.lock(),
      dispose: () => owned.dispose(),
    });
    const shared = Object.freeze({ ...browserBase, foregroundCustody });

    createElectronLiveShadowMessageClient({
      ...shared,
      normalizeContent: (content) => content,
    });
    createElectronLiveShadowMessageReceiver(shared);
    createElectronHumanPeerLiveShadowMessageReceiver(shared);
    createElectronSharedAgentLiveShadowMessageReceiver(shared);
    createElectronSharedAgentOutputLiveShadowReceiver(shared);
    createElectronRoomHistoryShadowMessageReader(shared);

    expect(reads).toEqual({ profile: 6, journal: 1, namespace: 6 });
  });

  test("locks and disposes all three owned Electron custody stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-foreground-custody-"));
    try {
      const custody = createElectronForegroundShadowCustody({
        directory,
        safeStorage: testSafeStorage,
      });
      expect(await custody.profileVault.unlock()).toEqual({ status: "available" });
      expect(await custody.preparedMutationJournalVault.unlock()).toEqual({
        status: "available",
      });
      expect(await custody.namespaceGenerationCacheVault.unlock()).toEqual({
        status: "available",
      });

      const disposal = custody.dispose();
      expect(custody.lock()).toBe(disposal);
      await disposal;

      expect(await custody.profileVault.availability()).toEqual({ status: "locked" });
      expect(await custody.preparedMutationJournalVault.availability()).toEqual({
        status: "locked",
      });
      expect(await custody.namespaceGenerationCacheVault.availability()).toEqual({
        status: "locked",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
