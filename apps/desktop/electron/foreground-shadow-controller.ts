import type { NautiloApiClient, ProtectedMemoryProjectionV1 } from "@nautilo/api-client";
import { bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError } from "@nautilo/lattice-bridge";
import {
  createElectronHumanPeerLiveShadowMessageReceiver,
  createElectronBackgroundAuthorizationClientV2,
  createElectronForegroundShadowCustody,
  createElectronLiveShadowMessageClient,
  createElectronLiveShadowMessageReceiver,
  createElectronHumanMemoryClient,
  createElectronMessageBackfillClient,
  createElectronRoomHistoryShadowMessageReader,
  createElectronSharedAgentLiveShadowMessageReceiver,
  createElectronSharedAgentOutputLiveShadowReceiver,
  type ElectronHumanPeerLiveShadowMessageReceiverInput,
  type ElectronBackgroundAuthorizationClientInput,
  type ElectronForegroundShadowCustody,
  type ElectronLiveShadowMessageClientInput,
  type ElectronLiveShadowMessageReceiverInput,
  type ElectronHumanMemoryClientInput,
  type ElectronMessageBackfillClientInput,
  type ElectronRoomHistoryShadowAcknowledgementInput,
  type ElectronRoomHistoryShadowMessageReaderInput,
  type ElectronSafeStoragePort,
  type ProtectedRoomAccessStateV2,
  type ElectronSharedAgentLiveShadowMessageReceiverInput,
  type ElectronSharedAgentOutputLiveShadowReceiverInput,
} from "@nautilo/lattice-bridge/client/electron";
import {
  createCoalescedBackgroundAuthorizationSweepV2,
  type CoalescedBackgroundAuthorizationSweepV2,
} from "@nautilo/lattice-bridge/client/background";

type LiveShadowSender = ReturnType<
  typeof createElectronLiveShadowMessageClient
>;
type LiveShadowReceiver = ReturnType<
  typeof createElectronLiveShadowMessageReceiver
>;
type HumanPeerReceiver = ReturnType<
  typeof createElectronHumanPeerLiveShadowMessageReceiver
>;
type SharedAgentReceiver = ReturnType<
  typeof createElectronSharedAgentLiveShadowMessageReceiver
>;
type SharedAgentOutputReceiver = ReturnType<
  typeof createElectronSharedAgentOutputLiveShadowReceiver
>;
type RoomHistoryReader = ReturnType<
  typeof createElectronRoomHistoryShadowMessageReader
>;
type HumanMemoryClient = ReturnType<typeof createElectronHumanMemoryClient>;
type MessageBackfillClient = ReturnType<
  typeof createElectronMessageBackfillClient
>;
type BackgroundAuthorizationClient = ReturnType<
  typeof createElectronBackgroundAuthorizationClientV2
>;

function openedMemory(opened: Parameters<Parameters<HumanMemoryClient["withList"]>[1]>[0]) {
  const projection = opened.projection;
  return Object.freeze({
    id: projection.memoryId,
    contentRevision: projection.contentRevision,
    importance: projection.importance,
    tier: projection.tier,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    namespaceIds: Object.freeze([...projection.namespaceIds]),
    ...(projection.accessList === undefined ? {} : {
      accessList: Object.freeze(projection.accessList.map((entry) =>
        Object.freeze({ ...entry })
      )),
    }),
    content: Object.freeze({
      status: "opened" as const,
      representation: opened.representation,
      type: opened.payload.type,
      content: opened.payload.content,
    }),
  });
}

function protectedOpenedMemory(
  opened: Parameters<HumanMemoryClient["update"]>[2] extends
    ((value: infer Value) => unknown) ? Value : never,
) {
  return openedMemory(Object.freeze({ ...opened, representation: "protected" }));
}

function unavailableMemory(projection: ProtectedMemoryProjectionV1, reason: string) {
  return Object.freeze({
    id: projection.memoryId,
    contentRevision: projection.contentRevision,
    importance: projection.importance,
    tier: projection.tier,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    namespaceIds: Object.freeze([...projection.namespaceIds]),
    ...(projection.accessList === undefined ? {} : {
      accessList: Object.freeze(projection.accessList.map((entry) =>
        Object.freeze({ ...entry })
      )),
    }),
    content: Object.freeze({ status: "unavailable" as const, reason }),
  });
}

