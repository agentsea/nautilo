/**
 * M120 — computeForgotPasswordRelayPlan: connector + SIE reconcile decision.
 */
import { describe, expect, test } from "bun:test";
import {
  computeForgotPasswordRelayPlan,
  HTTP_EMAIL_CONNECTOR_ID,
  FORGOT_PASSWORD_EMAIL_METHOD,
  type LogtoConnectorRow,
} from "../../src/logto-forgot-password-relay";

const ENDPOINT = "http://nautilo-server:3001/api/internal/logto/email-webhook";
const SECRET = "webhook-secret";
const AUTH = `Bearer ${SECRET}`;

function plan(opts: {
  connectors?: LogtoConnectorRow[];
  methods?: string[] | null;
}) {
  return computeForgotPasswordRelayPlan({
    connectors: opts.connectors ?? [],
    currentForgotPasswordMethods:
      "methods" in opts ? opts.methods! : [],
    webhookEndpoint: ENDPOINT,
    webhookSecret: SECRET,
  });
}

describe("computeForgotPasswordRelayPlan (M120)", () => {
  test("fresh instance: create connector + enable method", () => {
    const p = plan({});
    expect(p.connector).toBe("create");
    expect(p.connectorBody).toEqual({
      connectorId: HTTP_EMAIL_CONNECTOR_ID,
      config: { endpoint: ENDPOINT, authorization: AUTH },
    });
    expect(p.forgotPasswordMethods).toEqual([FORGOT_PASSWORD_EMAIL_METHOD]);
  });

  test("idempotent: matching http-email connector + method enabled → skip, no patch", () => {
    const p = plan({
      connectors: [
        {
          id: "c1",
          connectorId: HTTP_EMAIL_CONNECTOR_ID,
          type: "Email",
          config: { endpoint: ENDPOINT, authorization: AUTH },
        },
      ],
      methods: [FORGOT_PASSWORD_EMAIL_METHOD],
    });
    expect(p.connector).toBe("skip");
    expect(p.forgotPasswordMethods).toBeUndefined();
  });

  test("operator-owned http-email endpoint drift → conflict, never create", () => {
    const p = plan({
      connectors: [
        {
          id: "c1",
          connectorId: HTTP_EMAIL_CONNECTOR_ID,
          type: "Email",
          config: { endpoint: "http://old/webhook", authorization: "Bearer old" },
        },
      ],
      methods: [FORGOT_PASSWORD_EMAIL_METHOD],
    });
    expect(p.connector).toBe("conflict");
    expect(p.conflictConnectorId).toBe("c1");
    expect(p.connectorBody).toBeUndefined();
  });

  test("Nautilo-owned http-email endpoint with rotated secret → recreate", () => {
    const p = plan({
      connectors: [
        {
          id: "c1",
          connectorId: HTTP_EMAIL_CONNECTOR_ID,
          type: "Email",
          config: { endpoint: ENDPOINT, authorization: "Bearer old" },
        },
      ],
      methods: [FORGOT_PASSWORD_EMAIL_METHOD],
    });
    expect(p.connector).toBe("create");
    expect(p.connectorBody?.config).toEqual({
      endpoint: ENDPOINT,
      authorization: AUTH,
    });
  });

  test("preserves existing forgotPasswordMethods when enabling email", () => {
    const p = plan({ methods: ["PhoneVerificationCode"] });
    expect(p.forgotPasswordMethods).toEqual([
      "PhoneVerificationCode",
      FORGOT_PASSWORD_EMAIL_METHOD,
    ]);
  });

  test("preserves Logto null forgotPasswordMethods fallback semantics", () => {
    const p = plan({ methods: null });
    expect(p.connector).toBe("create");
    expect(p.forgotPasswordMethods).toBeUndefined();
  });

  test("foreign email connector → conflict, never create (Logto would delete it)", () => {
    const p = plan({
      connectors: [
        {
          id: "smtp-1",
          connectorId: "simple-mail-transfer-protocol",
          type: "Email",
          config: {},
        },
      ],
    });
    expect(p.connector).toBe("conflict");
    expect(p.conflictConnectorId).toBe("smtp-1");
    expect(p.connectorBody).toBeUndefined();
  });

  test("ignores non-email connectors (social/sms) when deciding", () => {
    const p = plan({
      connectors: [
        { id: "s1", connectorId: "google-universal", type: "Social", config: {} },
        { id: "sms1", connectorId: "twilio-short-message-service", type: "Sms", config: {} },
      ],
    });
    expect(p.connector).toBe("create");
  });
});
