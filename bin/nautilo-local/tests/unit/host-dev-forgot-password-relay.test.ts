/**
 * M120 — host-run dev server ForgotPassword relay wiring.
 *
 * The dev flow (`infra:start` + host `bun run server`, `--with-logto`)
 * must reach the host-run server from the Logto container via
 * `host.docker.internal:<serverPort>` and persist a shared webhook secret
 * to instance.env.
 */
import { describe, expect, test } from "bun:test";
import {
  buildHostDevWebhookEndpoint,
  resolveHostDevWebhookSecret,
  FORGOT_PASSWORD_WEBHOOK_SECRET_KEY,
  parseDotenvSecret,
  type HostDevRelaySecretDeps,
} from "../../src/bootstrap-logto";

describe("buildHostDevWebhookEndpoint", () => {
  test("targets host.docker.internal at the instance server port", () => {
    expect(buildHostDevWebhookEndpoint(4401)).toBe(
      "http://host.docker.internal:4401/api/internal/logto/email-webhook",
    );
    expect(buildHostDevWebhookEndpoint(3001)).toBe(
      "http://host.docker.internal:3001/api/internal/logto/email-webhook",
    );
  });
});

describe("parseDotenvSecret", () => {
  test("returns the value for a present key", () => {
    expect(parseDotenvSecret(`${FORGOT_PASSWORD_WEBHOOK_SECRET_KEY}=abc123`, FORGOT_PASSWORD_WEBHOOK_SECRET_KEY)).toBe(
      "abc123",
    );
  });

  test("strips surrounding quotes", () => {
    expect(
      parseDotenvSecret(`${FORGOT_PASSWORD_WEBHOOK_SECRET_KEY}="abc123"`, FORGOT_PASSWORD_WEBHOOK_SECRET_KEY),
    ).toBe("abc123");
  });

  test("ignores comments and other keys", () => {
    const raw = [
      "# a comment",
      "OTHER_KEY=nope",
      `${FORGOT_PASSWORD_WEBHOOK_SECRET_KEY}=found`,
    ].join("\n");
    expect(parseDotenvSecret(raw, FORGOT_PASSWORD_WEBHOOK_SECRET_KEY)).toBe("found");
  });

  test("returns undefined for a missing or empty value", () => {
    expect(parseDotenvSecret("", FORGOT_PASSWORD_WEBHOOK_SECRET_KEY)).toBeUndefined();
    expect(
      parseDotenvSecret(`${FORGOT_PASSWORD_WEBHOOK_SECRET_KEY}=`, FORGOT_PASSWORD_WEBHOOK_SECRET_KEY),
    ).toBeUndefined();
  });
});

describe("resolveHostDevWebhookSecret", () => {
  test("reuses an existing secret from instance.env", () => {
    const deps: HostDevRelaySecretDeps = {
      readInstanceEnv: () => `${FORGOT_PASSWORD_WEBHOOK_SECRET_KEY}=existing-secret`,
      randomSecret: () => "should-not-be-used",
    };
    expect(resolveHostDevWebhookSecret(deps)).toBe("existing-secret");
  });

  test("generates a fresh secret when absent (no write side-effect)", () => {
    const deps: HostDevRelaySecretDeps = {
      readInstanceEnv: () => "",
      randomSecret: () => "fresh-secret",
    };
    expect(resolveHostDevWebhookSecret(deps)).toBe("fresh-secret");
  });
});