export type ElectronForegroundShadowApi =
  ElectronLiveShadowMessageClientInput["api"]
  & ElectronLiveShadowMessageReceiverInput["api"]
  & ElectronHumanPeerLiveShadowMessageReceiverInput["api"]
  & ElectronSharedAgentLiveShadowMessageReceiverInput["api"]
  & ElectronSharedAgentOutputLiveShadowReceiverInput["api"]
  & ElectronRoomHistoryShadowMessageReaderInput["api"]
  & ElectronMessageBackfillClientInput["api"]
  & ElectronHumanMemoryClientInput["api"]
  & ElectronBackgroundAuthorizationClientInput["api"]
  & Pick<NautiloApiClient, "setToken">
  & Readonly<{ admin: Pick<NautiloApiClient["admin"], "encryptionTransition"> }>;

type SendRoomMessage = ElectronLiveShadowMessageClientInput["api"][
  "sendRoomMessage"
];

export interface ElectronForegroundShadowControllerFactories {
  createCustody(input: Readonly<{
    directory: string;
    safeStorage: ElectronSafeStoragePort;
  }>): ElectronForegroundShadowCustody;
  createSender(input: ElectronLiveShadowMessageClientInput): LiveShadowSender;
  createLiveReceiver(
    input: ElectronLiveShadowMessageReceiverInput,
  ): LiveShadowReceiver;
  createHumanPeerReceiver(
    input: ElectronHumanPeerLiveShadowMessageReceiverInput,
  ): HumanPeerReceiver;
  createSharedAgentReceiver(
    input: ElectronSharedAgentLiveShadowMessageReceiverInput,
  ): SharedAgentReceiver;
  createSharedAgentOutputReceiver(
    input: ElectronSharedAgentOutputLiveShadowReceiverInput,
  ): SharedAgentOutputReceiver;
  createHistoryReader(
    input: ElectronRoomHistoryShadowMessageReaderInput,
  ): RoomHistoryReader;
  createHumanMemory(input: ElectronHumanMemoryClientInput): HumanMemoryClient;
  createMessageBackfill(
    input: ElectronMessageBackfillClientInput,
  ): MessageBackfillClient;
  createBackgroundAuthorization(
    input: ElectronBackgroundAuthorizationClientInput,
  ): BackgroundAuthorizationClient;
}

const productionFactories: ElectronForegroundShadowControllerFactories =
  Object.freeze({
    createCustody: createElectronForegroundShadowCustody,
    createSender: createElectronLiveShadowMessageClient,
    createLiveReceiver: createElectronLiveShadowMessageReceiver,
    createHumanPeerReceiver:
      createElectronHumanPeerLiveShadowMessageReceiver,
    createSharedAgentReceiver:
      createElectronSharedAgentLiveShadowMessageReceiver,
    createSharedAgentOutputReceiver:
      createElectronSharedAgentOutputLiveShadowReceiver,
    createHistoryReader: createElectronRoomHistoryShadowMessageReader,
    createHumanMemory: createElectronHumanMemoryClient,
    createMessageBackfill: createElectronMessageBackfillClient,
    createBackgroundAuthorization:
      createElectronBackgroundAuthorizationClientV2,
  });

export interface ElectronForegroundShadowControllerInput {
  readonly api: ElectronForegroundShadowApi;
  /** Rechecks sender/session/account binding after this operation reaches the queue head. */
  readonly isBindingCurrent: () => boolean | Promise<boolean>;
  readonly isAccountCurrent?: () => boolean | Promise<boolean>;
  readonly refreshBearer: () => Promise<string | null>;
  /**
   * The one Desktop ordinary-send seam. It must normalize once, mint the
   * Electron-origin credential when available, and make at most one POST.
   */
  readonly sendRoomMessage: SendRoomMessage;
  readonly serverScope: string;
  readonly userId: string;
  readonly humanActorId: string;
  readonly installationId: string;
  readonly directory: string;
  readonly safeStorage: ElectronSafeStoragePort;
  readonly normalizeContent: (content: string) => string;
  readonly createId?: () => string;
  readonly onProtectedRoomAccessState?: (
    state: ProtectedRoomAccessStateV2,
  ) => void;
  readonly factories?: ElectronForegroundShadowControllerFactories;
}

