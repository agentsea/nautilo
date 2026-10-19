import { randomUUID } from "node:crypto";
import type { BolterAttachmentPayload } from "@nautilo/types";
import { BolterCliClient, type BolterCliConversationsOutcome, type BolterCliDiscoveryOutcome, type BolterCliIdentityOutcome, type BolterCliSendOutcome } from "./cli-client";
import { createBolterLoginInvocation, createBolterReceiveInvocation, decodeBolterReceiveBatch, validateBolterReceipt,
  type BolterCliAuthLink, type BolterCliBinding, type BolterCliRuntime, type BolterCliSelection,
  type BolterQualifiedDecoders, type BolterCliReceiveItem, type BolterCliInvocation } from "./cli-contract";
import { createBolterHandoverServer, type BolterHandoverServer } from "./handover";
import { BolterNativeProcessOwner, hasBolterNativeQualification, type BolterNativeChild,
  type BolterNativeQualification, type BolterNativeSpawn } from "./native-process";
import type { BolterSpoolScope, BolterSpoolReceipt, BolterSpoolBatch } from "./inbox-spool";

export interface BolterConnectionSpool {
  store(jsonl: string): Promise<BolterSpoolReceipt>;
  pending(): Promise<readonly string[]>;
  read(id: string): Promise<BolterSpoolBatch>;
  acknowledge(receipt: BolterSpoolReceipt): Promise<void>;
}
export type BolterNativeConnectionState = "unavailable" | "connected" | "receiver-running" | "retired";
export type BolterNativeLoginOutcome = { status: "awaiting-identity-confirmation" }
  | { status: "unavailable"; reason: "unsupported-output" | "execution-failed" | "stale-authority" };

/** Electron-local connection owner; transport and semantic admission are injected by their owners. */
export class BolterConnectionOwner {
  readonly generation = randomUUID();
  readonly scope: BolterSpoolScope;
  private readonly runtime: BolterCliRuntime;
  private selection: Readonly<BolterCliSelection> | null;
  private readonly decoders: BolterQualifiedDecoders | undefined;
  private readonly qualification: BolterNativeQualification | undefined;
  private readonly native: BolterNativeProcessOwner;
  private readonly client: BolterCliClient;
  private stateValue: BolterNativeConnectionState = "unavailable";
  private confirmed = false;
  private retired = false;
  private receiver: BolterNativeChild | null = null;
  private receiverRevision = 0;
  private receiverReady = false;
  private receiverObserver: (() => void) | undefined;
  private handover: BolterHandoverServer | null = null;
  private spool: BolterConnectionSpool | null = null;
  private starting: Promise<boolean> | null = null;
  private flushing: Promise<"accepted" | "blocked" | "unavailable"> | null = null;
  private loggingIn: Promise<BolterNativeLoginOutcome> | null = null;
  private retirement: Promise<void> | null = null;
  private readonly currentCallback: () => boolean;
  private readonly boundCallback: (binding: BolterCliBinding) => boolean;
  private readonly onIgnoredEvent: (kind: string | null) => void;

