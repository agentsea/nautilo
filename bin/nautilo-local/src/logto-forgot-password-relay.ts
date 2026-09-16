/**
 * M120 — pure decision logic for configuring Logto's native ForgotPassword
 * email-code flow to deliver its code to Nautilo's HTTP Email webhook (no
 * SMTP). Used by `bootstrap-logto.ts`'s `reconcileForgotPasswordRelay`, which
 * does the actual `GET/POST /api/connectors` + `PATCH /api/sign-in-exp` I/O.
 *
 * Grounded in Logto OSS source (commit reviewed 2026-06-04):
 *  - The `http-email` connector posts `{ to, type, payload, ip }` to the
 *    configured `endpoint` with the `authorization` header verbatim
 *    (connector-http-email/src/index.ts).
 *  - `POST /api/connectors` for a passwordless (email/sms) connector DELETES
 *    every other connector of the same type (core connector/index.ts). So we
 *    must NOT blindly POST when a different email connector already exists —
 *    that would silently destroy an operator-owned connector. We detect and
 *    fail loud instead. For `http-email`, ownership is endpoint-based: only a
 *    connector already pointing at Nautilo's webhook is ours to rotate.
 *  - `forgotPasswordMethods` uses the enum value `EmailVerificationCode`
 *    (schemas ForgotPasswordMethod), NOT `email`.
 */

export const HTTP_EMAIL_CONNECTOR_ID = "http-email";
export const FORGOT_PASSWORD_EMAIL_METHOD = "EmailVerificationCode";

/** Minimal shape of a row from `GET /api/connectors`. */
export interface LogtoConnectorRow {
  id: string;
  connectorId: string;
  /** ConnectorType — "Email" | "Sms" | "Social". */
  type?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface ForgotPasswordRelayPlan {
  /**
   * - `skip`: an http-email connector already points at our endpoint/secret.
   * - `create`: POST the http-email connector. Safe only when no email
   *   connector exists, or when the existing http-email connector already
   *   points at Nautilo's webhook and only needs auth/config rotation.
   * - `conflict`: an operator-owned email connector is configured; do NOT
   *   POST (Logto would delete it). Caller must throw.
   */
  connector: "skip" | "create" | "conflict";
  /** Set when `connector === "conflict"`. */
  conflictConnectorId?: string;
  /** Set when `connector === "create"`. */
  connectorBody?: {
    connectorId: string;
    config: { endpoint: string; authorization: string };
  };
  /**
   * When set, PATCH `/api/sign-in-exp` with `{ forgotPasswordMethods }`.
   * `undefined` means the method is already enabled — no patch needed.
   */
  forgotPasswordMethods?: string[];
}

function authorizationHeader(secret: string): string {
  return `Bearer ${secret}`;
}

function isEmailConnector(row: LogtoConnectorRow): boolean {
  return (row.type ?? "").toLowerCase() === "email";
}

export function computeForgotPasswordRelayPlan(args: {
  connectors: readonly LogtoConnectorRow[];
  currentForgotPasswordMethods: readonly string[] | null;
  webhookEndpoint: string;
  webhookSecret: string;
}): ForgotPasswordRelayPlan {
  const expectedAuth = authorizationHeader(args.webhookSecret);

  const emailConnectors = args.connectors.filter(isEmailConnector);
  const httpEmailConnectors = emailConnectors.filter(
    (c) => c.connectorId === HTTP_EMAIL_CONNECTOR_ID,
  );
  const foreignEmail = emailConnectors.find(
    (c) => c.connectorId !== HTTP_EMAIL_CONNECTOR_ID,
  );

  const currentMethods = args.currentForgotPasswordMethods;
  const methodsAlreadyEnabled =
    currentMethods !== null &&
    currentMethods.includes(FORGOT_PASSWORD_EMAIL_METHOD);
  // Logto treats null forgotPasswordMethods as connector-based fallback. Do
  // not narrow that legacy/default state to an explicit email-only array.
  const forgotPasswordMethods =
    currentMethods === null || methodsAlreadyEnabled
      ? undefined
      : [...currentMethods, FORGOT_PASSWORD_EMAIL_METHOD];

  if (foreignEmail) {
    return {
      connector: "conflict",
      conflictConnectorId: foreignEmail.id,
      ...(forgotPasswordMethods ? { forgotPasswordMethods } : {}),
    };
  }

  const operatorOwnedHttpEmail = httpEmailConnectors.find(
    (c) => c.config?.["endpoint"] !== args.webhookEndpoint,
  );
  if (operatorOwnedHttpEmail) {
    return {
      connector: "conflict",
      conflictConnectorId: operatorOwnedHttpEmail.id,
      ...(forgotPasswordMethods ? { forgotPasswordMethods } : {}),
    };
  }

  const httpEmail = httpEmailConnectors[0];
  const alreadyConfigured =
    httpEmail !== undefined &&
    httpEmail.config?.["endpoint"] === args.webhookEndpoint &&
    httpEmail.config?.["authorization"] === expectedAuth;

  if (alreadyConfigured) {
    return {
      connector: "skip",
      ...(forgotPasswordMethods ? { forgotPasswordMethods } : {}),
    };
  }

  return {
    connector: "create",
    connectorBody: {
      connectorId: HTTP_EMAIL_CONNECTOR_ID,
      config: {
        endpoint: args.webhookEndpoint,
        authorization: expectedAuth,
      },
    },
    ...(forgotPasswordMethods ? { forgotPasswordMethods } : {}),
  };
}
