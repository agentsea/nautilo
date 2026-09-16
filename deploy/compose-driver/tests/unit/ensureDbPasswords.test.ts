import { describe, expect, test } from "bun:test";
import {
  ensureDbPasswords,
  ensureCryptoPasswordInDotenv,
  setCryptoPasswordInDotenv,
  type DbPasswords,
  type EnsureDbPasswordsDeps,
} from "../../src/ensureDbPasswords.ts";

function makeDeps(
  over: Partial<EnsureDbPasswordsDeps> = {},
  state: {
    written?: { passwords: DbPasswords; generatedAt: string };
    cryptoPassword?: string;
    removedLegacyCrypto?: boolean;
  } = {},
): EnsureDbPasswordsDeps {
  return {
    readInstanceEnv: async () => "",
    inspectAppPgdataVolume: async () => false,
    probeAgentRole: async () => null,
    writePasswordsToInstanceEnv: async (passwords, generatedAt) => {
      state.written = { passwords, generatedAt };
    },
    readCryptoDbPassword: async () => state.cryptoPassword,
    writeCryptoDbPassword: async (_root, password) => {
      state.cryptoPassword = password;
    },
    removeCryptoDbPasswordFromInstanceEnv: async () => {
      state.removedLegacyCrypto = true;
    },
    randomHexPassword: () => "deadbeef".repeat(6),
    now: () => new Date("2026-05-21T12:00:00.000Z"),
    ...over,
  };
}

const baseArgs = {
  instanceRootDir: "/tmp/instance",
  composeProjectName: "nautilo-test",
  appPostgresHostPort: 6434,
};