  constructor(options: {
    scope: BolterSpoolScope;
    runtime: BolterCliRuntime;
    selection?: BolterCliSelection | undefined;
    qualification?: BolterNativeQualification | undefined;
    decoders?: BolterQualifiedDecoders | undefined;
    attest: (plan: BolterCliInvocation) => Promise<boolean>;
    attestHelper?: ((executable: string) => Promise<boolean>) | undefined;
    isCurrent: () => boolean;
    /** Checks the current server-owned exact destination; never supplied by renderer content. */
    isBound: (binding: BolterCliBinding) => boolean;
    onIgnoredEvent?: ((kind: string | null) => void) | undefined;
    spawn?: BolterNativeSpawn | undefined;
  }) {
    if (!options.scope || [options.scope.serverId, options.scope.userId, options.scope.connectionId]
      .some(value => typeof value !== "string" || value.trim().length === 0)) throw new Error("Bolter connection is unavailable.");
    this.scope = Object.freeze({ ...options.scope });
    this.runtime = Object.freeze({ ...options.runtime });
    this.selection = options.selection ? Object.freeze({ ...options.selection }) : null;
    this.decoders = options.decoders ? Object.freeze({ ...options.decoders }) : undefined;
    this.qualification = options.qualification ? Object.freeze({ ...options.qualification }) : undefined;
    this.currentCallback = options.isCurrent;
    this.boundCallback = options.isBound;
    this.onIgnoredEvent = options.onIgnoredEvent ?? (kind => {
      console.warn("[bolter] Ignoring unsupported provider event:", JSON.stringify({ kind }));
    });
    this.native = new BolterNativeProcessOwner({ runtime: this.runtime, qualification: this.qualification,
      attest: options.attest, attestHelper: options.attestHelper, isCurrent: () => this.current(), spawn: options.spawn });
    this.client = new BolterCliClient({ runtime: this.runtime, decoders: this.decoders,
      isCurrent: () => this.current(),
      // The native runner owns executable attestation immediately before spawn.
      attest: () => Promise.resolve(true), execute: plan => this.native.execute(plan) });
  }
  private current(): boolean {
    try { return !this.retired && this.currentCallback() === true; } catch { return false; }
  }
  get state(): BolterNativeConnectionState {
    return this.retired ? "retired" : this.current() ? this.stateValue : "unavailable";
  }
  get listening(): boolean { return this.current() && this.confirmed && this.receiver !== null && this.receiverReady; }
  get canShareFiles(): boolean { return this.current() && this.confirmed && !!this.decoders?.fileCreated; }
  private notifyReceiver(): void {
    try { if (this.current()) this.receiverObserver?.(); } catch { /* Observation failure does not undo durable handover. */ }
  }
  get confirmedIdentity(): Readonly<BolterCliSelection & { label?: string }> | null {
    return this.current() && this.confirmed ? this.selection : null;
  }
  listConversations(): Promise<BolterCliConversationsOutcome> {
    return this.current() && this.confirmed && this.selection ? this.client.listConversations(this.selection)
      : Promise.resolve({ status: "unavailable", reason: "stale-authority" });
  }
  async confirmIdentity(): Promise<BolterCliIdentityOutcome> {
    if (!this.selection) return { status: "unavailable", reason: "invalid-input" };
    const outcome = await this.client.confirmIdentity(this.selection);
    if (outcome.status === "confirmed" && this.current()) {
      this.confirmed = true;
      if (outcome.identity.label) this.selection = Object.freeze({ ...this.selection, label: outcome.identity.label });
      if (this.receiver === null) this.stateValue = "connected";
    } else {
      this.confirmed = false;
      this.stateValue = "unavailable";
      if (this.receiver) await this.receiver.stop();
    }
    return outcome;
  }
  discoverIdentities(): Promise<BolterCliDiscoveryOutcome> { return this.client.discoverIdentities(); }

