import { randomUUID } from "node:crypto";
import { BolterCliClient, type BolterCliIdentityOutcome, type BolterCliSendOutcome } from "./cli-client";
import { createBolterLoginInvocation, createBolterReceiveInvocation, decodeBolterReceiveBatch,
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
  private readonly selection: BolterCliSelection;
  private readonly decoders: BolterQualifiedDecoders | undefined;
  private readonly qualification: BolterNativeQualification | undefined;
  private readonly native: BolterNativeProcessOwner;
  private readonly client: BolterCliClient;
  private stateValue: BolterNativeConnectionState = "unavailable";
  private confirmed = false;
  private retired = false;
  private receiver: BolterNativeChild | null = null;
  private handover: BolterHandoverServer | null = null;
  private spool: BolterConnectionSpool | null = null;
  private starting: Promise<boolean> | null = null;
  private flushing: Promise<"accepted" | "blocked" | "unavailable"> | null = null;
  private loggingIn: Promise<BolterNativeLoginOutcome> | null = null;
  private retirement: Promise<void> | null = null;
  private readonly currentCallback: () => boolean;
  private readonly boundCallback: (binding: BolterCliBinding) => boolean;

  constructor(options: {
    scope: BolterSpoolScope;
    runtime: BolterCliRuntime;
    selection: BolterCliSelection;
    qualification?: BolterNativeQualification | undefined;
    decoders?: BolterQualifiedDecoders | undefined;
    attest: (plan: BolterCliInvocation) => Promise<boolean>;
    attestHelper?: ((executable: string) => Promise<boolean>) | undefined;
    isCurrent: () => boolean;
    /** Checks the current server-owned exact destination; never supplied by renderer content. */
    isBound: (binding: BolterCliBinding) => boolean;
    spawn?: BolterNativeSpawn | undefined;
  }) {
    if (!options.scope || [options.scope.serverId, options.scope.userId, options.scope.connectionId]
      .some(value => typeof value !== "string" || value.trim().length === 0)) throw new Error("Bolter connection is unavailable.");
    this.scope = Object.freeze({ ...options.scope });
    this.runtime = Object.freeze({ ...options.runtime });
    this.selection = Object.freeze({ ...options.selection });
    this.decoders = options.decoders ? Object.freeze({ ...options.decoders }) : undefined;
    this.qualification = options.qualification ? Object.freeze({ ...options.qualification }) : undefined;
    this.currentCallback = options.isCurrent;
    this.boundCallback = options.isBound;
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
  async confirmIdentity(): Promise<BolterCliIdentityOutcome> {
    const outcome = await this.client.confirmIdentity(this.selection);
    if (outcome.status === "confirmed" && this.current()) {
      this.confirmed = true;
      if (this.receiver === null) this.stateValue = "connected";
    } else {
      this.confirmed = false;
      this.stateValue = "unavailable";
      if (this.receiver) await this.receiver.stop();
    }
    return outcome;
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
  startReceiver(options: { readonly handoverExecutable: string; readonly directory: string; readonly spool: BolterConnectionSpool }): Promise<boolean> {
    if (this.starting) return this.starting;
    if (this.receiver !== null) return Promise.resolve(this.current() && this.confirmed && this.stateValue === "receiver-running");
    const work = this.performStart({ ...options });
    this.starting = work;
    const settled = () => { if (this.starting === work) this.starting = null; };
    void work.then(settled, settled);
    return work;
  }
  private async performStart(options: { readonly handoverExecutable: string; readonly directory: string; readonly spool: BolterConnectionSpool }): Promise<boolean> {
    if (!this.current() || !this.confirmed || this.loggingIn !== null
      || this.decoders?.version !== this.runtime.version || !this.decoders.receiveItem
      || !hasBolterNativeQualification(this.qualification, this.runtime.version)) return false;
    const plan = createBolterReceiveInvocation(this.runtime, this.selection, options.handoverExecutable);
    if (!plan.ok) return false;
    const spool = Object.freeze({ store: options.spool.store.bind(options.spool), pending: options.spool.pending.bind(options.spool),
      read: options.spool.read.bind(options.spool), acknowledge: options.spool.acknowledge.bind(options.spool) });
    let handover: BolterHandoverServer | null = null;
    try {
      handover = await createBolterHandoverServer({ directory: options.directory, generation: this.generation,
        scope: this.scope, maxBatchBytes: this.qualification!.maxBatchBytes,
        isCurrent: () => this.current() && this.confirmed, store: spool.store });
      if (!this.current() || !this.confirmed) { await handover.close(); return false; }
      const child = await this.native.start(plan.value, { helper: options.handoverExecutable,
        descriptor: JSON.stringify(handover.descriptor) });
      this.handover = handover;
      this.spool = spool;
      this.receiver = child;
      // Spawn is process evidence only, not provider listening/readiness confirmation.
      this.stateValue = "receiver-running";
      void child.result.then(async () => {
        if (this.receiver === child) { this.receiver = null; this.stateValue = "unavailable"; }
        await handover?.close();
        if (this.handover === handover) this.handover = null;
      }).catch(() => undefined);
      if (!this.current()) { await child.stop(); await handover.close(); return false; }
      return true;
    } catch { await handover?.close().catch(() => undefined); return false; }
  }
  async send(binding: BolterCliBinding, content: string): Promise<BolterCliSendOutcome> {
    const destination = Object.freeze({ chatId: binding.chatId, threadRootId: binding.threadRootId });
    let bound = false;
    try { bound = this.boundCallback(destination) === true; } catch { /* Fail closed. */ }
    if (!this.current() || !this.confirmed || !bound) return { status: "unavailable", reason: "stale-authority" };
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
        if (!await accept(decoded.value, { id: batch.id, fingerprint: batch.fingerprint })) return "blocked";
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
