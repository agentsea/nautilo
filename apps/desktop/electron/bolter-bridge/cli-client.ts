import {
  createBolterConversationsInvocation, decodeBolterConversations, createBolterDiscoveryInvocation, decodeBolterIdentities, createBolterIdentityInvocation, createBolterSendInvocation, validateBolterAuthLink,
  validateBolterIdentity, validateBolterReceipt,
  type BolterCliAuthLink, type BolterCliBinding, type BolterCliIdentity,
  type BolterCliConversation, type BolterCliDiscoveredIdentity, type BolterCliInvocation, type BolterCliReceipt, type BolterCliRuntime,
  type BolterCliSelection, type BolterContractResult, type BolterQualifiedDecoders,
} from "./cli-contract";

export interface BolterCliProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface BolterCliClientOptions {
  runtime: BolterCliRuntime;
  decoders?: BolterQualifiedDecoders | undefined;
  /** Verifies the executable bytes/version and managed invocation, not just its path. */
  attest: (invocation: BolterCliInvocation) => Promise<boolean>;
  /** Current server, Human, device, connection and binding generation authority. */
  isCurrent: () => boolean;
  execute: (invocation: BolterCliInvocation) => Promise<BolterCliProcessResult>;
}

export type BolterCliUnavailableReason = "invalid-input" | "unsupported-output" |
  "unsupported-origin" | "unsupported-platform" | "stale-authority" | "attestation-failed" | "execution-failed";
export type BolterCliIdentityOutcome =
  | { status: "confirmed"; identity: BolterCliIdentity }
  | { status: "unavailable"; reason: BolterCliUnavailableReason };
export type BolterCliDiscoveryOutcome = { status: "available"; identities: readonly BolterCliDiscoveredIdentity[] }
  | { status: "unavailable"; reason: BolterCliUnavailableReason };
export type BolterCliConversationsOutcome = { status: "available"; conversations: readonly BolterCliConversation[] }
  | { status: "unavailable"; reason: BolterCliUnavailableReason };
export type BolterCliSendOutcome =
  | { status: "sent"; receipt: BolterCliReceipt }
  | { status: "unavailable"; reason: BolterCliUnavailableReason }
  | { status: "uncertain"; reason: "execution-failed" | "unsupported-output" | "destination-mismatch" | "stale-authority" };

/** No retry, logging, global config lookup, process supervision or arbitrary tool execution. */
export class BolterCliClient {
  private readonly options: BolterCliClientOptions;

  constructor(options: BolterCliClientOptions) {
    this.options = { ...options, runtime: { ...options.runtime },
      decoders: options.decoders ? { ...options.decoders } : undefined };
  }

  private qualified(): boolean {
    return this.options.decoders?.version === this.options.runtime.version;
  }

  private current(): boolean {
    try { return this.options.isCurrent() === true; }
    catch { return false; }
  }

  private async admitted(invocation: BolterCliInvocation): Promise<BolterCliUnavailableReason | null> {
    try {
      if (!this.current()) return "stale-authority";
      if (!await this.options.attest(invocation)) return "attestation-failed";
      if (!this.current()) return "stale-authority";
      return null;
    } catch { return "attestation-failed"; }
  }

  async confirmIdentity(selection: BolterCliSelection): Promise<BolterCliIdentityOutcome> {
    if (!this.qualified() || !this.options.decoders?.identity) {
      return { status: "unavailable", reason: "unsupported-output" };
    }
    const expected = { ...selection };
    const plan = createBolterIdentityInvocation(this.options.runtime, expected);
    if (!plan.ok) return { status: "unavailable", reason: plan.reason as BolterCliUnavailableReason };
    const rejected = await this.admitted(plan.value);
    if (rejected) return { status: "unavailable", reason: rejected };
    if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
    try {
      const result = await this.options.execute(plan.value);
      if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
      if (result.exitCode !== 0) return { status: "unavailable", reason: "execution-failed" };
      const raw: unknown = JSON.parse(result.stdout);
      const identity = validateBolterIdentity(this.options.decoders.identity(raw));
      if (!identity.ok || identity.value.origin !== expected.origin || identity.value.agentId !== expected.agentId) {
        return { status: "unavailable", reason: "unsupported-output" };
      }
      return { status: "confirmed", identity: identity.value };
    } catch { return { status: "unavailable", reason: "unsupported-output" }; }
  }