export class ElectronForegroundShadowControllerUnavailableError extends Error {
  readonly code = "foreground_shadow_unavailable" as const;

  constructor() {
    super("Desktop foreground encryption is unavailable.");
    this.name = "ElectronForegroundShadowControllerUnavailableError";
  }
}

/**
 * Electron-main owner for one exact server/account/device foreground session.
 *
 * The controller deliberately exposes only product DTOs and content-free
 * coordinates. Private profile, Namespace, Grant, and signing bytes remain in
 * the lattice clients captured below and are never part of a public result.
 */
export class ElectronForegroundShadowController {
  readonly deviceId: string;

  readonly #api: ElectronForegroundShadowApi;
  readonly #isBindingCurrent: () => boolean | Promise<boolean>;
  readonly #isAccountCurrent: (() => boolean | Promise<boolean>) | undefined;
  readonly #refreshBearer: () => Promise<string | null>;
  readonly #sender: LiveShadowSender;
  readonly #custody: ElectronForegroundShadowCustody;
  readonly #liveReceiver: LiveShadowReceiver;
  readonly #humanPeerReceiver: HumanPeerReceiver;
  readonly #sharedAgentReceiver: SharedAgentReceiver;
  readonly #sharedAgentOutputReceiver: SharedAgentOutputReceiver;
  readonly #historyReader: RoomHistoryReader;
  readonly #humanMemory: HumanMemoryClient;
  readonly #messageBackfill: MessageBackfillClient;
  readonly #backgroundAuthorization: BackgroundAuthorizationClient;
  readonly #backgroundAuthorizationSweeps:
    CoalescedBackgroundAuthorizationSweepV2;
  readonly #backgroundAuthorizationAbort = new AbortController();
  readonly #createId: () => string;
  #tail: Promise<void> = Promise.resolve();
  #authorizationTail: Promise<void> = Promise.resolve();
  #memoryPolicyEpoch = 0;
  #activeMemoryPolicy: Readonly<{ mode: "plaintext_only" | "shadow_encryption"
    | "encrypted_only"; shadowBehavior: "fallback" | "strict";
    revision: number; epoch: number }> | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #messageBackfillAbort: AbortController | undefined;
  #messageBackfillResumeAfterAbort: AbortController | undefined;
  #messageBackfillRequest: Promise<Awaited<
    ReturnType<MessageBackfillClient["runBatch"]>
  >> | undefined;

  constructor(input: ElectronForegroundShadowControllerInput) {
    this.#api = input.api;
    this.#isBindingCurrent = input.isBindingCurrent;
    this.#isAccountCurrent = input.isAccountCurrent;
    this.#refreshBearer = input.refreshBearer;
    this.#createId = input.createId ?? (() => globalThis.crypto.randomUUID());
    const factories = input.factories ?? productionFactories;
    this.#custody = factories.createCustody({
      directory: input.directory,
      safeStorage: input.safeStorage,
    });

    const api = new Proxy(input.api, {
      get(target, property, receiver): unknown {
        if (property === "sendRoomMessage") return input.sendRoomMessage;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => {
            const result: unknown = Reflect.apply(value, target, args);
            return result;
          }
          : value;
      },
    });

    const clientInput = Object.freeze({
      api,
      serverScope: input.serverScope,
      userId: input.userId,
      humanActorId: input.humanActorId,
      installationId: input.installationId,
      foregroundCustody: this.#custody,
      createIdempotencyKey: this.#createId,
      ...(input.onProtectedRoomAccessState === undefined
        ? {}
        : { onProtectedRoomAccessState: input.onProtectedRoomAccessState }),
    });

    const senderRef: { current: LiveShadowSender | undefined } = {
      current: undefined,
    };
    this.#liveReceiver = factories.createLiveReceiver({
      ...clientInput,
      onTerminalVerification: async (operationId) => {
        await senderRef.current?.completePending(operationId);
      },
    });
    const sender = factories.createSender({
      ...clientInput,
      normalizeContent: input.normalizeContent,
      onHumanVerified: (verified) =>
        this.#liveReceiver.registerHuman(verified),
      onDurableRecovery: async (event) =>
        (await this.#liveReceiver.receive(event)).status === "durable_verified",
    });
    senderRef.current = sender;
    this.#sender = sender;
    this.#humanPeerReceiver = factories.createHumanPeerReceiver(clientInput);
    this.#sharedAgentReceiver = factories.createSharedAgentReceiver(clientInput);
    this.#sharedAgentOutputReceiver =
      factories.createSharedAgentOutputReceiver(clientInput);
    this.#historyReader = factories.createHistoryReader(clientInput);
    const dataOperationOwner = bindEncryptionDataOperationOwner({ policy: {
        resolve: () => {
          const current = this.#activeMemoryPolicy;
          return current === undefined
            ? Promise.reject(new ClassifiedDataOperationError(
                "cancelled", "Desktop encryption operation admission is unavailable",
              ))
            : Promise.resolve({ policy: current, revalidationToken: current.epoch });
        },
        revalidate: async (epoch) => {
          if (this.#activeMemoryPolicy?.epoch !== epoch
            || !await this.#isBindingCurrent()) throw new ClassifiedDataOperationError(
            "cancelled", "Encryption policy changed during Desktop operation",
          );
        },
      } });
    this.#humanMemory = factories.createHumanMemory({
      ...clientInput,
      dataOperationOwner,
      resolveDeviceAdmissionStatus: () => api.deviceAdmission.status(),
    });
    this.#messageBackfill = factories.createMessageBackfill({
      ...clientInput,
      dataOperationOwner,
    });
    this.#backgroundAuthorization = factories.createBackgroundAuthorization(
      clientInput,
    );
    this.#backgroundAuthorizationSweeps =
      createCoalescedBackgroundAuthorizationSweepV2({
        signal: this.#backgroundAuthorizationAbort.signal,
        sweep: () => this.#run(
          () => this.#backgroundAuthorization.service({
            signal: this.#backgroundAuthorizationAbort.signal,
          }),
          "authorization",
          { signal: this.#backgroundAuthorizationAbort.signal },
        ),
      });
    this.deviceId = sender.deviceId;
  }

  send(
    roomId: Parameters<LiveShadowSender["send"]>[0],
    body: Parameters<LiveShadowSender["send"]>[1],
  ): ReturnType<LiveShadowSender["send"]> {
    return this.#run(() => this.#sender.send(roomId, body));
  }

  recoverPending(): ReturnType<LiveShadowSender["recoverPending"]> {
    return this.#run(() => this.#sender.recoverPending());
  }

  recoverRoomPendingAttention(input: Readonly<{
    roomId: string;
    clientActionSessionId: string;
  }>): ReturnType<LiveShadowSender["recoverRoomPendingAttention"]> {
    return this.#run(() => this.#sender.recoverRoomPendingAttention({
      ...input,
      isCurrent: () => !this.#disposed,
    }));
  }

  edit(
    roomId: string,
    messageId: string,
    body: Readonly<{ content: string; expectedRevision: number }>,
  ): Promise<Readonly<{ content: string; editRevision: number }>> {
    return this.#run(() => this.#sender.edit(roomId, messageId, body));
  }

  authorizeSharedAgentExecution(
    event: Parameters<LiveShadowSender["authorizeSharedAgentExecution"]>[0],
  ): ReturnType<LiveShadowSender["authorizeSharedAgentExecution"]> {
    // The ordinary send may remain open while the server asks this same
    // foreground device to authorize its Runtime invocation. Authorizations
    // therefore need their own serialized lane: putting them behind `send`
    // creates a send -> server challenge -> queued authorization deadlock.
    return this.#run(
      () => this.#sender.authorizeSharedAgentExecution(event),
      "authorization",
    );
  }

  /** Runs one coalesced, full durable-work discovery pass. */
  serviceBackgroundAuthorization(): Promise<void> {
    return this.#backgroundAuthorizationSweeps.request();
  }

  synchronizeHumanPeerRecipients(
    roomId: Parameters<
      LiveShadowSender["synchronizeHumanPeerRecipients"]
    >[0],
    namespaceId: Parameters<
      LiveShadowSender["synchronizeHumanPeerRecipients"]
    >[1],
  ): ReturnType<LiveShadowSender["synchronizeHumanPeerRecipients"]> {
    return this.#run(() =>
      this.#sender.synchronizeHumanPeerRecipients(roomId, namespaceId)
    );
  }

  serviceDomainKeyRequests(
    roomId: Parameters<LiveShadowSender["serviceDomainKeyRequests"]>[0],
    namespaceId: Parameters<LiveShadowSender["serviceDomainKeyRequests"]>[1],
    keyClass: Parameters<LiveShadowSender["serviceDomainKeyRequests"]>[2],
  ): ReturnType<LiveShadowSender["serviceDomainKeyRequests"]> {
    return this.#run(() =>
      this.#sender.serviceDomainKeyRequests(roomId, namespaceId, keyClass)
    );
  }

  serviceDomainKeyBacklog(): ReturnType<LiveShadowSender["serviceDomainKeyBacklog"]> {
    return this.#run(() => this.#sender.serviceDomainKeyBacklog());
  }

  receiveLive(
    event: Parameters<LiveShadowReceiver["receive"]>[0],
  ): ReturnType<LiveShadowReceiver["receive"]> {
    return this.#run(() => this.#liveReceiver.receive(event));
  }

  receiveHumanPeer(
    event: Parameters<HumanPeerReceiver["receive"]>[0],
    ordinarySibling: Parameters<HumanPeerReceiver["receive"]>[1],
  ): ReturnType<HumanPeerReceiver["receive"]> {
    return this.#run(() =>
      this.#humanPeerReceiver.receive(event, ordinarySibling)
    );
  }

  receiveSharedAgent(
    event: Parameters<SharedAgentReceiver["receive"]>[0],
    ordinarySibling: Parameters<SharedAgentReceiver["receive"]>[1],
  ): ReturnType<SharedAgentReceiver["receive"]> {
    return this.#run(() =>
      this.#sharedAgentReceiver.receive(event, ordinarySibling)
    );
  }

  receiveSharedAgentOutput(
    event: Parameters<SharedAgentOutputReceiver["receive"]>[0],
  ): ReturnType<SharedAgentOutputReceiver["receive"]> {
    return this.#run(() => this.#sharedAgentOutputReceiver.receive(event));
  }

  reconcileHistory(
    input: Parameters<RoomHistoryReader["reconcile"]>[0],
  ): ReturnType<RoomHistoryReader["reconcile"]> {
    return this.#run(() => this.#historyReader.reconcile(input));
  }

  acknowledgeHistory(
    input: ElectronRoomHistoryShadowAcknowledgementInput,
  ): ReturnType<RoomHistoryReader["acknowledge"]> {
    return this.#run(() => this.#historyReader.acknowledge(input));
  }

  serviceMessageBackfill(
    urgent?: Parameters<MessageBackfillClient["prioritize"]>[0],
  ): Promise<Awaited<ReturnType<MessageBackfillClient["runBatch"]>>> {
    if (urgent !== undefined) this.#messageBackfill.prioritize(urgent);
    if (this.#messageBackfillRequest !== undefined) {
      return this.#messageBackfillRequest;
    }
    const abort = new AbortController();
    this.#messageBackfillAbort = abort;
    const request = this.#runMemory(
      () => this.#messageBackfill.runBatch({ signal: abort.signal }),
      {signal: abort.signal, preemptMessageBackfill: false},
    ).catch((error: unknown) => {
      if (abort.signal.aborted) {
        return this.#messageBackfillResumeAfterAbort === abort
          ? {state: "more" as const, resumeAt: Date.now()}
          : {state: "waiting" as const, resumeAt: null};
      }
      throw error;
    }).finally(() => {
      if (this.#messageBackfillAbort === abort) {
        this.#messageBackfillAbort = undefined;
      }
      if (this.#messageBackfillResumeAfterAbort === abort) {
        this.#messageBackfillResumeAfterAbort = undefined;
      }
      if (this.#messageBackfillRequest === request) {
        this.#messageBackfillRequest = undefined;
      }
    });
    this.#messageBackfillRequest = request;
    return request;
  }

  cancelMessageBackfill(): void {
    this.#messageBackfillAbort?.abort();
  }

  #preemptMessageBackfill(): void {
    const abort = this.#messageBackfillAbort;
    if (abort === undefined) return;
    this.#messageBackfillResumeAfterAbort = abort;
    abort.abort();
  }

  memoryList(options: Parameters<HumanMemoryClient["withList"]>[0]) {
    return this.#runMemoryObserved(async () => {
      const items: unknown[] = [];
      const page = await this.#humanMemory.withList(options, (opened) => {
        items.push(openedMemory(opened));
      }, ({ projection, reason }) => {
        items.push(unavailableMemory(projection, reason));
      });
      return Object.freeze({ ...page, items: Object.freeze(items),
        ...(page.observationDelivery === undefined ? {} : {
          observationDelivery: page.observationDelivery,
        }) });
    });
  }

  memorySearch(options: Parameters<HumanMemoryClient["withSearch"]>[0]) {
    return this.#runMemoryObserved(async () => {
      const items: unknown[] = [];
      const page = await this.#humanMemory.withSearch(options, (opened, score) => {
        items.push(Object.freeze({ ...openedMemory(opened), score }));
      }, ({ projection, reason, score }) => {
        items.push(Object.freeze({ ...unavailableMemory(projection, reason), score }));
      });
      return Object.freeze({ ...page, items: Object.freeze(items),
        ...(page.observationDelivery === undefined ? {} : {
          observationDelivery: page.observationDelivery,
        }) });
    });
  }

  memoryDetail(memoryId: string) {
    return this.#runMemoryObserved(async () => {
      let item: unknown;
      const detail = await this.#humanMemory.withDetail(memoryId, (opened) => {
        item = openedMemory(opened);
      });
      if (item === undefined) throw new TypeError("Protected Memory detail did not open");
      return Object.freeze({ ...detail, memory: item,
        ...(detail.observationDelivery === undefined ? {} : {
          observationDelivery: detail.observationDelivery,
        }) });
    });
  }

  memoryUpdate(input: Readonly<{
    memoryId: string;
    type: string;
    content: string;
    importance: number;
  }>) {
    return this.#runMemory(async () => {
      const recipient = await this.#api.getMemoryProcessorRecipient();
      if (recipient.embedding === undefined) {
        throw new TypeError("Memory embedding is unavailable");
      }
      let item: unknown;
      const receipt = await this.#humanMemory.update(input.memoryId, {
        payload: { formatVersion: 1, type: input.type, content: input.content },
        importance: input.importance,
        requestedProvider: recipient.embedding.provider,
        requestedModel: recipient.embedding.model,
      }, (opened) => {
        item = protectedOpenedMemory(opened);
      });
      if (receipt.status === "ordinary_fallback") return receipt;
      if (item === undefined) throw new TypeError("Protected Memory update did not reopen");
      return Object.freeze({ ...receipt, memory: item });
    });
  }

  memoryRetryPending(): Promise<number> {
    return this.#runMemory(() => this.#humanMemory.retryPendingMutations());
  }

  memoryArchive(memoryId: string) {
    return this.#runMemory(() => this.#humanMemory.archive(memoryId));
  }

  memoryRestore(memoryId: string) {
    return this.#runMemory(() => this.#humanMemory.restore(memoryId));
  }

  memoryTransitionTier(memoryId: string, action: "promote" | "demote") {
    return this.#runMemory(() => this.#humanMemory.transitionTier(memoryId, action));
  }

  memoryDeleteAuthorizedView(memoryId: string) {
    return this.#runMemory(() => this.#humanMemory.deleteAuthorizedView(memoryId));
  }

  memoryGrantUser(memoryId: string, userHandle: string) {
    return this.#runMemory(() => this.#humanMemory.grantUser(memoryId, userHandle));
  }

  memoryRevokeUser(memoryId: string, userHandle: string) {
    return this.#runMemory(() => this.#humanMemory.revokeUser(memoryId, userHandle));
  }

  memoryMakePrivate(memoryId: string) {
    return this.#runMemory(() => this.#humanMemory.makePrivate(memoryId));
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.cancelMessageBackfill();
    this.#backgroundAuthorizationAbort.abort();
    const dispose = Promise.all([
      this.#tail,
      this.#authorizationTail,
      this.#backgroundAuthorizationSweeps.idle().catch(() => undefined),
    ]).then(async () => {
      const failures: unknown[] = [];
      for (const destroy of [
        () => this.#liveReceiver.destroy(),
        () => this.#sharedAgentOutputReceiver.destroy(),
      ]) {
        try {
          destroy();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await this.#custody.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Desktop foreground encryption disposal failed",
        );
      }
    });
    this.#tail = dispose.then(() => undefined, () => undefined);
    this.#disposePromise = dispose;
    return dispose;
  }

  #run<Result>(
    operation: () => Promise<Result>,
    lane: "custody" | "authorization" = "custody",
    options: Readonly<{
      signal?: AbortSignal;
      preemptMessageBackfill?: boolean;
    }> = {},
  ): Promise<Result> {
    if (options.preemptMessageBackfill !== false) {
      this.#preemptMessageBackfill();
    }
    if (this.#disposed) {
      return Promise.reject(
        new ElectronForegroundShadowControllerUnavailableError(),
      );
    }
    const run = async (): Promise<Result> => {
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (this.#disposed) {
        throw new ElectronForegroundShadowControllerUnavailableError();
      }
      let bindingCurrent: boolean;
      try {
        bindingCurrent = await this.#isBindingCurrent();
      } catch {
        throw new ElectronForegroundShadowControllerUnavailableError();
      }
      if (!bindingCurrent) {
        throw new ElectronForegroundShadowControllerUnavailableError();
      }
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let bearer: string | null;
      try {
        bearer = await this.#refreshBearer();
      } catch {
        throw new ElectronForegroundShadowControllerUnavailableError();
      }
      if (bearer === null || bearer.length === 0) {
        this.#api.setToken(null);
        throw new ElectronForegroundShadowControllerUnavailableError();
      }
      this.#api.setToken(bearer);
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (this.#isAccountCurrent !== undefined) {
        try {
          bindingCurrent = await this.#isAccountCurrent();
        } catch {
          throw new ElectronForegroundShadowControllerUnavailableError();
        }
        if (!bindingCurrent) {
          throw new ElectronForegroundShadowControllerUnavailableError();
        }
      }
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return operation();
    };
    const tail = lane === "authorization"
      ? this.#authorizationTail
      : this.#tail;
    const result = tail.then(run, run);
    const settled = result.then(() => undefined, () => undefined);
    if (lane === "authorization") {
      this.#authorizationTail = settled;
    } else {
      this.#tail = settled;
    }
    return result;
  }

  #runMemory<Result>(
    operation: () => Promise<Result>,
    options: Readonly<{
      signal?: AbortSignal;
      preemptMessageBackfill?: boolean;
    }> = {},
  ): Promise<Result> {
    return this.#run(async () => {
      const status = await this.#api.admin.encryptionTransition.getPolicy(
        options.signal === undefined ? undefined : {signal: options.signal},
      );
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const epoch = ++this.#memoryPolicyEpoch;
      this.#activeMemoryPolicy = Object.freeze({
        mode: status.policy.mode,
        shadowBehavior: status.policy.shadowBehavior,
        revision: status.policy.revision,
        epoch,
      });
      try {
        const result = await operation();
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const current = await this.#api.admin.encryptionTransition.getPolicy(
          options.signal === undefined ? undefined : {signal: options.signal},
        );
        if (current.policy.revision !== status.policy.revision
          || !await this.#isBindingCurrent()) {
          throw new ClassifiedDataOperationError(
            "cancelled", "Encryption policy changed during Memory operation",
          );
        }
        return result;
      } finally {
        if (this.#activeMemoryPolicy?.epoch === epoch) {
          this.#activeMemoryPolicy = undefined;
        }
      }
    }, "custody", options);
  }

  #runMemoryObserved<Result extends Readonly<{
    observationDelivery?: Promise<void>;
  }>>(operation: () => Promise<Result>): Promise<Omit<Result, "observationDelivery">> {
    const result = this.#runMemory(operation);
    this.#tail = result.then(async (value) => {
      await value.observationDelivery;
    }, () => undefined);
    return result.then((value) => {
      const { observationDelivery: _observationDelivery, ...product } = value;
      return product;
    });
  }
}

export function createElectronForegroundShadowController(
  input: ElectronForegroundShadowControllerInput,
): ElectronForegroundShadowController {
  return new ElectronForegroundShadowController(input);
}
