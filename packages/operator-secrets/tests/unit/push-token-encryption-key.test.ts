import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  PUSH_TOKEN_ENCRYPTION_KEY,
  ensurePushTokenEncryptionKey,
  isValidPushTokenEncryptionKey,
} from "../../src/push-token-encryption-key.ts";

const encryptionKey = "a".repeat(64);

describe("ensurePushTokenEncryptionKey (D468)", () => {
  test("reuses an existing valid key without writing or generating", async () => {
    const write = mock(async () => encryptionKey);
    const randomKey = mock(() => "b".repeat(64));
    const result = await ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => `${PUSH_TOKEN_ENCRYPTION_KEY}=${encryptionKey}\n`,
      writeKeyToInstanceEnv: write,
      randomKey,
    });
    expect(result).toBe(encryptionKey);
    expect(write).not.toHaveBeenCalled();
    expect(randomKey).not.toHaveBeenCalled();
  });

  test("generates and persists an exact 32-byte hexadecimal key when absent", async () => {
    let persisted: string | undefined;
    const result = await ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => "OTHER=value\n",
      writeKeyToInstanceEnv: async (value) => {
        persisted = value;
        return value;
      },
      randomKey: () => encryptionKey,
    });
    expect(result).toBe(encryptionKey);
    expect(persisted).toBe(encryptionKey);
    expect(isValidPushTokenEncryptionKey(result)).toBe(true);
  });

  test("treats a blank value as missing but fails closed for malformed existing keys", async () => {
    const regenerated = await ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => `${PUSH_TOKEN_ENCRYPTION_KEY}=  \n`,
      writeKeyToInstanceEnv: async () => encryptionKey,
      randomKey: () => encryptionKey,
    });
    expect(regenerated).toBe(encryptionKey);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(
      ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
        readInstanceEnv: async () => `${PUSH_TOKEN_ENCRYPTION_KEY}=not-a-32-byte-key\n`,
        writeKeyToInstanceEnv: async () => encryptionKey,
        randomKey: () => encryptionKey,
      }),
    ).rejects.toThrow(/invalid/);
  });

  test("rejects a malformed generated key before it can be persisted", async () => {
    const write = mock(async () => encryptionKey);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(
      ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
        readInstanceEnv: async () => "",
        writeKeyToInstanceEnv: write,
        randomKey: () => "not-a-secret",
      }),
    ).rejects.toThrow(/generator returned an invalid value/);
    expect(write).not.toHaveBeenCalled();
  });

  test("redacts persistence failures even when a dependency error contains the key", async () => {
    let message = "";
    try {
      await ensurePushTokenEncryptionKey({ instanceRootDir: "/x" }, {
        readInstanceEnv: async () => "",
        writeKeyToInstanceEnv: async () => {
          throw new Error(`persistence failed for ${encryptionKey}`);
        },
        randomKey: () => encryptionKey,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("could not be persisted");
    expect(message).not.toContain(encryptionKey);
  });

  test("concurrent callers converge on the canonical persisted value", async () => {
    let canonical: string | undefined;
    let writes = 0;
    let generated = 0;
    const root = "/concurrent-instance";
    const deps = {
      readInstanceEnv: async () =>
        canonical === undefined
          ? ""
          : `${PUSH_TOKEN_ENCRYPTION_KEY}=${canonical}\n`,
      writeKeyToInstanceEnv: async (candidate: string) => {
        writes += 1;
        await Promise.resolve();
        canonical ??= candidate;
        return canonical;
      },
      randomKey: () => (++generated).toString(16).padStart(64, "0"),
    };

    const values = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensurePushTokenEncryptionKey({ instanceRootDir: root }, deps),
      ),
    );

    expect(new Set(values)).toEqual(new Set([canonical!]));
    expect(writes).toBe(1);
    expect(generated).toBe(1);
  });

  test("default guarded writer reads back from the requested instance root", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-push-key-"));
    const envPath = join(root, "instance.env");
    writeFileSync(envPath, "OTHER=value\n", { mode: 0o600 });
    try {
      const moduleUrl = new URL(
        "../../src/push-token-encryption-key.ts",
        import.meta.url,
      ).href;
      const script = `
        import { defaultEnsurePushTokenEncryptionKeyDeps, ensurePushTokenEncryptionKey } from ${JSON.stringify(moduleUrl)};
        const root = process.argv[1];
        const deps = defaultEnsurePushTokenEncryptionKeyDeps();
        const first = await ensurePushTokenEncryptionKey({ instanceRootDir: root }, deps);
        const second = await ensurePushTokenEncryptionKey({ instanceRootDir: root }, deps);
        if (first !== second) throw new Error("key did not converge");
      `;
      const child = spawnSync(process.execPath, ["--eval", script, root], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          NAUTILO_HOSTING_MODE: "",
          NAUTILO_INSTANCE_ID: "",
          NAUTILO_DOTENV_PATH: envPath,
          [PUSH_TOKEN_ENCRYPTION_KEY]: "",
        },
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(0);
      expect(readFileSync(envPath, "utf8")).toContain(
        `${PUSH_TOKEN_ENCRYPTION_KEY}=`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
