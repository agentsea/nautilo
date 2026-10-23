import { expect, test } from "bun:test";
import postgres from "postgres";
import { readDisposableCleanupUrls, withDisposableFixtureCleanup } from "../../scripts/disposable-postgres-cleanup";
import { DISPOSABLE_RESET_CONTAINER_ENV, DISPOSABLE_RESET_PORT_ENV, DISPOSABLE_RESET_TOKEN_ENV } from "../../scripts/disposable-postgres-reset";

const urls = {
  admin: "postgres://postgres:admin@127.0.0.1:55432/nautilo",
  app: "postgres://nautilo:app@127.0.0.1:55432/nautilo",
  agent: "postgres://nautilo_agent:agent@127.0.0.1:55432/nautilo",
  crypto: "postgres://nautilo_crypto:crypto@127.0.0.1:55432/nautilo",
};
const env = {
  LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL: urls.admin,
  LATTICE_BRIDGE_TEST_APP_DATABASE_URL: urls.app,
  LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL: urls.agent,
  LATTICE_BRIDGE_TEST_DATABASE_URL: urls.crypto,
  [DISPOSABLE_RESET_CONTAINER_ENV]: "nautilo-lattice-bridge-test-unit",
  [DISPOSABLE_RESET_PORT_ENV]: "55432",
  [DISPOSABLE_RESET_TOKEN_ENV]: "a".repeat(64),
};

test("cleanup requires complete exact role URLs and explicit container authority", () => {
  expect(readDisposableCleanupUrls(env)).toEqual(urls);
  expect(() => readDisposableCleanupUrls({})).toThrow("Missing disposable cleanup environment");
  expect(() => readDisposableCleanupUrls({ ...env, [DISPOSABLE_RESET_TOKEN_ENV]: undefined }))
    .toThrow("token authority is missing");
  expect(() => readDisposableCleanupUrls({ ...env, LATTICE_BRIDGE_TEST_DATABASE_URL: urls.app }))
    .toThrow("crypto database URL is outside");
});

for (const [name, url] of [
  ["app-role handle", urls.app],
  ["another port", "postgres://postgres:admin@127.0.0.1:55433/nautilo"],
  ["another database", "postgres://postgres:admin@127.0.0.1:55432/other"],
] as const) {
  test(`cleanup refuses ${name} before executing any SQL`, async () => {
    const client = postgres(url, { max: 1 });
    let invoked = false;
    try {
      const error = await withDisposableFixtureCleanup(client, async () => { invoked = true; }, env)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exact disposable administrator connection");
      expect(invoked).toBe(false);
    } finally {
      await client.end();
    }
  });
}