describe("ensureDbPasswords", () => {
  test("Branch 1 — sentinel present returns persisted passwords without write or probe", async () => {
    const state: {
      written?: { passwords: DbPasswords; generatedAt: string };
      cryptoPassword?: string;
      removedLegacyCrypto?: boolean;
    } = {};
    let probeCalls = 0;
    const deps = makeDeps(
      {
        readInstanceEnv: async () =>
          [
            "APP_DB_PASSWORD=pw1",
            "POSTGRES_PASSWORD=pw2",
            "NAUTILO_DB_PASSWORD=pw3",
            "LOGTO_DB_PASSWORD=pw4",
            "NAUTILO_AGENT_DB_PASSWORD=pw5",
            "NAUTILO_CRYPTO_DB_PASSWORD=pw6",
            "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT=2026-05-21T12:00:00.000Z",
          ].join("\n"),
        probeAgentRole: async () => {
          probeCalls += 1;
          return "present";
        },
      },
      state,
    );

    const result = await ensureDbPasswords(baseArgs, deps);

    expect(result).toEqual({
      appDbPassword: "pw1",
      postgresPassword: "pw2",
      nautilo: "pw3",
      logto: "pw4",
      nautiloAgent: "pw5",
      nautiloCrypto: "pw6",
    });
    expect(state.written).toBeUndefined();
    expect(state.cryptoPassword).toBe("pw6");
    expect(state.removedLegacyCrypto).toBe(true);
    expect(probeCalls).toBe(0);
  });

  test("Branch 2 — greenfield generates and writes passwords without probe", async () => {
    const state: {
      written?: { passwords: DbPasswords; generatedAt: string };
      cryptoPassword?: string;
    } = {};
    let probeCalls = 0;
    const deps = makeDeps(
      {
        readInstanceEnv: async () => "",
        inspectAppPgdataVolume: async () => false,
        probeAgentRole: async () => {
          probeCalls += 1;
          return "present";
        },
      },
      state,
    );

    const result = await ensureDbPasswords(baseArgs, deps);

    expect(result).toEqual({
      appDbPassword: "deadbeef".repeat(6),
      postgresPassword: "deadbeef".repeat(6),
      nautilo: "deadbeef".repeat(6),
      logto: "deadbeef".repeat(6),
      nautiloAgent: "deadbeef".repeat(6),
      nautiloCrypto: "deadbeef".repeat(6),
    });
    expect(state.written).toEqual({
      passwords: result,
      generatedAt: "2026-05-21T12:00:00.000Z",
    });
    expect(state.cryptoPassword).toBe("deadbeef".repeat(6));
    expect(probeCalls).toBe(0);
  });

  test("Branch 3 stale volume — role present preserves well-known literals and adds only crypto", async () => {
    const state: {
      written?: { passwords: DbPasswords; generatedAt: string };
    } = {};
    let probeCalls = 0;
    const deps = makeDeps(
      {
        readInstanceEnv: async () => "",
        inspectAppPgdataVolume: async () => true,
        probeAgentRole: async () => {
          probeCalls += 1;
          return "present";
        },
      },
      state,
    );

    const result = await ensureDbPasswords(baseArgs, deps);

    expect(result).toEqual({
      appDbPassword: "postgres",
      postgresPassword: "postgres",
      nautilo: "nautilo",
      logto: "logto",
      nautiloAgent: "nautilo_agent",
      nautiloCrypto: "deadbeef".repeat(6),
    });
    expect(state.written?.passwords).toEqual(result);
    expect(probeCalls).toBe(1);
  });

  test("Branch 3 stale volume — role absent generates and writes", async () => {
    const state: {
      written?: { passwords: DbPasswords; generatedAt: string };
    } = {};
    const deps = makeDeps(
      {
        readInstanceEnv: async () => "",
        inspectAppPgdataVolume: async () => true,
        probeAgentRole: async () => "absent",
      },
      state,
    );

    const result = await ensureDbPasswords(baseArgs, deps);

    expect(result.appDbPassword).toBe("deadbeef".repeat(6));
    expect(state.written?.generatedAt).toBe("2026-05-21T12:00:00.000Z");
  });

  test("Branch 4 — volume exists but cluster unreachable throws", async () => {
    const deps = makeDeps({
      readInstanceEnv: async () => "",
      inspectAppPgdataVolume: async () => true,
      probeAgentRole: async () => null,
    });

    let caught: unknown;
    try {
      await ensureDbPasswords(baseArgs, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/unreachable/);
  });

  test("Branch 1 inconsistency — sentinel present but password missing throws", async () => {
    const deps = makeDeps({
      readInstanceEnv: async () =>
        "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT=2026-05-21T12:00:00.000Z\n",
    });

    let caught: unknown;
    try {
      await ensureDbPasswords(baseArgs, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/missing from instance.env/);
  });

  test("legacy five-password sentinel generates only crypto and preserves every existing secret", async () => {
    const state: {
      written?: { passwords: DbPasswords; generatedAt: string };
      cryptoPassword?: string;
    } = {};
    let generated = 0;
    const deps = makeDeps(
      {
        readInstanceEnv: async () =>
          [
            "APP_DB_PASSWORD=pw1",
            "POSTGRES_PASSWORD=pw2",
            "NAUTILO_DB_PASSWORD=pw3",
            "LOGTO_DB_PASSWORD=pw4",
            "NAUTILO_AGENT_DB_PASSWORD=pw5",
            "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT=2026-05-21T12:00:00.000Z",
          ].join("\n"),
        randomHexPassword: () => {
          generated += 1;
          return "crypto-only";
        },
      },
      state,
    );

    const result = await ensureDbPasswords(baseArgs, deps);

    expect(generated).toBe(1);
    expect(result).toEqual({
      appDbPassword: "pw1",
      postgresPassword: "pw2",
      nautilo: "pw3",
      logto: "pw4",
      nautiloAgent: "pw5",
      nautiloCrypto: "crypto-only",
    });
    expect(state.written).toBeUndefined();
    expect(state.cryptoPassword).toBe("crypto-only");
  });

  test("role-only persisted crypto credential wins and does not rewrite instance.env", async () => {
    const state: {
      written?: { passwords: DbPasswords; generatedAt: string };
      cryptoPassword?: string;
    } = { cryptoPassword: "role-only" };
    const deps = makeDeps(
      {
        readInstanceEnv: async () =>
          [
            "APP_DB_PASSWORD=pw1",
            "POSTGRES_PASSWORD=pw2",
            "NAUTILO_DB_PASSWORD=pw3",
            "LOGTO_DB_PASSWORD=pw4",
            "NAUTILO_AGENT_DB_PASSWORD=pw5",
            "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT=2026-05-21T12:00:00.000Z",
          ].join("\n"),
      },
      state,
    );

    const result = await ensureDbPasswords(baseArgs, deps);

    expect(result.nautiloCrypto).toBe("role-only");
    expect(state.written).toBeUndefined();
  });
});

describe("ensureCryptoPasswordInDotenv", () => {
  test("extracts a restored crypto credential from server-mounted config", () => {
    const result = ensureCryptoPasswordInDotenv(
      "NAUTILO_DB_PASSWORD=owner\nNAUTILO_CRYPTO_DB_PASSWORD=restored\n",
      () => "must-not-generate",
    );
    expect(result.secret).toBe("restored");
    expect(result.raw).not.toContain("NAUTILO_CRYPTO_DB_PASSWORD");
  });

  test("generates a missing crypto credential without adding it to server config", () => {
    const raw =
      "NAUTILO_DB_PASSWORD=owner\nNAUTILO_AGENT_DB_PASSWORD=agent\n";
    const result = ensureCryptoPasswordInDotenv(raw, () => "new-crypto");
    expect(result.secret).toBe("new-crypto");
    expect(result.raw).toContain("NAUTILO_DB_PASSWORD=owner");
    expect(result.raw).toContain("NAUTILO_AGENT_DB_PASSWORD=agent");
    expect(result.raw).not.toContain("NAUTILO_CRYPTO_DB_PASSWORD");
  });

  test("re-pins a generated compose env without duplicating the key", () => {
    const raw =
      "NAUTILO_CRYPTO_DB_PASSWORD=old\nNAUTILO_DB_PASSWORD=owner\n";
    const updated = setCryptoPasswordInDotenv(raw, "restored");
    expect(updated).toContain("NAUTILO_DB_PASSWORD=owner");
    expect(updated).toContain("NAUTILO_CRYPTO_DB_PASSWORD=restored");
    expect(updated.match(/NAUTILO_CRYPTO_DB_PASSWORD=/g)).toHaveLength(1);
  });
});
