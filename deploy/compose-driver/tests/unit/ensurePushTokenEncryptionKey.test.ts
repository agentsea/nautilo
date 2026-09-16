import { describe, expect, mock, test } from "bun:test";

import {
  PUSH_TOKEN_ENCRYPTION_KEY,
  ensurePushTokenEncryptionKey,
  isValidPushTokenEncryptionKey,
} from "../../src/ensurePushTokenEncryptionKey.ts";

const key = "c".repeat(64);

describe("ensurePushTokenEncryptionKey (D468)", () => {
  test("reuses a valid canonical key and never re-generates it", async () => {
    const write = mock(async () => key);
    const randomKey = mock(() => "d".repeat(64));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().resolves is thenable; the rule's type inference doesn't see through it.
    await expect(ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => `${PUSH_TOKEN_ENCRYPTION_KEY}=${key}\n`,
      writeKeyToInstanceEnv: write,
      randomKey,
    })).resolves.toBe(key);
    expect(write).not.toHaveBeenCalled();
    expect(randomKey).not.toHaveBeenCalled();
  });

  test("fails closed before persistence for a malformed generated key", async () => {
    const write = mock(async () => key);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => "",
      writeKeyToInstanceEnv: write,
      randomKey: () => "not-a-key",
    })).rejects.toThrow(/invalid/);
    expect(write).not.toHaveBeenCalled();
    expect(isValidPushTokenEncryptionKey(key)).toBe(true);
  });
});
