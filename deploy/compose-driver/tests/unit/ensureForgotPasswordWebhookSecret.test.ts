/**
 * M120 — ensureForgotPasswordWebhookSecret: read-or-generate-and-persist.
 */
import { describe, expect, test, mock } from "bun:test";
import {
  ensureForgotPasswordWebhookSecret,
  WEBHOOK_SECRET_KEY,
} from "../../src/ensureForgotPasswordWebhookSecret.ts";

describe("ensureForgotPasswordWebhookSecret (M120)", () => {
  test("returns the existing secret without writing when already present", async () => {
    const write = mock(async () => {});
    const secret = await ensureForgotPasswordWebhookSecret(
      { instanceRootDir: "/x" },
      {
        readInstanceEnv: async () => `${WEBHOOK_SECRET_KEY}=already-here\nFOO=bar\n`,
        writeSecretToInstanceEnv: write,
        randomSecret: () => "should-not-be-used",
      },
    );
    expect(secret).toBe("already-here");
    expect(write).not.toHaveBeenCalled();
  });

  test("generates + persists a secret when absent", async () => {
    let persisted: string | undefined;
    const secret = await ensureForgotPasswordWebhookSecret(
      { instanceRootDir: "/x" },
      {
        readInstanceEnv: async () => "FOO=bar\n",
        writeSecretToInstanceEnv: async (s) => {
          persisted = s;
        },
        randomSecret: () => "fresh-secret-123",
      },
    );
    expect(secret).toBe("fresh-secret-123");
    expect(persisted).toBe("fresh-secret-123");
  });

  test("treats an empty/blank value as absent and regenerates", async () => {
    const secret = await ensureForgotPasswordWebhookSecret(
      { instanceRootDir: "/x" },
      {
        readInstanceEnv: async () => `${WEBHOOK_SECRET_KEY}=\n`,
        writeSecretToInstanceEnv: async () => {},
        randomSecret: () => "regenerated",
      },
    );
    expect(secret).toBe("regenerated");
  });

  test("strips surrounding quotes on an existing value", async () => {
    const secret = await ensureForgotPasswordWebhookSecret(
      { instanceRootDir: "/x" },
      {
        readInstanceEnv: async () => `${WEBHOOK_SECRET_KEY}="quoted-secret"\n`,
        writeSecretToInstanceEnv: async () => {},
        randomSecret: () => "x",
      },
    );
    expect(secret).toBe("quoted-secret");
  });
});
