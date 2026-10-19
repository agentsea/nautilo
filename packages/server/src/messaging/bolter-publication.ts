import {
  claimBolterOutboxWith, loadBolterPublicationContentWith, settleBolterOutboxWith,
  type BolterBindingContext, type BolterBridgeDatabase, type BolterPublicationContent,
} from "@nautilo/db";

type Claim = Readonly<{ outboxId: string; claimToken: string }>;
type Receipt = Readonly<{ messageId: string; chatId: string; threadRootId: string | null }>;
export type BolterPublicationTransportOutcome =
  | { readonly status: "sent"; readonly receipt: Receipt }
  /** Proven not dispatched; a lost response after dispatch is uncertain. */
  | { readonly status: "unavailable" }
  | { readonly status: "uncertain" };

/**
 * Fixed Desktop transport, not a model tool. The transport obtains text only
 * through authorize once its exact receiver is ready to dispatch. It must
 * additionally fence its native process/session immediately before spawning.
 */
export interface BolterPublicationTransport {
  isCurrent(receiver: Readonly<BolterBindingContext>): boolean;
  send(input: Readonly<{
    receiver: Readonly<BolterBindingContext>;
    claim: Claim;
    authorize(): Promise<BolterPublicationContent | null>;
    /** File preparation is asynchronous; recheck the same immutable claim before every subsequent dispatch. */
    reauthorize(): Promise<boolean>;
  }>): Promise<BolterPublicationTransportOutcome>;
}

export type BolterPublicationOutcome =
  | { readonly status: "unavailable" }
  | { readonly status: "cancelled" }
  | { readonly status: "uncertain" }
  | { readonly status: "published"; readonly providerMessageId: string };

interface PublicationStore {
  claim(receiver: BolterBindingContext, outboxId: string): Promise<{ claimToken: string | null } | null>;
  load(receiver: BolterBindingContext, claim: Claim): Promise<BolterPublicationContent | null>;
  settle(receiver: BolterBindingContext, input: Claim & (
    { state: "published"; providerMessageId: string } | { state: "uncertain" | "cancelled" }
  )): Promise<{ readonly state: string } | null>;
}

function current(transport: BolterPublicationTransport, receiver: BolterBindingContext): boolean {
  try { return transport.isCurrent(receiver) === true; }
  catch { return false; }
}

function validMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && !/\s/u.test(value) && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

/** No retries: a crash or lost reply leaves the durable claim for reconciliation. */
export function createBolterPublicationService(options: {
  readonly store: PublicationStore;
  readonly transport: BolterPublicationTransport;
}) {
  // Capture ports so later caller mutation cannot replace the authority checks.
  const store = Object.freeze({ claim: options.store.claim.bind(options.store),
    load: options.store.load.bind(options.store), settle: options.store.settle.bind(options.store) });
  const transport = Object.freeze({ isCurrent: options.transport.isCurrent.bind(options.transport),
    send: options.transport.send.bind(options.transport) });
  return Object.freeze({
    async publish(receiverInput: BolterBindingContext, outboxId: string): Promise<BolterPublicationOutcome> {
      const receiver = Object.freeze({ ...receiverInput });
      if (!current(transport, receiver)) return { status: "unavailable" };
      let claimed: Awaited<ReturnType<PublicationStore["claim"]>>;
      try { claimed = await store.claim(receiver, outboxId); }
      catch { return { status: "unavailable" }; }
      if (!claimed?.claimToken) return { status: "unavailable" };
      const claim = Object.freeze({ outboxId, claimToken: claimed.claimToken });
      let authorized: BolterPublicationContent | null = null;
      let authorizationUsed = false;
      let attemptOpen = true;

      async function settle(state: "cancelled" | "uncertain"): Promise<BolterPublicationOutcome> {
        try {
          const persisted = await store.settle(receiver, { ...claim, state });
          if (persisted?.state === state) return { status: state };
        } catch { /* Keep the durable publishing claim; never guess or resend. */ }
        return { status: "uncertain" };
      }

      if (!current(transport, receiver)) return settle("cancelled");
      let outcome: BolterPublicationTransportOutcome;
      try {
        outcome = await transport.send(Object.freeze({ receiver, claim,
          async reauthorize() {
            if (!attemptOpen || !authorized || !current(transport, receiver)) return false;
            try {
              const fresh = await store.load(receiver, claim);
              return attemptOpen && current(transport, receiver) && JSON.stringify(fresh) === JSON.stringify(authorized);
            } catch { return false; }
          },
          async authorize() {
            if (!attemptOpen || authorizationUsed) return null;
            authorizationUsed = true;
            if (!current(transport, receiver)) return null;
            try {
              const content = await store.load(receiver, claim);
              if (!attemptOpen || !content || !current(transport, receiver)) return null;
              authorized = Object.freeze({ ...content,
                ...(content.files ? { files: Object.freeze(content.files.map(file => Object.freeze({ ...file }))) } : {}) });
              return authorized;
            } catch { return null; }
          },
        }));
      } catch { outcome = { status: "uncertain" }; }
      finally { attemptOpen = false; }
      if (outcome?.status === "unavailable") return settle("cancelled");
      if (outcome?.status !== "sent" || !authorized || !current(transport, receiver)) return settle("uncertain");
      const receipt = outcome.receipt;
      const destination = authorized as BolterPublicationContent;
      if (!validMessageId(receipt?.messageId) || receipt.chatId !== destination.chatId
        || receipt.threadRootId !== destination.threadRootId) return settle("uncertain");
      try {
        const persisted = await store.settle(receiver, { ...claim, state: "published", providerMessageId: receipt.messageId });
        if (persisted?.state === "published") return { status: "published", providerMessageId: receipt.messageId };
      } catch { /* Provider success without durable settlement stays uncertain. */ }
      return { status: "uncertain" };
    },
  });
}

export function createDatabaseBolterPublicationService(db: BolterBridgeDatabase, transport: BolterPublicationTransport) {
  return createBolterPublicationService({ transport, store: {
    claim: (receiver, id) => claimBolterOutboxWith(db, receiver, id),
    load: (receiver, claim) => loadBolterPublicationContentWith(db, receiver, claim),
    settle: (receiver, input) => settleBolterOutboxWith(db, receiver, input),
  } });
}
