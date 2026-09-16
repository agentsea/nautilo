import { describe, expect, test } from "bun:test";

import type {
  ConnectionRecord,
  ConnectionRef,
  ConnectionRefWithId,
  ConnectionScope,
  StoreConnectionOptions,
  UnlockVaultOptions,
  VaultBackend,
  VaultState,
} from "@nautilo/types";
import {
  ConfigSecretResolutionError,
  parseConfigValueRef,
  resolveConfigValueRef,
  secretRefForConnection,
} from "../../src/secret-ref";

class MemoryVault implements VaultBackend {
  readonly state: VaultState = "plaintext_open";
  readonly vaultFilePath = "memory://config-test";
  private readonly rows = new Map<string, Uint8Array>();

  unlock(_options?: UnlockVaultOptions): Promise<void> {
    return Promise.resolve();
  }
  lock(): void {}
  enableEncryption(_options?: UnlockVaultOptions): Promise<void> {
    return Promise.resolve();
  }
  async get(ref: ConnectionRefWithId, _scope: ConnectionScope): Promise<Uint8Array | null> {
    return this.rows.get(`${ref.service}.${ref.field}`) ?? null;
  }
  async set(
    ref: ConnectionRef,
    value: Uint8Array,
    _scope: ConnectionScope,
    _options?: StoreConnectionOptions,
  ): Promise<void> {
    this.rows.set(`${ref.service}.${ref.field}`, Buffer.from(value));
  }
  list(_scope: ConnectionScope): Promise<ConnectionRecord[]> {
    return Promise.resolve([]);
  }
  delete(_ref: ConnectionRefWithId, _scope: ConnectionScope): Promise<boolean> {
    return Promise.resolve(false);
  }
  rotateKey(): Promise<void> {
    return Promise.resolve();
  }
}

const scope: ConnectionScope = {
  agentId: "agent-a",
  defaultNamespaceId: "ns-a",
  readableNamespaceIds: ["ns-a"],
};

describe("secret: config references", () => {
  test("parses literal, env, and secret references", () => {
    expect(parseConfigValueRef("literal")).toEqual({ kind: "literal", value: "literal" });
    expect(parseConfigValueRef("env:OPENAI_API_KEY")).toEqual({
      kind: "env",
      name: "OPENAI_API_KEY",
    });
    expect(parseConfigValueRef("secret:openai.api_key")).toEqual({
      kind: "secret",
      name: "openai.api_key",
      ref: { service: "openai", field: "api_key" },
    });
  });

  test("resolves env and secret references server-side", async () => {
    const vault = new MemoryVault();
    await vault.set(
      { service: "openai", field: "api_key" },
      Buffer.from("from-vault"),
      scope,
    );

    expect(await resolveConfigValueRef("literal")).toBe("literal");
    expect(
      await resolveConfigValueRef("env:OPENAI_API_KEY", {
        env: { OPENAI_API_KEY: "from-env" },
      }),
    ).toBe("from-env");
    expect(
      await resolveConfigValueRef("secret:openai.api_key", { vault, scope }),
    ).toBe("from-vault");
  });

  test("throws typed errors without exposing secret values", async () => {
    expect(() => parseConfigValueRef("secret:not-valid")).toThrow(ConfigSecretResolutionError);
    let missingEnv: unknown;
    try {
      await resolveConfigValueRef("env:MISSING", { env: {} });
    } catch (e) {
      missingEnv = e;
    }
    expect(missingEnv).toMatchObject({ code: "MISSING_ENV" });

    let missingVault: unknown;
    try {
      await resolveConfigValueRef("secret:openai.api_key");
    } catch (e) {
      missingVault = e;
    }
    expect(missingVault).toMatchObject({ code: "MISSING_VAULT" });

    let missingSecret: unknown;
    try {
      await resolveConfigValueRef("secret:openai.api_key", {
        vault: new MemoryVault(),
        scope,
      });
    } catch (e) {
      missingSecret = e;
    }
    expect(missingSecret).toMatchObject({ code: "MISSING_SECRET" });
  });

  test("formats canonical secret references", () => {
    expect(secretRefForConnection({ service: "github", field: "token" })).toBe(
      "secret:github.token",
    );
  });
});
