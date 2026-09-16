import { describe, expect, test } from "bun:test";
import type {
  ElectronLiveShadowMessageClientInput,
  ElectronLiveShadowMessageReceiverInput,
  ElectronSafeStoragePort,
} from "@nautilo/lattice-bridge/client/electron";
import {
  createElectronForegroundShadowController,
  ElectronForegroundShadowControllerUnavailableError,
  type ElectronForegroundShadowApi,
  type ElectronForegroundShadowControllerFactories,
} from "../../electron/foreground-shadow-controller";

const safeStorage: ElectronSafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString("utf8"),
};

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

type FactoryOverrides = Partial<{
  senderInput: (input: ElectronLiveShadowMessageClientInput) => unknown;
  liveReceiverInput: (input: ElectronLiveShadowMessageReceiverInput) => unknown;
  sender: Record<string, unknown>;
  liveReceiver: Record<string, unknown>;
  humanPeerReceiver: Record<string, unknown>;
  sharedAgentReceiver: Record<string, unknown>;
  sharedAgentOutputReceiver: Record<string, unknown>;
  historyReader: Record<string, unknown>;
  humanMemory: Record<string, unknown>;
  messageBackfill: Record<string, unknown>;
  backgroundAuthorization: Record<string, unknown>;
  custodyDispose: () => Promise<void>;
}>;

function factories(
  overrides: FactoryOverrides = {},
): ElectronForegroundShadowControllerFactories {
  const sender = {
    deviceId: "device:electron:test",
    send: async () => ({ messageId: 1 }),
    recoverPending: async () => 0,
    recoverRoomPendingAttention: async () => ({ status: "ready", events: [] }),
    completePending: async () => true,
    synchronizeHumanPeerRecipients: async () => true,
    serviceDomainKeyBacklog: async () => true,
    authorizeSharedAgentExecution: async () => true,
    ...overrides.sender,
  };
  const liveReceiver = {
    registerHuman: async () => undefined,
    receive: async () => ({ status: "start_verified" }),
    destroy: () => undefined,
    ...overrides.liveReceiver,
  };
  return {
    createCustody: () => ({
      profileVault: {},
      preparedMutationJournalVault: {},
      namespaceGenerationCacheVault: {},
      lock: overrides.custodyDispose ?? (() => Promise.resolve()),
      dispose: overrides.custodyDispose ?? (() => Promise.resolve()),
    }) as never,
    createSender: (input) => {
      overrides.senderInput?.(input);
      return sender as never;
    },
    createLiveReceiver: (input) => {
      overrides.liveReceiverInput?.(input);
      return liveReceiver as never;
    },
    createHumanPeerReceiver: () => ({
      receive: async () => null,
      ...overrides.humanPeerReceiver,
    }) as never,
    createSharedAgentReceiver: () => ({
      receive: async () => null,
      ...overrides.sharedAgentReceiver,
    }) as never,
    createSharedAgentOutputReceiver: () => ({
      receive: async () => null,
      destroy: () => undefined,
      ...overrides.sharedAgentOutputReceiver,
    }) as never,
    createHistoryReader: () => ({
      readerDeviceId: "device:electron:test",
      reconcile: async () => ({ records: [], eligibleCount: 0 }),
      acknowledge: async () => "accepted",
      ...overrides.historyReader,
    }) as never,
    createHumanMemory: () => ({
      withList: async () => ({ nextCursor: null, memoryMode: "namespace" }),
      withSearch: async () => ({
        memoryMode: "namespace", queryDisclosure: "embedding_provider",
      }),
      withDetail: async () => ({
        memoryMode: "namespace",
        actionAuthority: {
          canEdit: true, canArchive: true, canManageAccess: true,
        },
      }),
      update: async () => ({ status: "published", memoryId: "memory-1" }),
      retryPendingMutations: async () => 0,
      archive: async (memoryId: string) => ({ status: "archived", memoryId, tier: 3 }),
      restore: async (memoryId: string) => ({
        status: "restored", memoryId, previousTier: 3, nextTier: 2,
      }),
      transitionTier: async (memoryId: string, action: "promote" | "demote") => ({
        status: action === "promote" ? "promoted" : "demoted",
        memoryId,
        previousTier: action === "promote" ? 2 : 1,
        nextTier: action === "promote" ? 1 : 2,
      }),
      deleteAuthorizedView: async (memoryId: string) =>
        ({ status: "updated", memoryId }),
      grantUser: async (memoryId: string, userHandle: string) =>
        ({ status: "updated", memoryId, userHandle }),
      revokeUser: async (memoryId: string, userHandle: string) =>
        ({ status: "updated", memoryId, userHandle }),
      makePrivate: async (memoryId: string) => ({ status: "updated", memoryId }),
      ...overrides.humanMemory,
    }) as never,
    createMessageBackfill: () => ({
      prioritize: () => undefined,
      runBatch: async () => ({ state: "caught_up", resumeAt: null }),
      ...overrides.messageBackfill,
    }) as never,
    createBackgroundAuthorization: () => ({
      deviceId: "device:electron:test",
      service: async () => ({
        status: "complete", pages: 1, discovered: 0, responded: 0,
        deferred: 0, stale: 0, invalid: 0,
      }),
      ...overrides.backgroundAuthorization,
    }) as never,
  };
}

