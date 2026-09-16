import {
  mobilePushEnvelopeV1Schema,
  type MobilePushEnvelopeV1,
} from "@nautilo/types";

/** Expo's documented direct HTTPS endpoints. */
export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const EXPO_PUSH_MAX_MESSAGES_PER_REQUEST = 100;
const EXPO_PUSH_MAX_RECEIPTS_PER_REQUEST = 1_000;
const EXPO_PUSH_MAX_PAYLOAD_BYTES = 4_096;
const EXPO_PUSH_DEFAULT_TIMEOUT_MS = 15_000;

/** Must match Mobile's native `defaultChannel` and channel setup exactly. */
export const EXPO_PUSH_ANDROID_CHANNEL_ID = "important-messages";

const EXPO_PUSH_RESPONSE_MAX_BYTES = 1_000_000;
const EXPO_PUSH_TOKEN_PATTERN = /^(?:Exponent|Expo)PushToken\[[^\]\r\n]{1,2000}\]$/;
const OPAQUE_IDENTIFIER_PATTERN = /^\S{1,256}$/u;
const MAX_PRESENTATION_LABEL_CODE_POINTS = 200;

/**
 * This union is deliberately structural. Important-message callers supply
 * only the same sanitized sender/Room labels used by Desktop; the adapter
 * owns the final title/body templates and validates them before network I/O.
 */
export type ExpoPushPresentation =
  | {
      readonly kind: "important_message";
      readonly senderDisplayName: string;
      readonly roomLabel: string;
      readonly parentRoomLabel?: string;
    }
  | {
      readonly kind: "needs_you";
      readonly title: "Nautilo";
      readonly body: "You have a request";
    }
  | {
      readonly kind: "test";
      readonly title: "Nautilo";
      readonly body: "Test notification";
    };

export const EXPO_PUSH_GENERIC_PRESENTATIONS: Readonly<Record<
  "needs_you" | "test",
  Extract<ExpoPushPresentation, { readonly kind: "needs_you" | "test" }>
>> = {
  needs_you: {
    kind: "needs_you",
    title: "Nautilo",
    body: "You have a request",
  },
  test: {
    kind: "test",
    title: "Nautilo",
    body: "Test notification",
  },
};

/**
 * `deliveryId` is a server-local opaque correlation key, never an Expo token
 * or customer-visible message fact. Outcomes intentionally echo only it.
 */
export interface ExpoPushDelivery {
  readonly deliveryId: string;
  readonly expoPushToken: string;
  readonly envelope: MobilePushEnvelopeV1;
  readonly presentation: ExpoPushPresentation;
  /** Absolute single-server unread count; foreground activation aggregates it. */
  readonly badge?: number;
}

export interface ExpoPushReceiptLookup {
  readonly deliveryId: string;
  readonly ticketId: string;
}

export type ExpoPushRetryableFailureCode =
  | "network_error"
  | "timeout"
  | "aborted"
  | "rate_limited"
  | "server_error"
  | "malformed_response"
  | "receipt_not_ready"
  | "message_rate_exceeded"
  | "unexpected_status";

export type ExpoPushPermanentFailureCode =
  | "invalid_request"
  | "invalid_payload"
  | "invalid_credentials"
  | "provider_rejected";

export type ExpoPushProviderOutcome =
  | {
      readonly kind: "accepted_ticket";
      readonly deliveryId: string;
      readonly ticketId: string;
    }
  | {
      readonly kind: "delivered";
      readonly deliveryId: string;
      readonly ticketId: string;
    }
  | {
      readonly kind: "retryable_provider_failure";
      readonly deliveryId: string;
      readonly code: ExpoPushRetryableFailureCode;
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: "permanent_provider_failure";
      readonly deliveryId: string;
      readonly code: ExpoPushPermanentFailureCode;
    }
  | {
      readonly kind: "device_not_registered";
      readonly deliveryId: string;
    };

export interface ExpoPushFetch {
  (input: string, init: RequestInit): Promise<Response>;
}

export interface ExpoPushProviderOptions {
  readonly fetch?: ExpoPushFetch;
  readonly timeoutMs?: number;
}

interface ExpoWireMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly sound: "default";
  readonly priority: "high";
  readonly ttl: number;
  readonly channelId: typeof EXPO_PUSH_ANDROID_CHANNEL_ID;
  readonly data: MobilePushEnvelopeV1;
  readonly badge?: number;
}

interface ExpoTicketOk {
  readonly status: "ok";
  readonly id: string;
}

interface ExpoTicketError {
  readonly status: "error";
  readonly details?: { readonly error?: string };
}

interface ExpoReceiptOk {
  readonly status: "ok";
}

interface ExpoReceiptError {
  readonly status: "error";
  readonly details?: { readonly error?: string };
}