  async discoverIdentities(): Promise<BolterCliDiscoveryOutcome> {
    if (!this.qualified() || !this.options.decoders?.discovery) return { status: "unavailable", reason: "unsupported-output" };
    const plan = createBolterDiscoveryInvocation(this.options.runtime);
    if (!plan.ok) return { status: "unavailable", reason: plan.reason as BolterCliUnavailableReason };
    const rejected = await this.admitted(plan.value);
    if (rejected) return { status: "unavailable", reason: rejected };
    if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
    try {
      const result = await this.options.execute(plan.value);
      if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
      if (result.exitCode !== 0) return { status: "unavailable", reason: "execution-failed" };
      const identities = decodeBolterIdentities(JSON.parse(result.stdout) as unknown, this.options.runtime.version, this.options.decoders);
      return identities.ok ? { status: "available", identities: identities.value }
        : { status: "unavailable", reason: "unsupported-output" };
    } catch { return { status: "unavailable", reason: "unsupported-output" }; }
  }

  async listConversations(selection: BolterCliSelection): Promise<BolterCliConversationsOutcome> {
    if (!this.qualified() || !this.options.decoders?.conversations) return { status: "unavailable", reason: "unsupported-output" };
    const plan = createBolterConversationsInvocation(this.options.runtime, { ...selection });
    if (!plan.ok) return { status: "unavailable", reason: plan.reason as BolterCliUnavailableReason };
    const rejected = await this.admitted(plan.value);
    if (rejected) return { status: "unavailable", reason: rejected };
    if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
    try {
      const result = await this.options.execute(plan.value);
      if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
      if (result.exitCode !== 0) return { status: "unavailable", reason: "execution-failed" };
      const conversations = decodeBolterConversations(JSON.parse(result.stdout) as unknown, this.options.runtime.version, this.options.decoders);
      return conversations.ok ? { status: "available", conversations: conversations.value } : { status: "unavailable", reason: "unsupported-output" };
    } catch { return { status: "unavailable", reason: "unsupported-output" }; }
  }

  /** A link is awaiting approval; it never proves the identity is connected. */
  decodeAuthLink(stdout: string): BolterContractResult<BolterCliAuthLink> {
    if (!this.qualified() || !this.options.decoders?.authLink) {
      return { ok: false, reason: "unsupported-output" };
    }
    try { return validateBolterAuthLink(this.options.decoders.authLink(stdout)); }
    catch { return { ok: false, reason: "unsupported-output" }; }
  }

  async send(
    selection: BolterCliSelection, binding: BolterCliBinding, content: string,
  ): Promise<BolterCliSendOutcome> {
    if (!this.qualified() || !this.options.decoders?.receipt) {
      return { status: "unavailable", reason: "unsupported-output" };
    }
    const plan = createBolterSendInvocation(this.options.runtime, selection, binding, content);
    if (!plan.ok) return { status: "unavailable", reason: plan.reason as BolterCliUnavailableReason };
    // Snapshot the admitted destination before any asynchronous authority checks.
    const destination = { chatId: binding.chatId, threadRootId: binding.threadRootId };
    const rejected = await this.admitted(plan.value);
    if (rejected) return { status: "unavailable", reason: rejected };
    let result: BolterCliProcessResult;
    if (!this.current()) return { status: "unavailable", reason: "stale-authority" };
    try { result = await this.options.execute(plan.value); }
    catch { return { status: "uncertain", reason: "execution-failed" }; }
    try {
      if (!this.current()) return { status: "uncertain", reason: "stale-authority" };
      if (result.exitCode !== 0) return { status: "uncertain", reason: "execution-failed" };
      const raw: unknown = JSON.parse(result.stdout);
      const receipt = validateBolterReceipt(this.options.decoders.receipt(raw));
      if (!receipt.ok) return { status: "uncertain", reason: "unsupported-output" };
      if (receipt.value.chatId !== destination.chatId || receipt.value.threadRootId !== destination.threadRootId) {
        return { status: "uncertain", reason: "destination-mismatch" };
      }
      return { status: "sent", receipt: receipt.value };
    } catch { return { status: "uncertain", reason: "unsupported-output" }; }
  }
}