function controllerInput(input: Readonly<{
  factories?: ElectronForegroundShadowControllerFactories;
  api?: ElectronForegroundShadowApi;
  isBindingCurrent?: () => boolean | Promise<boolean>;
  refreshBearer?: () => Promise<string | null>;
  sendRoomMessage?: ElectronLiveShadowMessageClientInput["api"][
    "sendRoomMessage"
  ];
  createId?: () => string;
}> = {}) {
  const api = input.api ?? ({
    setToken: () => undefined,
    admin: { encryptionTransition: { getPolicy: async () => ({
      policy: { mode: "shadow_encryption", shadowBehavior: "fallback",
        revision: 1, updatedAt: "2026-09-01T00:00:00.000Z" },
    }) } },
    sendRoomMessage: async () => {
      throw new Error("the origin-owned send seam was bypassed");
    },
  } as unknown as ElectronForegroundShadowApi);
  return {
    api,
    isBindingCurrent: input.isBindingCurrent ?? (() => true),
    refreshBearer: input.refreshBearer ?? (() => Promise.resolve("bearer")),
    sendRoomMessage: input.sendRoomMessage ?? (async () => ({ messageId: 1 })) as never,
    serverScope: "https://nautilo.test",
    userId: "user-1",
    humanActorId: "human-1",
    installationId: "installation-1",
    directory: "/tmp/nautilo-foreground-shadow-test",
    safeStorage,
    normalizeContent: (content: string) => content.trim(),
    factories: input.factories ?? factories(),
    ...(input.createId === undefined ? {} : { createId: input.createId }),
  };
}