/**
 * A small, dependency-injected Expo Push Service adapter. It has no database
 * or worker semantics: callers persist only the redacted typed outcomes.
 */
export class ExpoPushProvider {
  private readonly fetchImpl: ExpoPushFetch;
  private readonly timeoutMs: number;

  constructor(options: ExpoPushProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = validTimeout(options.timeoutMs)
      ? options.timeoutMs
      : EXPO_PUSH_DEFAULT_TIMEOUT_MS;
  }

  async send(
    deliveries: readonly ExpoPushDelivery[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly ExpoPushProviderOutcome[]> {
    if (deliveries.length === 0) return [];
    if (deliveries.length > EXPO_PUSH_MAX_MESSAGES_PER_REQUEST) {
      return permanentForDeliveries(deliveries, "invalid_request");
    }

    const messages: ExpoWireMessage[] = [];
    for (const delivery of deliveries) {
      const message = buildExpoWireMessage(delivery);
      if (message === null) {
        return permanentForDeliveries(deliveries, "invalid_payload");
      }
      messages.push(message);
    }

    const response = await this.postJson(EXPO_PUSH_SEND_URL, messages, options.signal);
    if (response.kind === "failure") {
      return outcomesForDeliveries(deliveries, response.outcome);
    }

    const tickets = parseTicketResponse(response.body);
    if (tickets === null || tickets.length !== deliveries.length) {
      return retryableForDeliveries(deliveries, "malformed_response");
    }

    return tickets.map((ticket, index) => {
      const delivery = deliveries[index]!;
      if (ticket.status === "ok") {
        return {
          kind: "accepted_ticket" as const,
          deliveryId: delivery.deliveryId,
          ticketId: ticket.id,
        };
      }
      return providerErrorOutcome(delivery.deliveryId, ticket.details?.error);
    });
  }

  async getReceipts(
    lookups: readonly ExpoPushReceiptLookup[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly ExpoPushProviderOutcome[]> {
    if (lookups.length === 0) return [];
    if (
      lookups.length > EXPO_PUSH_MAX_RECEIPTS_PER_REQUEST ||
      lookups.some((lookup) => !isOpaqueIdentifier(lookup.deliveryId) || !isOpaqueIdentifier(lookup.ticketId)) ||
      hasDuplicateTicketIds(lookups)
    ) {
      return permanentForLookups(lookups, "invalid_request");
    }

    const response = await this.postJson(
      EXPO_PUSH_RECEIPTS_URL,
      { ids: lookups.map((lookup) => lookup.ticketId) },
      options.signal,
    );
    if (response.kind === "failure") {
      return outcomesForLookups(lookups, response.outcome);
    }

    const receipts = parseReceiptResponse(response.body, new Set(lookups.map((lookup) => lookup.ticketId)));
    if (receipts === null) {
      return retryableForLookups(lookups, "malformed_response");
    }

    return lookups.map((lookup) => {
      const receipt = receipts.get(lookup.ticketId);
      if (receipt === undefined) {
        return {
          kind: "retryable_provider_failure" as const,
          deliveryId: lookup.deliveryId,
          code: "receipt_not_ready" as const,
        };
      }
      if (receipt.status === "ok") {
        return {
          kind: "delivered" as const,
          deliveryId: lookup.deliveryId,
          ticketId: lookup.ticketId,
        };
      }
      return providerErrorOutcome(lookup.deliveryId, receipt.details?.error);
    });
  }

  private async postJson(
    url: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: "response"; readonly body: unknown }
    | { readonly kind: "failure"; readonly outcome: ProviderFailure }
  > {
    const request = createRequestAbort(this.timeoutMs, signal);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip, deflate",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

      if (response.status === 429) {
        return { kind: "failure", outcome: retryableFailure("rate_limited", response.headers.get("retry-after")) };
      }
      if (response.status >= 500 && response.status <= 599) {
        return { kind: "failure", outcome: { kind: "retryable_provider_failure", code: "server_error" } };
      }
      if (response.status >= 400 && response.status <= 499) {
        return { kind: "failure", outcome: { kind: "permanent_provider_failure", code: "provider_rejected" } };
      }
      if (response.status !== 200) {
        return { kind: "failure", outcome: { kind: "retryable_provider_failure", code: "unexpected_status" } };
      }

      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > EXPO_PUSH_RESPONSE_MAX_BYTES) {
        return { kind: "failure", outcome: { kind: "retryable_provider_failure", code: "malformed_response" } };
      }
      try {
        return { kind: "response", body: JSON.parse(text) };
      } catch {
        return { kind: "failure", outcome: { kind: "retryable_provider_failure", code: "malformed_response" } };
      }
    } catch {
      if (request.didTimeout()) {
        return { kind: "failure", outcome: { kind: "retryable_provider_failure", code: "timeout" } };
      }
      if (request.didAbort()) {
        return { kind: "failure", outcome: { kind: "retryable_provider_failure", code: "aborted" } };
      }
      return { kind: "failure", outcome: { kind: "retryable_provider_failure", code: "network_error" } };
    } finally {
      request.dispose();
    }
  }
}

type ProviderFailure =
  | {
      readonly kind: "retryable_provider_failure";
      readonly code: ExpoPushRetryableFailureCode;
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: "permanent_provider_failure";
      readonly code: ExpoPushPermanentFailureCode;
    };

function buildExpoWireMessage(delivery: ExpoPushDelivery): ExpoWireMessage | null {
  if (
    !isOpaqueIdentifier(delivery.deliveryId) ||
    !isExpoPushToken(delivery.expoPushToken) ||
    !isEnvelope(delivery.envelope) ||
    !isValidBadge(delivery.badge)
  ) {
    return null;
  }
  const copy = presentationCopy(delivery.presentation, delivery.envelope);
  if (copy === null) return null;

  const message: ExpoWireMessage = {
    to: delivery.expoPushToken,
    title: copy.title,
    body: copy.body,
    sound: "default",
    priority: "high",
    ttl: 3_600,
    channelId: EXPO_PUSH_ANDROID_CHANNEL_ID,
    data: delivery.envelope,
    ...(delivery.badge === undefined ? {} : { badge: delivery.badge }),
  };
  return new TextEncoder().encode(JSON.stringify(message)).byteLength <= EXPO_PUSH_MAX_PAYLOAD_BYTES
    ? message
    : null;
}

function isEnvelope(value: unknown): value is MobilePushEnvelopeV1 {
  return mobilePushEnvelopeV1Schema.safeParse(value).success;
}

function presentationCopy(
  presentation: ExpoPushPresentation,
  envelope: MobilePushEnvelopeV1,
): { readonly title: string; readonly body: string } | null {
  if (presentation.kind !== envelope.kind) return null;
  if (presentation.kind === "important_message") {
    if (envelope.kind !== "important_message") return null;
    if (
      !isPresentationLabel(presentation.senderDisplayName) ||
      !isPresentationLabel(presentation.roomLabel)
    ) return null;
    const isSubthread = envelope.roomId !== envelope.topLevelRoomId;
    if (isSubthread) {
      if (!isPresentationLabel(presentation.parentRoomLabel)) return null;
      return {
        title: presentation.senderDisplayName,
        body: `New reply in ${presentation.roomLabel}, ${presentation.parentRoomLabel}`,
      };
    }
    if (presentation.parentRoomLabel !== undefined) return null;
    return {
      title: presentation.senderDisplayName,
      body: `New message in ${presentation.roomLabel}`,
    };
  }
  const expected = presentation.kind === "needs_you"
    ? EXPO_PUSH_GENERIC_PRESENTATIONS.needs_you
    : EXPO_PUSH_GENERIC_PRESENTATIONS.test;
  return presentation.title === expected.title && presentation.body === expected.body
    ? { title: expected.title, body: expected.body }
    : null;
}

function isPresentationLabel(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  if ([...value].length > MAX_PRESENTATION_LABEL_CODE_POINTS) return false;
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function isValidBadge(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function isExpoPushToken(value: string): boolean {
  return value.length <= 2_048 && EXPO_PUSH_TOKEN_PATTERN.test(value);
}

function isOpaqueIdentifier(value: string): boolean {
  return (
    OPAQUE_IDENTIFIER_PATTERN.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function parseTicketResponse(value: unknown): readonly (ExpoTicketOk | ExpoTicketError)[] | null {
  if (!isRecord(value) || !Array.isArray(value["data"])) return null;
  const tickets: (ExpoTicketOk | ExpoTicketError)[] = [];
  for (const item of value["data"]) {
    const ticket = parseTicket(item);
    if (ticket === null) return null;
    tickets.push(ticket);
  }
  return tickets;
}

function parseTicket(value: unknown): ExpoTicketOk | ExpoTicketError | null {
  if (!isRecord(value) || typeof value["status"] !== "string") return null;
  if (value["status"] === "ok") {
    return typeof value["id"] === "string" && isOpaqueIdentifier(value["id"])
      ? { status: "ok", id: value["id"] }
      : null;
  }
  if (value["status"] === "error") {
    const details = parseDetails(value["details"]);
    return details === null ? null : { status: "error", ...(details === undefined ? {} : { details }) };
  }
  return null;
}

function parseReceiptResponse(
  value: unknown,
  requestedIds: ReadonlySet<string>,
): ReadonlyMap<string, ExpoReceiptOk | ExpoReceiptError> | null {
  if (!isRecord(value) || !isRecord(value["data"])) return null;
  const receipts = new Map<string, ExpoReceiptOk | ExpoReceiptError>();
  for (const [ticketId, rawReceipt] of Object.entries(value["data"])) {
    if (!requestedIds.has(ticketId)) return null;
    const receipt = parseReceipt(rawReceipt);
    if (receipt === null) return null;
    receipts.set(ticketId, receipt);
  }
  return receipts;
}

function parseReceipt(value: unknown): ExpoReceiptOk | ExpoReceiptError | null {
  if (!isRecord(value) || typeof value["status"] !== "string") return null;
  if (value["status"] === "ok") return { status: "ok" };
  if (value["status"] === "error") {
    const details = parseDetails(value["details"]);
    return details === null ? null : { status: "error", ...(details === undefined ? {} : { details }) };
  }
  return null;
}

function parseDetails(value: unknown): { readonly error?: string } | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  return typeof value["error"] === "string" ? { error: value["error"] } : {};
}

function providerErrorOutcome(deliveryId: string, providerCode: string | undefined): ExpoPushProviderOutcome {
  if (providerCode === "DeviceNotRegistered") {
    return { kind: "device_not_registered", deliveryId };
  }
  if (providerCode === "MessageRateExceeded") {
    return { kind: "retryable_provider_failure", deliveryId, code: "message_rate_exceeded" };
  }
  if (providerCode === "InvalidCredentials") {
    return { kind: "permanent_provider_failure", deliveryId, code: "invalid_credentials" };
  }
  if (providerCode === "MessageTooBig") {
    return { kind: "permanent_provider_failure", deliveryId, code: "invalid_payload" };
  }
  return { kind: "permanent_provider_failure", deliveryId, code: "provider_rejected" };
}

function outcomesForDeliveries(
  deliveries: readonly ExpoPushDelivery[],
  outcome: ProviderFailure,
): readonly ExpoPushProviderOutcome[] {
  return deliveries.map((delivery) => withDeliveryId(outcome, delivery.deliveryId));
}

function outcomesForLookups(
  lookups: readonly ExpoPushReceiptLookup[],
  outcome: ProviderFailure,
): readonly ExpoPushProviderOutcome[] {
  return lookups.map((lookup) => withDeliveryId(outcome, lookup.deliveryId));
}

function withDeliveryId(outcome: ProviderFailure, deliveryId: string): ExpoPushProviderOutcome {
  return outcome.kind === "retryable_provider_failure"
    ? {
        kind: outcome.kind,
        deliveryId,
        code: outcome.code,
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      }
    : { kind: outcome.kind, deliveryId, code: outcome.code };
}

function permanentForDeliveries(
  deliveries: readonly ExpoPushDelivery[],
  code: ExpoPushPermanentFailureCode,
): readonly ExpoPushProviderOutcome[] {
  return deliveries.map((delivery) => ({ kind: "permanent_provider_failure" as const, deliveryId: delivery.deliveryId, code }));
}

function permanentForLookups(
  lookups: readonly ExpoPushReceiptLookup[],
  code: ExpoPushPermanentFailureCode,
): readonly ExpoPushProviderOutcome[] {
  return lookups.map((lookup) => ({ kind: "permanent_provider_failure" as const, deliveryId: lookup.deliveryId, code }));
}

function retryableForDeliveries(
  deliveries: readonly ExpoPushDelivery[],
  code: ExpoPushRetryableFailureCode,
): readonly ExpoPushProviderOutcome[] {
  return deliveries.map((delivery) => ({ kind: "retryable_provider_failure" as const, deliveryId: delivery.deliveryId, code }));
}

function retryableForLookups(
  lookups: readonly ExpoPushReceiptLookup[],
  code: ExpoPushRetryableFailureCode,
): readonly ExpoPushProviderOutcome[] {
  return lookups.map((lookup) => ({ kind: "retryable_provider_failure" as const, deliveryId: lookup.deliveryId, code }));
}

function retryableFailure(
  code: ExpoPushRetryableFailureCode,
  retryAfter: string | null,
): ProviderFailure {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  return {
    kind: "retryable_provider_failure",
    code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), 24 * 60 * 60 * 1_000);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.min(Math.max(0, dateMs - Date.now()), 24 * 60 * 60 * 1_000);
}

function hasDuplicateTicketIds(lookups: readonly ExpoPushReceiptLookup[]): boolean {
  const ids = new Set<string>();
  for (const lookup of lookups) {
    if (ids.has(lookup.ticketId)) return true;
    ids.add(lookup.ticketId);
  }
  return false;
}

function validTimeout(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 120_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRequestAbort(timeoutMs: number, outerSignal: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly didAbort: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = outerSignal?.aborted === true;
  const onOuterAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (outerSignal?.aborted) {
    controller.abort();
  } else {
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    didAbort: () => externallyAborted,
    dispose: () => {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    },
  };
}
