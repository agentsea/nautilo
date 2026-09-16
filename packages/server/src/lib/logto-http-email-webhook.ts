import { timingSafeEqual } from "node:crypto";
import { bindCodeForEmail } from "./logto-recovery-session";

export const NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV = "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET";

export interface LogtoHttpEmailWebhookPayload {
  readonly to: string;
  readonly type: string;
  readonly payload: {
    readonly code?: string | undefined;
    readonly [key: string]: unknown;
  };
  readonly ip?: string | undefined;
}

export interface ReceiveWebhookResult {
  readonly ok: true;
  /** Whether the code matched a pending recovery session. */
  readonly bound: boolean;
  readonly redacted: { to: string; type: "ForgotPassword"; receivedAt: string };
}

/**
 * Validate a Logto `http-email` webhook payload and, for ForgotPassword,
 * bind the verification code to a pending recovery session by `to`.
 *
 * The code is NEVER logged, never returned in the response, and never stored
 * outside the matching recovery session. The ack is identical whether or not
 * a session matched (`bound` is for the caller's redacted warning only — do
 * not leak it to the network response as an oracle).
 */
export function receiveLogtoHttpEmailWebhook(
  body: unknown,
  now: () => Date = () => new Date(),
): ReceiveWebhookResult | {
  ok: false;
  statusCode: 400 | 422;
  error: string;
} {
  const parsed = parseLogtoHttpEmailPayload(body);
  if (!parsed.ok) {
    return { ok: false, statusCode: 400, error: parsed.error };
  }
  const payload = parsed.payload;
  if (payload.type !== "ForgotPassword") {
    return { ok: false, statusCode: 422, error: "unsupported_email_type" };
  }
  const code = payload.payload.code;
  if (typeof code !== "string" || code.trim().length === 0) {
    return { ok: false, statusCode: 400, error: "missing_code" };
  }
  const nowDate = now();
  const bound = bindCodeForEmail(payload.to, code, () => nowDate.getTime());
  return {
    ok: true,
    bound,
    redacted: {
      to: payload.to,
      type: "ForgotPassword",
      receivedAt: nowDate.toISOString(),
    },
  };
}

export function requestHasLogtoHttpEmailWebhookSecret(
  authorizationHeader: string | undefined,
  secret: string | undefined = process.env[NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV],
): boolean {
  const expected = secret?.trim();
  if (!expected) return false;
  const prefix = "Bearer ";
  if (!authorizationHeader?.startsWith(prefix)) return false;
  const actual = authorizationHeader.slice(prefix.length).trim();
  return safeEqual(actual, expected);
}

function parseLogtoHttpEmailPayload(body: unknown): {
  ok: true;
  payload: LogtoHttpEmailWebhookPayload;
} | {
  ok: false;
  error: string;
} {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_payload" };
  }
  const row = body as Record<string, unknown>;
  const to = row["to"];
  const type = row["type"];
  const payload = row["payload"];
  if (typeof to !== "string" || to.trim().length === 0) {
    return { ok: false, error: "invalid_to" };
  }
  if (typeof type !== "string" || type.trim().length === 0) {
    return { ok: false, error: "invalid_type" };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "invalid_payload_body" };
  }
  const ip = row["ip"];
  return {
    ok: true,
    payload: {
      to,
      type,
      payload: payload as LogtoHttpEmailWebhookPayload["payload"],
      ...(typeof ip === "string" && ip.trim().length > 0 ? { ip } : {}),
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf8");
  const bBytes = Buffer.from(b, "utf8");
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}