describe("ElectronForegroundShadowController", () => {
  test("coalesces one Message backfill batch and aborts it without exposing content", async () => {
    const prioritized: unknown[] = [];
    const signals: AbortSignal[] = [];
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({ messageBackfill: {
        prioritize: (selection: unknown) => prioritized.push(selection),
        runBatch: ({ signal }: { signal: AbortSignal }) => {
          signals.push(signal);
          return new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              resolve({ state: "waiting", resumeAt: null });
            }, { once: true });
          });
        },
      } }),
    }));
    const urgent = { roomId: "room-1", messageId: 27, revision: 2 };

    const first = controller.serviceMessageBackfill(urgent);
    const reentered = controller.serviceMessageBackfill();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(prioritized).toEqual([urgent]);
    expect(signals).toHaveLength(1);

    controller.cancelMessageBackfill();
    expect(await first).toEqual({ state: "waiting", resumeAt: null });
    expect(await reentered).toEqual({ state: "waiting", resumeAt: null });
    expect(signals[0]?.aborted).toBe(true);
    await controller.dispose();
  });

  test("foreground custody preempts a hanging Message backfill transport", async () => {
    const calls: string[] = [];
    let batchSignal: AbortSignal | undefined;
    let batches = 0;
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({
        messageBackfill: {
          runBatch: ({signal}: {signal: AbortSignal}) => {
            batches += 1;
            batchSignal = signal;
            calls.push("backfill:start");
            if (batches > 1) {
              return Promise.resolve({state: "caught_up", resumeAt: null});
            }
            return new Promise((resolve) => {
              signal.addEventListener("abort", () => {
                calls.push("backfill:abort");
                resolve({state: "waiting", resumeAt: null});
              }, {once: true});
            });
          },
        },
        sender: {
          send: async () => {
            calls.push("send");
            return {messageId: 9};
          },
        },
      }),
    }));

    const backfill = controller.serviceMessageBackfill();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["backfill:start"]);

    const sent = controller.send("room-1", {content: "foreground"});
    expect(await sent).toEqual({messageId: 9});
    expect(await backfill).toMatchObject({state: "more"});
    expect(batchSignal?.aborted).toBe(true);
    expect(calls).toEqual(["backfill:start", "backfill:abort", "send"]);
    expect(await controller.serviceMessageBackfill()).toEqual({
      state: "caught_up", resumeAt: null,
    });
    expect(calls).toEqual([
      "backfill:start", "backfill:abort", "send", "backfill:start",
    ]);
    await controller.dispose();
  });

  test("coalesces background authorization on its independent authorization lane", async () => {
    const firstSweep = deferred();
    const foregroundSend = deferred();
    const calls: string[] = [];
    let sweeps = 0;
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({
        sender: {
          send: async () => {
            calls.push("send:start");
            await foregroundSend.promise;
            calls.push("send:end");
            return {messageId: 1};
          },
        },
        backgroundAuthorization: {
          service: async () => {
            sweeps += 1;
            calls.push(`sweep:${sweeps}:start`);
            if (sweeps === 1) await firstSweep.promise;
            calls.push(`sweep:${sweeps}:end`);
            return {status: "complete", pages: 1, discovered: 0,
              responded: 0, deferred: 0, stale: 0, invalid: 0};
          },
        },
      }),
    }));

    const send = controller.send("room-1", {content: "foreground"});
    const first = controller.serviceBackgroundAuthorization();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const reentered = controller.serviceBackgroundAuthorization();
    expect(calls).toEqual(["send:start", "sweep:1:start"]);

    firstSweep.resolve();
    await first;
    await reentered;
    expect(calls).toEqual([
      "send:start", "sweep:1:start", "sweep:1:end",
      "sweep:2:start", "sweep:2:end",
    ]);
    foregroundSend.resolve();
    await send;
    await controller.dispose();
  });

  test("aborts and drains background authorization before disposing custody", async () => {
    const calls: string[] = [];
    let serviceSignal: AbortSignal | undefined;
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({
        backgroundAuthorization: {
          service: ({signal}: {signal: AbortSignal}) => new Promise((_resolve, reject) => {
            calls.push("sweep:start");
            serviceSignal = signal;
            signal.addEventListener("abort", () => {
              calls.push("sweep:abort");
              reject(new DOMException("Aborted", "AbortError"));
            }, {once: true});
          }),
        },
        custodyDispose: async () => {
          calls.push("custody:dispose");
        },
      }),
    }));

    const sweeping = controller.serviceBackgroundAuthorization();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const dispose = controller.dispose();
    expect(serviceSignal?.aborted).toBe(true);
    expect(await rejected(sweeping)).toBeInstanceOf(DOMException);
    await dispose;
    expect(calls).toEqual(["sweep:start", "sweep:abort", "custody:dispose"]);
  });

  test("foreground history skips an already queued Message backfill batch", async () => {
    const occupied = deferred();
    const calls: string[] = [];
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({
        sender: {
          send: async () => {
            calls.push("send:start");
            await occupied.promise;
            calls.push("send:end");
            return {messageId: 1};
          },
        },
        messageBackfill: {
          runBatch: async () => {
            calls.push("backfill");
            return {state: "caught_up", resumeAt: null};
          },
        },
        historyReader: {
          reconcile: async () => {
            calls.push("history");
            return {records: [], eligibleCount: 0};
          },
        },
      }),
    }));

    const sent = controller.send("room-1", {content: "foreground"});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const backfill = controller.serviceMessageBackfill();
    const history = controller.reconcileHistory({} as never);
    occupied.resolve();

    await sent;
    expect(await backfill).toMatchObject({state: "more"});
    expect(await history).toEqual({records: [], eligibleCount: 0});
    expect(calls).toEqual(["send:start", "send:end", "history"]);
    await controller.dispose();
  });

  test("foreground send aborts a backfill policy read before custody starts", async () => {
    const calls: string[] = [];
    let policySignal: AbortSignal | undefined;
    const api = {
      setToken: () => undefined,
      admin: {encryptionTransition: {getPolicy: (
        options?: Readonly<{signal?: AbortSignal}>,
      ) => new Promise((_resolve, reject) => {
        calls.push("policy");
        policySignal = options?.signal;
        options?.signal?.addEventListener("abort", () => {
          calls.push("policy:abort");
          reject(new DOMException("Aborted", "AbortError"));
        }, {once: true});
      })}},
    } as unknown as ElectronForegroundShadowApi;
    const controller = createElectronForegroundShadowController(controllerInput({
      api,
      factories: factories({sender: {send: async () => {
        calls.push("send");
        return {messageId: 4};
      }}}),
    }));

    const backfill = controller.serviceMessageBackfill();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["policy"]);
    expect(await controller.send("room-1", {content: "foreground"}))
      .toEqual({messageId: 4});
    expect(await backfill).toMatchObject({state: "more"});
    expect(policySignal?.aborted).toBe(true);
    expect(calls).toEqual(["policy", "policy:abort", "send"]);
    await controller.dispose();
  });

  test("returns only sanitized opened Memory data from main custody", async () => {
    const projection = {
      memoryId: "11111111-1111-4111-8111-111111111111",
      contentRevision: 2,
      cryptoAccessRevision: 0,
      importance: 0.8,
      tier: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      namespaceIds: ["22222222-2222-4222-8222-222222222222"],
      requiredNamespaceIds: ["22222222-2222-4222-8222-222222222222"],
      readAuthorities: [],
    };
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({ humanMemory: {
        withList: async (_options: unknown, use: (value: unknown) => void) => {
          use({ representation: "ordinary_fallback", policyRevision: 9,
            projection, payload: {
            formatVersion: 1, type: "preference", content: "Private value",
          } });
          return { nextCursor: null, memoryMode: "namespace", total: 1 };
        },
        withDetail: async (_memoryId: string, use: (value: unknown) => void) => {
          use({ representation: "ordinary_fallback", policyRevision: 9,
            projection, payload: {
              formatVersion: 1, type: "preference", content: "Private value",
            } });
          return { memoryMode: "namespace", actionAuthority: {
            canEdit: true, canArchive: true, canManageAccess: true,
          } };
        },
      } }),
    }));
    const result = await controller.memoryList({});
    expect(result).toEqual({
      nextCursor: null,
      memoryMode: "namespace",
      total: 1,
      items: [{
        id: projection.memoryId,
        contentRevision: 2,
        importance: 0.8,
        tier: 1,
        createdAt: projection.createdAt,
        updatedAt: projection.updatedAt,
        namespaceIds: projection.namespaceIds,
        content: {
          status: "opened", representation: "ordinary_fallback",
          type: "preference", content: "Private value",
        },
      }],
    });
    expect(JSON.stringify(result)).not.toContain("ciphertext");
    expect(JSON.stringify(result)).not.toContain("signing");
    expect(await controller.memoryDetail(projection.memoryId)).toMatchObject({
      memory: { content: { representation: "ordinary_fallback",
        type: "preference", content: "Private value" } },
    });
    await controller.dispose();
  });
  test("serializes Memory custody and rejects it after the account binding changes", async () => {
    const first = deferred();
    const calls: string[] = [];
    let current = true;
    const controller = createElectronForegroundShadowController(controllerInput({
      isBindingCurrent: () => current,
      factories: factories({ humanMemory: {
        withList: async () => {
          calls.push("list:start");
          await first.promise;
          calls.push("list:end");
          return { nextCursor: null, memoryMode: "namespace" };
        },
        retryPendingMutations: async () => {
          calls.push("retry");
          return 1;
        },
      } }),
    }));
    const listed = controller.memoryList({});
    const retried = controller.memoryRetryPending();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["list:start"]);
    first.resolve();
    expect(await listed).toMatchObject({ items: [], memoryMode: "namespace" });
    expect(await retried).toBe(1);
    expect(calls).toEqual(["list:start", "list:end", "retry"]);
    current = false;
    expect(await rejected(controller.memoryRetryPending()))
      .toBeInstanceOf(ElectronForegroundShadowControllerUnavailableError);
    expect(calls).toHaveLength(3);
    await controller.dispose();
  });

  test("withholds a Memory result when policy changes during the operation", async () => {
    const started = deferred();
    const release = deferred();
    let revision = 1;
    let policyReads = 0;
    const api = {
      setToken: () => undefined,
      admin: { encryptionTransition: { getPolicy: async () => {
        policyReads += 1;
        return { policy: { mode: "shadow_encryption" as const,
          shadowBehavior: "fallback" as const, revision,
          updatedAt: "2026-09-01T00:00:00.000Z" } };
      } } },
      sendRoomMessage: async () => ({ messageId: 1 }),
    } as unknown as ElectronForegroundShadowApi;
    const controller = createElectronForegroundShadowController(controllerInput({
      api,
      factories: factories({ humanMemory: { withList: async () => {
        started.resolve();
        await release.promise;
        return { nextCursor: null, memoryMode: "namespace" };
      } } }),
    }));
    const pending = controller.memoryList({});
    await started.promise;
    revision = 2;
    release.resolve();
    expect(await rejected(pending)).toMatchObject({ failureClass: "cancelled" });
    expect(policyReads).toBe(2);
    await controller.dispose();
  });
  test("returns Memory data before observation delivery and drains it on the custody lane", async () => {
    const observation = deferred();
    const calls: string[] = [];
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({ humanMemory: {
        withList: async () => {
          calls.push("list");
          const page = { nextCursor: null, memoryMode: "namespace" as const };
          Object.defineProperty(page, "observationDelivery", {
            value: observation.promise,
          });
          return page;
        },
        retryPendingMutations: async () => {
          calls.push("retry");
          return 0;
        },
      } }),
    }));
    const page = await controller.memoryList({});
    expect(page).toEqual({ nextCursor: null, memoryMode: "namespace", items: [] });
    expect(page).not.toHaveProperty("observationDelivery");
    const retry = controller.memoryRetryPending();
    await Promise.resolve();
    expect(calls).toEqual(["list"]);
    observation.resolve();
    expect(await retry).toBe(0);
    expect(calls).toEqual(["list", "retry"]);
    await controller.dispose();
  });
  test("returns exact protected Memory metadata receipts", async () => {
    const controller = createElectronForegroundShadowController(controllerInput());
    expect(await controller.memoryArchive("memory-1")).toEqual({
      status: "archived", memoryId: "memory-1", tier: 3,
    });
    expect(await controller.memoryRestore("memory-1")).toEqual({
      status: "restored", memoryId: "memory-1", previousTier: 3, nextTier: 2,
    });
    expect(await controller.memoryTransitionTier("memory-1", "promote"))
      .toEqual({
        status: "promoted", memoryId: "memory-1", previousTier: 2, nextTier: 1,
      });
    expect(await controller.memoryGrantUser("memory-1", "alice")).toEqual({
      status: "updated", memoryId: "memory-1", userHandle: "alice",
    });
    expect(await controller.memoryRevokeUser("memory-1", "alice")).toEqual({
      status: "updated", memoryId: "memory-1", userHandle: "alice",
    });
    expect(await controller.memoryMakePrivate("memory-1")).toEqual({
      status: "updated", memoryId: "memory-1",
    });
    expect(await controller.memoryDeleteAuthorizedView("memory-1")).toEqual({
      status: "updated", memoryId: "memory-1",
    });
    await controller.dispose();
  });
  test("edits inside main custody and rejects stale account bindings", async () => {
    const seen: unknown[] = [];
    let current = true;
    const controller = createElectronForegroundShadowController(controllerInput({
      isBindingCurrent: () => current,
      factories: factories({ sender: { edit: async (...args: unknown[]) => {
        seen.push(args);
        return { content: "edited", editRevision: 1 };
      } } }),
    }));
    const body = { content: "edited", expectedRevision: 0 };
    expect(await controller.edit("room", "123", body)).toEqual({ content: "edited", editRevision: 1 });
    current = false;
    expect(await rejected(controller.edit("room", "123", body)))
      .toBeInstanceOf(ElectronForegroundShadowControllerUnavailableError);
    expect(seen).toEqual([["room", "123", body]]);
    await controller.dispose();
  });
  test("lets foreground authorization answer an in-flight send on its own serialized lane", async () => {
    const first = deferred();
    const calls: string[] = [];
    let refreshes = 0;
    const api = {
      setToken: (token: string | null) => calls.push(`token:${token}`),
    } as unknown as ElectronForegroundShadowApi;
    const testFactories = factories({
      sender: {
        send: async () => {
          calls.push("send:start");
          await first.promise;
          calls.push("send:end");
          return { messageId: 1 };
        },
        authorizeSharedAgentExecution: async () => {
          calls.push("authorize");
          return true;
        },
      },
    });
    const controller = createElectronForegroundShadowController(
      controllerInput({
        api,
        factories: testFactories,
        refreshBearer: () => {
          refreshes++;
          return Promise.resolve(`bearer-${refreshes}`);
        },
      }),
    );

    const sent = controller.send("room-1", { content: "hello" });
    const authorized = controller.authorizeSharedAgentExecution({
      type: "message.shared_agent_authorization_required",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await authorized).toBe(true);
    expect(refreshes).toBe(2);
    expect(calls).toEqual([
      "token:bearer-1",
      "send:start",
      "token:bearer-2",
      "authorize",
    ]);

    first.resolve();
    expect(await sent).toEqual({ messageId: 1 });
    expect(calls).toEqual([
      "token:bearer-1",
      "send:start",
      "token:bearer-2",
      "authorize",
      "send:end",
    ]);
  });

  test("routes every ordinary send through the injected origin-owned seam", async () => {
    const calls: string[] = [];
    const api = {
      setToken: (token: string | null) => calls.push(`token:${token}`),
      sendRoomMessage: () => {
        calls.push("raw-api-send");
        throw new Error("bypassed origin send");
      },
    } as unknown as ElectronForegroundShadowApi;
    const testFactories = factories();
    testFactories.createSender = ((input: ElectronLiveShadowMessageClientInput) => {
      return {
        deviceId: "device:electron:test",
        send: (roomId: string, body: Parameters<typeof input.api.sendRoomMessage>[1]) =>
          input.api.sendRoomMessage(roomId, body),
        recoverPending: async () => 0,
        completePending: async () => true,
        synchronizeHumanPeerRecipients: async () => true,
        authorizeSharedAgentExecution: async () => true,
      } as never;
    });
    const controller = createElectronForegroundShadowController(
      controllerInput({
        api,
        factories: testFactories,
        sendRoomMessage: async (roomId, body) => {
          calls.push(`origin:${roomId}:${body.content}`);
          return { messageId: 9 } as never;
        },
      }),
    );

    expect(await controller.send("room-9", { content: "safe" }))
      .toEqual({ messageId: 9 });
    expect(calls).toEqual(["token:bearer", "origin:room-9:safe"]);
  });

  test("keeps sender/causal callbacks inside main-owned custody", async () => {
    let senderInput: ElectronLiveShadowMessageClientInput | undefined;
    let receiverInput: ElectronLiveShadowMessageReceiverInput | undefined;
    const registered: unknown[] = [];
    const completed: string[] = [];
    const recoveryEvent = { type: "message.shadow_durable" };
    const verified = {
      operationId: "operation-1",
      planBytes: new Uint8Array([1]),
      ordinaryPayloadBytes: new Uint8Array([2]),
      protectedMessage: {},
    };
    const testFactories = factories({
      senderInput: (input) => {
        senderInput = input;
      },
      liveReceiverInput: (input) => {
        receiverInput = input;
      },
      sender: {
        send: async () => {
          await senderInput?.onHumanVerified?.(verified as never);
          return { messageId: 1 };
        },
        recoverPending: async () =>
          await senderInput?.onDurableRecovery?.(recoveryEvent) ? 1 : 0,
        completePending: async (operationId: string) => {
          completed.push(operationId);
          return true;
        },
      },
      liveReceiver: {
        registerHuman: async (input: unknown) => {
          registered.push(input);
        },
        receive: async () => ({
          status: "durable_verified",
          payload: { role: "assistant", content: "opened" },
          messageId: "1",
          assistantMessageKey: null,
          authorAgentId: "agent-1",
        }),
      },
    });
    const controller = createElectronForegroundShadowController(
      controllerInput({ factories: testFactories }),
    );

    await controller.send("room-1", { content: "human" });
    expect(registered).toEqual([verified]);
    expect(await controller.recoverPending()).toBe(1);
    await receiverInput?.onTerminalVerification?.("operation-1");
    expect(completed).toEqual(["operation-1"]);
  });

  test("keeps pending-attention custody in the main-owned sender", async () => {
    const calls: unknown[] = [];
    const controller = createElectronForegroundShadowController(controllerInput({
      factories: factories({ sender: {
        recoverRoomPendingAttention: async (input: unknown) => {
          calls.push(input);
          return { status: "ready", events: [{
            type: "approval.ask", userId: "user-1", laneKey: "room:room-1",
          }] };
        },
      } }),
    }));

    expect(await controller.recoverRoomPendingAttention({
      roomId: "room-1",
      clientActionSessionId: "session-1",
    })).toMatchObject({ status: "ready" });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Readonly<{
      roomId: string;
      clientActionSessionId: string;
      isCurrent: () => boolean;
    }>;
    expect(call).toMatchObject({
      roomId: "room-1",
      clientActionSessionId: "session-1",
    });
    expect(typeof call.isCurrent).toBe("function");
    expect(call.isCurrent()).toBeTrue();
  });

  test("routes receive, recipient, and history operations as public DTOs", async () => {
    const calls: string[] = [];
    const testFactories = factories({
      sender: {
        synchronizeHumanPeerRecipients: async (roomId: string, namespaceId: string) => {
          calls.push(`sync:${roomId}:${namespaceId}`);
          return true;
        },
        serviceDomainKeyBacklog: async () => {
          calls.push("backlog");
          return true;
        },
      },
      liveReceiver: {
        receive: async () => ({ status: "start_verified" }),
      },
      humanPeerReceiver: {
        receive: async () => ({ status: "verified", payload: { content: "peer" } }),
      },
      sharedAgentReceiver: {
        receive: async () => ({ status: "fallback", reason: "transport_unavailable" }),
      },
      sharedAgentOutputReceiver: {
        receive: async () => ({ status: "frame_verified", ordinaryChunk: "chunk" }),
      },
      historyReader: {
        readerDeviceId: "device:history",
        reconcile: async () => ({ records: [{ status: "verified" }], eligibleCount: 1 }),
        acknowledge: async () => "replayed",
      },
    });
    const controller = createElectronForegroundShadowController(
      controllerInput({
        factories: testFactories,
        createId: () => "request-key",
      }),
    );

    expect(await controller.synchronizeHumanPeerRecipients("room", "namespace"))
      .toBe(true);
    expect(await controller.serviceDomainKeyBacklog()).toBe(true);
    expect(await controller.receiveLive({ type: "start" }))
      .toEqual({ status: "start_verified" });
    expect(await controller.receiveHumanPeer({}, { role: "user", content: "ordinary" }))
      .toEqual({ status: "verified", payload: { content: "peer" } });
    expect(await controller.receiveSharedAgent({}, { role: "user", content: "ordinary" }))
      .toEqual({ status: "fallback", reason: "transport_unavailable" });
    expect(await controller.receiveSharedAgentOutput({}))
      .toEqual({ status: "frame_verified", ordinaryChunk: "chunk" });
    expect(await controller.reconcileHistory({} as never)).toEqual({
      records: [{ status: "verified" }],
      eligibleCount: 1,
    });
    expect(await controller.acknowledgeHistory({} as never)).toBe("replayed");
    expect(calls).toEqual(["sync:room:namespace", "backlog"]);
  });

  test("fails closed without a bearer before touching a client", async () => {
    let sends = 0;
    const tokens: Array<string | null> = [];
    const api = {
      setToken: (token: string | null) => tokens.push(token),
    } as unknown as ElectronForegroundShadowApi;
    const controller = createElectronForegroundShadowController(
      controllerInput({
        api,
        refreshBearer: () => Promise.resolve(null),
        factories: factories({
          sender: {
            send: async () => {
              sends++;
              return { messageId: 1 };
            },
          },
        }),
      }),
    );

    expect(await rejected(controller.send("room", { content: "private" })))
      .toBeInstanceOf(ElectronForegroundShadowControllerUnavailableError);
    expect(tokens).toEqual([null]);
    expect(sends).toBe(0);
  });

  test("rechecks the bound sender/session before refreshing or touching custody", async () => {
    let refreshes = 0;
    let sends = 0;
    const controller = createElectronForegroundShadowController(
      controllerInput({
        isBindingCurrent: () => false,
        refreshBearer: () => {
          refreshes++;
          return Promise.resolve("bearer");
        },
        factories: factories({
          sender: {
            send: async () => {
              sends++;
              return { messageId: 1 };
            },
          },
        }),
      }),
    );

    expect(await rejected(controller.send("room", { content: "private" })))
      .toBeInstanceOf(ElectronForegroundShadowControllerUnavailableError);
    expect(refreshes).toBe(0);
    expect(sends).toBe(0);
  });

  test("disposes stateful receivers after in-flight work and rejects queued work", async () => {
    const inFlight = deferred();
    const destroyed: string[] = [];
    const controller = createElectronForegroundShadowController(
      controllerInput({
        factories: factories({
          sender: {
            send: async () => {
              await inFlight.promise;
              return { messageId: 1 };
            },
          },
          liveReceiver: {
            destroy: () => destroyed.push("live"),
          },
          sharedAgentOutputReceiver: {
            destroy: () => destroyed.push("shared-output"),
          },
          custodyDispose: () => {
            destroyed.push("custody");
            return Promise.resolve();
          },
        }),
      }),
    );

    const send = controller.send("room", { content: "hello" });
    await Promise.resolve();
    const dispose = controller.dispose();
    expect(controller.dispose()).toBe(dispose);
    expect(await rejected(controller.recoverPending()))
      .toBeInstanceOf(ElectronForegroundShadowControllerUnavailableError);
    expect(destroyed).toEqual([]);
    inFlight.resolve();
    await send;
    await dispose;
    expect(destroyed).toEqual(["live", "shared-output", "custody"]);
  });
});