  /** Bootstrap uses the owned HOME only; ambiguous identities are never chosen by default. */
  async confirmDiscoveredIdentity(): Promise<BolterCliIdentityOutcome> {
    if (!this.current() || this.receiver || this.confirmed || this.loggingIn) return { status: "unavailable", reason: "stale-authority" };
    const discovered = await this.discoverIdentities();
    if (discovered.status !== "available") return discovered;
    if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
    if (discovered.identities.length !== 1) return { status: "unavailable", reason: "unsupported-output" };
    this.selection = Object.freeze({ ...discovered.identities[0]! });
    return this.confirmIdentity();
  }
  login(onLink: (link: BolterCliAuthLink) => void): Promise<BolterNativeLoginOutcome> {
    if (this.loggingIn) return this.loggingIn;
    const work = this.performLogin(onLink);
    this.loggingIn = work;
    const settled = () => { if (this.loggingIn === work) this.loggingIn = null; };
    void work.then(settled, settled);
    return work;
  }
  private async performLogin(onLink: (link: BolterCliAuthLink) => void): Promise<BolterNativeLoginOutcome> {
    if (this.decoders?.version !== this.runtime.version || !this.decoders.authLink) {
      return { status: "unavailable", reason: "unsupported-output" };
    }
    if (!this.current() || this.receiver !== null || this.confirmed) return { status: "unavailable", reason: "stale-authority" };
    const plan = createBolterLoginInvocation(this.runtime);
    if (!plan.ok) return { status: "unavailable", reason: "execution-failed" };
    let lastLink: string | null = null;
    try {
      const child = await this.native.start(plan.value, undefined, output => {
        const link = this.client.decodeAuthLink(output);
        if (link.ok && this.current()) {
          const key = JSON.stringify(link.value);
          if (key !== lastLink) { lastLink = key; onLink(link.value); }
        }
      });
      const result = await child.result;
      if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
      return result.exitCode === 0 ? { status: "awaiting-identity-confirmation" }
        : { status: "unavailable", reason: "execution-failed" };
    } catch { return { status: "unavailable", reason: "execution-failed" }; }
  }
  startReceiver(options: { readonly handoverExecutable: string; readonly directory: string; readonly spool: BolterConnectionSpool; readonly onStateChange?: (() => void) | undefined }): Promise<boolean> {
    if (this.starting) return this.starting;
    if (this.receiver !== null) return Promise.resolve(this.current() && this.confirmed && this.stateValue === "receiver-running");
    const work = this.performStart({ ...options });
    this.starting = work;
    const settled = () => { if (this.starting === work) this.starting = null; };
    void work.then(settled, settled);
    return work;
  }
  private async performStart(options: { readonly handoverExecutable: string; readonly directory: string; readonly spool: BolterConnectionSpool; readonly onStateChange?: (() => void) | undefined }): Promise<boolean> {
    if (!this.current() || !this.confirmed || !this.selection || this.loggingIn !== null
      || this.decoders?.version !== this.runtime.version || !this.decoders.receiveItem
      || !hasBolterNativeQualification(this.qualification, this.runtime.version)) return false;
    this.receiverReady = false;
    this.receiverObserver = options.onStateChange;
    const revision = this.receiverRevision;
    const receiverCurrent = () => this.current() && this.confirmed && revision === this.receiverRevision;
    const plan = createBolterReceiveInvocation(this.runtime, this.selection, options.handoverExecutable);
    if (!plan.ok) return false;
    const spool = Object.freeze({ store: options.spool.store.bind(options.spool), pending: options.spool.pending.bind(options.spool),
      read: options.spool.read.bind(options.spool), acknowledge: options.spool.acknowledge.bind(options.spool) });
    let handover: BolterHandoverServer | null = null;
    try {
      handover = await createBolterHandoverServer({ directory: options.directory, generation: this.generation,
        scope: this.scope, maxBatchBytes: this.qualification!.maxBatchBytes,
        isCurrent: receiverCurrent, store: async jsonl => {
          // Preserve every batch before interpreting it. Unqualified messages remain durable and blocked.
          const receipt = await spool.store(jsonl);
          if (receiverCurrent()) {
            const decoded = decodeBolterReceiveBatch(jsonl, this.runtime.version, this.decoders);
            if (decoded.ok && decoded.value.some(item => item.type === "message" || item.kind === "connected" || item.kind === "system_message")) {
              const changed = !this.receiverReady;
              this.receiverReady = true;
              if (changed) this.notifyReceiver();
            }
          }
          return receipt;
        } });
      if (!receiverCurrent()) { await handover.close(); return false; }
      const child = await this.native.start(plan.value, { helper: options.handoverExecutable,
        descriptor: JSON.stringify(handover.descriptor) }, undefined, receiverCurrent);
      this.handover = handover;
      this.spool = spool;
      this.receiver = child;
      // Spawn is process evidence only, not provider listening/readiness confirmation.
      this.stateValue = "receiver-running";
      if (this.receiverReady) this.notifyReceiver();
      void child.result.then(async () => {
        if (this.receiver === child) { this.receiver = null; this.receiverReady = false; this.stateValue = "unavailable"; this.notifyReceiver(); }
        await handover?.close();
        if (this.handover === handover) this.handover = null;
      }).catch(() => undefined);
      if (!this.current()) { await child.stop(); await handover.close(); return false; }
      return true;
    } catch { await handover?.close().catch(() => undefined); return false; }
  }
  async pauseReceiver(): Promise<void> {
    this.receiverRevision++;
    this.receiverReady = false;
    this.notifyReceiver();
    await this.starting;
    this.stateValue = "unavailable";
    const receiver = this.receiver;
    await receiver?.stop();
    await this.handover?.close();
    if (this.receiver === receiver) this.receiver = null;
    this.handover = null;
    if (this.current() && this.confirmed) this.stateValue = "connected";
    this.notifyReceiver();
  }
  async prepareSend(): Promise<{ send(binding: BolterCliBinding, content: string, files?: readonly BolterAttachmentPayload[], reauthorize?: () => Promise<boolean>): Promise<BolterCliSendOutcome> } | null> {
    if (!this.current() || !this.confirmed || !this.selection || this.decoders?.version !== this.runtime.version || !this.decoders.receipt) return null;
    const decoders = this.decoders;
    try {
      const prepared = await this.native.prepareSend(this.selection, () => this.current() && this.confirmed);
      return Object.freeze({ send: async (binding: BolterCliBinding, content: string, files?: readonly BolterAttachmentPayload[], reauthorize?: () => Promise<boolean>): Promise<BolterCliSendOutcome> => {
        const destination = Object.freeze({ ...binding });
        if (!this.current() || !this.confirmed) return { status: "unavailable", reason: "stale-authority" };
        let result;
        try {
          if (files?.length) {
            if (!decoders.fileCreated || !reauthorize) return { status: "unavailable", reason: "unsupported-output" };
            const links: string[] = [];
            for (const file of files) {
              const upload = await this.native.prepareFileUpload(this.selection!, destination, file, () => this.current() && this.confirmed);
              if (!await reauthorize() || !this.current()) return { status: "uncertain", reason: "stale-authority" };
              const uploaded = await upload.execute();
              if (uploaded.exitCode !== 0 || !this.current()) return { status: "uncertain", reason: "execution-failed" };
              const { url } = decoders.fileCreated(JSON.parse(uploaded.stdout) as unknown);
              const label = file.filename.replace(/[\r\n]/gu, " ").replace(/[\\[\]]/gu, "\\$&");
              links.push(`- [${label}](<${url}>)`);
            }
            if (!await reauthorize() || !this.current()) return { status: "uncertain", reason: "stale-authority" };
            content = `${content}\n\n${links.join("\n")}`;
          }
          result = await prepared.execute(destination, content);
        } catch { return { status: "uncertain", reason: "execution-failed" }; }
        if (!this.current() || result.exitCode !== 0) return { status: "uncertain", reason: "stale-authority" };
        try {
          const receipt = validateBolterReceipt(decoders.receipt!(JSON.parse(result.stdout) as unknown));
          if (!receipt.ok || receipt.value.chatId !== destination.chatId || receipt.value.threadRootId !== destination.threadRootId)
            return { status: "uncertain", reason: "destination-mismatch" };
          return { status: "sent", receipt: receipt.value };
        } catch { return { status: "uncertain", reason: "unsupported-output" }; }
      } });
    } catch { return null; }
  }
  async send(binding: BolterCliBinding, content: string): Promise<BolterCliSendOutcome> {
    const destination = Object.freeze({ chatId: binding.chatId, threadRootId: binding.threadRootId });
    let bound = false;
    try { bound = this.boundCallback(destination) === true; } catch { /* Fail closed. */ }
    if (!this.current() || !this.confirmed || !this.selection || !bound) return { status: "unavailable", reason: "stale-authority" };
    // Revalidate exact destination at the native spawn fence as well as this admission.
    const client = new BolterCliClient({ runtime: this.runtime, decoders: this.decoders,
      attest: () => Promise.resolve(true), isCurrent: () => {
        try { return this.current() && this.confirmed && this.boundCallback(destination) === true; } catch { return false; }
      }, execute: plan => this.native.execute(plan, () => this.current() && this.confirmed && this.boundCallback(destination) === true) });
    return client.send(this.selection, destination, content);
  }
  flushInbox(accept: (items: readonly BolterCliReceiveItem[], receipt: BolterSpoolReceipt) => Promise<boolean>): Promise<"accepted" | "blocked" | "unavailable"> {
    if (this.flushing) return this.flushing;
    const work = this.performFlush(accept);
    this.flushing = work;
    const settled = () => { if (this.flushing === work) this.flushing = null; };
    void work.then(settled, settled);
    return work;
  }
  private async performFlush(accept: (items: readonly BolterCliReceiveItem[], receipt: BolterSpoolReceipt) => Promise<boolean>): Promise<"accepted" | "blocked" | "unavailable"> {
    const spool = this.spool;
    if (!spool || !this.current() || !this.confirmed) return "unavailable";
    try {
      for (const id of await spool.pending()) {
        if (!this.current() || !this.confirmed) return "unavailable";
        const batch = await spool.read(id);
        const decoded = decodeBolterReceiveBatch(batch.jsonl, this.runtime.version, this.decoders);
        if (!decoded.ok) return "blocked";
        if (!this.current() || !this.confirmed) return "unavailable";
        const retained = decoded.value.filter(item => {
          if (item.type !== "control" || item.kind !== "ignored_event") return true;
          try { this.onIgnoredEvent(item.eventKind ?? null); } catch { /* Diagnostics cannot block delivery. */ }
          return false;
        });
        if (!this.current() || !this.confirmed) return "unavailable";
        // An event-only batch has no server admission to await. Mixed batches retain
        // their durable acknowledgement fence until every remaining item is accepted.
        if (retained.length > 0 && !await accept(retained, { id: batch.id, fingerprint: batch.fingerprint })) return "blocked";
        if (!this.current() || !this.confirmed) return "unavailable";
        await spool.acknowledge(batch);
      }
      return this.current() ? "accepted" : "unavailable";
    } catch { return "unavailable"; }
  }
  retire(): Promise<void> {
    this.retired = true;
    this.confirmed = false;
    this.stateValue = "retired";
    this.retirement ??= (async () => {
      await Promise.all([this.native.retire(), this.handover?.close()]);
      await Promise.allSettled([this.starting, this.flushing, this.loggingIn]);
      await this.handover?.close();
    })();
    return this.retirement;
  }
}
