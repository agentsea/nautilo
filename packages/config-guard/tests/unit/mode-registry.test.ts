import { describe, expect, test } from "bun:test";
import {
  classifyForbiddenInInstanceEnv,
  getModeByEnvVar,
  getModeById,
  LOGTO_REQUIRED_KEYS,
  MODE_REGISTRY,
} from "../../src/mode-registry";
import { crossKeyInvariants, validateOperations } from "../../src/validator";
import { FULL_LOGTO_PROCESS_ENV } from "../fixtures/full-logto-env";

describe("MODE_REGISTRY", () => {
  test("contains 13 LOGTO_* entries, gateway, web research, OpenRouter, M071 instance env, protected recovery/push/pairing secrets, M116 DB passwords, and CloudConvert knobs (D120 A1.P1 retired the default-agent/default-owner pointers)", () => {
    expect(MODE_REGISTRY.length).toBe(47);
    expect(MODE_REGISTRY[0]?.envVar).toBe("LOGTO_ENDPOINT");
    const logtoCount = MODE_REGISTRY.filter((m) =>
      m.envVar.startsWith("LOGTO_"),
    ).length;
    expect(logtoCount).toBe(13);
    expect(getModeByEnvVar("NAUTILO_GATEWAY_BASE_URL")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_GATEWAY_LABEL")).toBeDefined();
    expect(getModeByEnvVar("OPENROUTER_HTTP_REFERER")).toBeDefined();
    expect(getModeByEnvVar("OPENROUTER_TITLE")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_PORT")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_FEDERATED_HOSTNAME")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_HOSTNAME")?.deprecated).toBe(true);
    expect(getModeByEnvVar("COMPOSE_PROJECT_NAME")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_REMOTE_PAIRING_PEPPER")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY")).toBeDefined();
    expect(getModeByEnvVar("NAUTILO_PASSWORD_RECOVERY_DRIVER")).toBeDefined();
    expect(getModeByEnvVar("CLOUDCONVERT_SANDBOX")).toBeDefined();
    expect(getModeByEnvVar("CLOUDCONVERT_REGION")).toBeDefined();
    expect(getModeByEnvVar("GOOGLE_OAUTH_CLIENT_JSON")).toBeDefined();
    // D120 A1.P1 — these keys are no longer recognized by config-guard.
    // The DB is the source of truth (findClaimedOwnerId /
    // findDefaultAgentForOwner) and `red-team-env-var.sh` treats their
    // presence in source OR instance.env as a hard failure.
    expect(getModeByEnvVar("NAUTILO_DEFAULT_AGENT_ID")).toBeUndefined();
    expect(getModeByEnvVar("NAUTILO_OWNER_ID")).toBeUndefined();
  });

  test("LOGTO_REQUIRED_KEYS derives from the registry (excludes M116 LOGTO_DB_PASSWORD which is deploy-only)", () => {
    expect(LOGTO_REQUIRED_KEYS.length).toBe(11);
    expect(LOGTO_REQUIRED_KEYS).toContain("LOGTO_ENDPOINT");
    expect(LOGTO_REQUIRED_KEYS).toContain("LOGTO_M2M_APP_SECRET");
    // M055 — Electron desktop has its own Native app id (RFC 8252 §7.3
    // port-flex requires Native, not SPA).
    expect(LOGTO_REQUIRED_KEYS).toContain("LOGTO_DESKTOP_APP_ID");
    // M199 — mobile Expo client custom-scheme PKCE Native app id.
    expect(LOGTO_REQUIRED_KEYS).toContain("LOGTO_MOBILE_APP_ID");
    expect(LOGTO_REQUIRED_KEYS).not.toContain("LOGTO_MOBILE_WEB_APP_ID");
    expect(LOGTO_REQUIRED_KEYS).toContain("LOGTO_TUI_LOOPBACK_APP_ID");
    // M116 — deploy-path DB password; not part of the OIDC identity contract.
    expect(LOGTO_REQUIRED_KEYS).not.toContain("LOGTO_DB_PASSWORD");
  });

  test("M116 password keys, recovery/pairing secrets, and the push-token key are marked redact", () => {
    const redacted = MODE_REGISTRY.filter((m) => m.redact);
    expect(redacted.length).toBe(10);
    expect(redacted.map((m) => m.envVar).sort()).toEqual(
      [
        "APP_DB_PASSWORD",
        "GOOGLE_OAUTH_CLIENT_JSON",
        "LOGTO_DB_PASSWORD",
        "LOGTO_M2M_APP_SECRET",
        "NAUTILO_AGENT_DB_PASSWORD",
        "NAUTILO_DB_PASSWORD",
        "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET",
        "NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY",
        "NAUTILO_REMOTE_PAIRING_PEPPER",
        "POSTGRES_PASSWORD",
      ].sort(),
    );
  });

  test("M231 crypto-role password is setup-only and forbidden in server config", () => {
    expect(
      classifyForbiddenInInstanceEnv("NAUTILO_CRYPTO_DB_PASSWORD"),
    ).toEqual({
      category: "setup-time-only",
      remediation:
        "persist it in the role-only .bootstrap credential authority; never mount it into the Nautilo server",
    });
    const result = validateOperations(
      [
        {
          type: "set",
          key: "NAUTILO_CRYPTO_DB_PASSWORD",
          value: "a".repeat(48),
        },
      ],
      { overwrite: true, existingEnv: {} },
    );
    expect(result.errors[0]).toContain("forbidden in instance.env");
  });

  test("getModeByEnvVar / getModeById round-trip", () => {
    const def = getModeByEnvVar("LOGTO_ENDPOINT");
    expect(def?.id).toBe("LOGTO_ENDPOINT");
    expect(getModeById("LOGTO_ENDPOINT")?.envVar).toBe("LOGTO_ENDPOINT");
    expect(getModeByEnvVar("DOES_NOT_EXIST")).toBeUndefined();
  });

  test("LOGTO_ENDPOINT validator accepts http(s) URLs only", () => {
    const ep = getModeByEnvVar("LOGTO_ENDPOINT");
    expect(ep?.validator("https://auth.example.com")).toBeNull();
    expect(ep?.validator("http://localhost:3301")).toBeNull();
    expect(typeof ep?.validator("auth.example.com")).toBe("string");
    expect(typeof ep?.validator("ftp://x.example.com")).toBe("string");
  });

  test("LOGTO_M2M_APP_SECRET validator requires non-empty", () => {
    const sec = getModeByEnvVar("LOGTO_M2M_APP_SECRET");
    expect(sec?.validator("anything")).toBeNull();
    expect(typeof sec?.validator("")).toBe("string");
  });

  test("remote pairing pepper accepts at least 32 random bytes in hex and rejects weak values", () => {
    const pepper = getModeByEnvVar("NAUTILO_REMOTE_PAIRING_PEPPER");
    expect(pepper?.validator("a".repeat(64))).toBeNull();
    expect(pepper?.validator("a".repeat(62))).toContain("at least 32 bytes");
    expect(pepper?.validator("not-hex")).toContain("hexadecimal");
  });

  test("push-token encryption key requires exactly 32 random bytes in hex", () => {
    const key = getModeByEnvVar("NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY");
    expect(key?.validator("a".repeat(64))).toBeNull();
    expect(key?.validator("a".repeat(62))).toContain("32-byte");
    expect(key?.validator("g".repeat(64))).toContain("hexadecimal");
  });

  test("gateway validators accept http(s) base URL and non-empty label", () => {
    const baseUrl = getModeByEnvVar("NAUTILO_GATEWAY_BASE_URL");
    expect(baseUrl?.validator("http://localhost:4000/v1")).toBeNull();
    expect(baseUrl?.validator("https://gateway.example.test/v1")).toBeNull();
    expect(typeof baseUrl?.validator("file:///tmp/gateway")).toBe("string");
    expect(typeof baseUrl?.validator("https://")).toBe("string");

    const label = getModeByEnvVar("NAUTILO_GATEWAY_LABEL");
    expect(label?.validator("Local Gateway")).toBeNull();
    expect(typeof label?.validator("   ")).toBe("string");
  });

  test("web research provider accepts only the runtime's three compatible values", () => {
    const provider = getModeByEnvVar("NAUTILO_SEARCH_PROVIDER");
    expect(provider?.validator("auto")).toBeNull();
    expect(provider?.validator("tavily")).toBeNull();
    expect(provider?.validator("duckduckgo_html")).toBeNull();
    expect(provider?.validator("duckduckgo")).not.toBeNull();
  });

  test("OpenRouter attribution validators match runtime header rules", () => {
    const referer = getModeByEnvVar("OPENROUTER_HTTP_REFERER");
    expect(referer?.validator("https://nautilo.example")).toBeNull();
    expect(typeof referer?.validator("not-a-url")).toBe("string");
    expect(typeof referer?.validator("   ")).toBe("string");
    expect(typeof referer?.validator("https://ok\r\n")).toBe("string");

    const title = getModeByEnvVar("OPENROUTER_TITLE");
    expect(title?.validator("Nautilo")).toBeNull();
    expect(typeof title?.validator("")).toBe("string");
    expect(typeof title?.validator("bad\n")).toBe("string");
  });

  test("M071 NAUTILO_PORT accepts valid ports and rejects junk", () => {
    const def = getModeByEnvVar("NAUTILO_PORT");
    expect(def?.validator("3001")).toBeNull();
    expect(def?.validator("65535")).toBeNull();
    expect(typeof def?.validator("70000")).toBe("string");
    expect(typeof def?.validator("3x01")).toBe("string");
  });

  test("M071 NAUTILO_INSTANCE_ID accepts valid named ids and rejects invalid", () => {
    const def = getModeByEnvVar("NAUTILO_INSTANCE_ID");
    expect(def?.validator("")).toBeNull();
    expect(def?.validator("beta")).toBeNull();
    expect(def?.validator("stack-b")).toBeNull();
    expect(typeof def?.validator("Beta")).toBe("string");
    expect(typeof def?.validator("-bad")).toBe("string");
    expect(typeof def?.validator("a".repeat(33))).toBe("string");
  });

  test("M071 NAUTILO_SERVER_URL requires http(s)", () => {
    const def = getModeByEnvVar("NAUTILO_SERVER_URL");
    expect(def?.validator("http://127.0.0.1:3001")).toBeNull();
    expect(typeof def?.validator("ftp://x")).toBe("string");
  });

  test("M071 NAUTILO_TLS_SAN accepts comma-separated hostnames", () => {
    const def = getModeByEnvVar("NAUTILO_TLS_SAN");
    expect(def?.validator("a.local,b.local")).toBeNull();
    expect(typeof def?.validator("a.local,")).toBe("string");
  });

  test("M071 COMPOSE_PROJECT_NAME must be lowercase docker-safe", () => {
    const def = getModeByEnvVar("COMPOSE_PROJECT_NAME");
    expect(def?.validator("nautilo")).toBeNull();
    expect(typeof def?.validator("Nautilo")).toBe("string");
    expect(typeof def?.validator("9bad")).toBe("string");
  });

  test("CloudConvert sandbox accepts true/false/empty only", () => {
    const def = getModeByEnvVar("CLOUDCONVERT_SANDBOX");
    expect(def?.validator("")).toBeNull();
    expect(def?.validator("true")).toBeNull();
    expect(def?.validator("false")).toBeNull();
    expect(typeof def?.validator("yes")).toBe("string");
    expect(typeof def?.validator("1")).toBe("string");
  });

  test("CloudConvert region accepts us-east/eu-central/empty only", () => {
    const def = getModeByEnvVar("CLOUDCONVERT_REGION");
    expect(def?.validator("")).toBeNull();
    expect(def?.validator("us-east")).toBeNull();
    expect(def?.validator("eu-central")).toBeNull();
    expect(typeof def?.validator("auto")).toBe("string");
    expect(typeof def?.validator("us-west")).toBe("string");
  });
});

describe("classifyForbiddenInInstanceEnv (M091)", () => {
  test("classifies setup-time-only keys by prefix", () => {
    const pin = classifyForbiddenInInstanceEnv("NAUTILO_BOOTSTRAP_PIN_TEST_1");
    expect(pin).not.toBeNull();
    expect(pin!.category).toBe("setup-time-only");
    expect(pin!.remediation.length).toBeGreaterThan(0);
    expect(classifyForbiddenInInstanceEnv("NAUTILO_CLAIM_INVITE_BETA")?.category).toBe(
      "setup-time-only",
    );
    expect(classifyForbiddenInInstanceEnv("NAUTILO_ADMIN_PASSWORD")?.category).toBe(
      "setup-time-only",
    );
  });

  test("classifies retired keys exactly", () => {
    expect(classifyForbiddenInInstanceEnv("AUTH_MODE")?.category).toBe("retired");
    expect(classifyForbiddenInInstanceEnv("NAUTILO_OWNER_ID")?.category).toBe("retired");
  });

  test("returns null for carve-out, normal providers, and LOGTO_*", () => {
    expect(classifyForbiddenInInstanceEnv("NAUTILO_BOOTSTRAP_TOKEN")).toBeNull();
    expect(classifyForbiddenInInstanceEnv("OPENAI_API_KEY")).toBeNull();
    expect(classifyForbiddenInInstanceEnv("LOGTO_ENDPOINT")).toBeNull();
  });
});

describe("validateOperations + MODE_REGISTRY", () => {
  test("accepts a non-LOGTO set when merged env already has every LOGTO_* key", () => {
    const { errors } = validateOperations(
      [{ type: "set", key: "COMPOSE_PROJECT_NAME", value: "nautilo" }],
      { overwrite: true, existingEnv: { ...FULL_LOGTO_PROCESS_ENV } },
    );
    expect(errors).toEqual([]);
  });

  test("M055: cross-key flags missing LOGTO_DESKTOP_APP_ID in merged env", () => {
    const partial: NodeJS.ProcessEnv = {
      LOGTO_ENDPOINT: "http://localhost:3301",
      LOGTO_ISSUER: "http://localhost:3301/oidc",
      LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
      LOGTO_RESOURCE: "https://api.nautilo.local",
      LOGTO_WORKBENCH_APP_ID: "wb",
      LOGTO_TUI_APP_ID: "tui",
      LOGTO_M2M_APP_ID: "m2m",
      LOGTO_M2M_APP_SECRET: "secret",
      // LOGTO_DESKTOP_APP_ID intentionally missing
    };
    const { errors } = validateOperations([], {
      overwrite: true,
      existingEnv: partial,
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("LOGTO_DESKTOP_APP_ID");
  });

  test("rejects removed legacy auth env var set op (M072) via forbidden-instance guard", () => {
    const legacyAuthEnvKey = "AUTH" + "_" + "MODE";
    const { errors } = validateOperations(
      [{ type: "set", key: legacyAuthEnvKey, value: "logto" }],
      { overwrite: true, existingEnv: { ...FULL_LOGTO_PROCESS_ENV } },
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("forbidden in instance.env (retired)");
    expect(errors[0]).toContain(legacyAuthEnvKey);
  });

  test("rejects bad LOGTO_ENDPOINT format", () => {
    const { errors } = validateOperations(
      [{ type: "set", key: "LOGTO_ENDPOINT", value: "not-a-url" }],
      { overwrite: true, existingEnv: {} },
    );
    expect(errors[0]).toContain("LOGTO_ENDPOINT");
    expect(errors[0]).toContain("http(s) URL");
  });

  test("accepts valid OPENROUTER_HTTP_REFERER and OPENROUTER_TITLE", () => {
    const { errors } = validateOperations(
      [
        { type: "set", key: "OPENROUTER_HTTP_REFERER", value: "https://nautilo.example" },
        { type: "set", key: "OPENROUTER_TITLE", value: "Nautilo" },
      ],
      { overwrite: true, existingEnv: { ...FULL_LOGTO_PROCESS_ENV } },
    );
    expect(errors).toEqual([]);
  });

  test("rejects invalid OPENROUTER_HTTP_REFERER via MODE_REGISTRY", () => {
    const { errors } = validateOperations(
      [{ type: "set", key: "OPENROUTER_HTTP_REFERER", value: "not-a-url" }],
      { overwrite: true, existingEnv: { ...FULL_LOGTO_PROCESS_ENV } },
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("OPENROUTER_HTTP_REFERER");
  });

  test("rejects OPENROUTER_TITLE with embedded newlines", () => {
    const { errors } = validateOperations(
      [{ type: "set", key: "OPENROUTER_TITLE", value: "a\nb" }],
      { overwrite: true, existingEnv: { ...FULL_LOGTO_PROCESS_ENV } },
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("OPENROUTER_TITLE");
  });

  test("MODE_REGISTRY remove operations are accepted", () => {
    const { apply, errors } = validateOperations(
      [{ type: "remove", key: "NAUTILO_HOSTNAME" }],
      {
        overwrite: false,
        existingEnv: {
          ...FULL_LOGTO_PROCESS_ENV,
          NAUTILO_HOSTNAME: "legacy.local",
        },
      },
    );
    expect(errors).toEqual([]);
    expect(apply[0]?.operation.type).toBe("remove");
  });

  test("cross-key: pre-bootstrap window (zero LOGTO_* keys present) does NOT fire the invariant (M116)", () => {
    // M116 carve-out: ensureDbPasswords needs to write DB passwords to
    // instance.env BEFORE bootstrap-logto runs. At that point zero LOGTO_*
    // OIDC keys are present in the merged env, and the invariant must
    // stay silent or the deploy aborts.
    const { errors } = validateOperations([], {
      overwrite: true,
      existingEnv: {},
    });
    expect(errors).toEqual([]);
  });

  test("cross-key: any one LOGTO_* key present requires every LOGTO_* key", () => {
    const { errors } = validateOperations([], {
      overwrite: true,
      existingEnv: { LOGTO_ENDPOINT: "http://localhost:3301" },
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Logto configuration requires every LOGTO_* key");
    // Every other LOGTO_* key surfaces in the missing list.
    for (const k of LOGTO_REQUIRED_KEYS) {
      if (k === "LOGTO_ENDPOINT") continue;
      expect(errors[0]).toContain(k);
    }
  });

  test("cross-key: merged env with one missing LOGTO_* key flags only that key", () => {
    const partial: NodeJS.ProcessEnv = {
      LOGTO_ENDPOINT: "http://localhost:3301",
      LOGTO_ISSUER: "http://localhost:3301/oidc",
      LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
      LOGTO_RESOURCE: "https://api.nautilo.local",
      LOGTO_WORKBENCH_APP_ID: "wb",
      LOGTO_TUI_APP_ID: "tui",
      LOGTO_M2M_APP_ID: "m2m",
      // LOGTO_M2M_APP_SECRET intentionally missing
    };
    const { errors } = validateOperations([], {
      overwrite: true,
      existingEnv: partial,
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("LOGTO_M2M_APP_SECRET");
    expect(errors[0]).not.toContain("LOGTO_ENDPOINT,");
  });
});

describe("crossKeyInvariants (pure)", () => {
  test("M116: empty env (pre-bootstrap window) returns no errors", () => {
    expect(crossKeyInvariants({})).toEqual([]);
  });

  test("any one LOGTO_* key present triggers the invariant for the rest", () => {
    const errs = crossKeyInvariants({ LOGTO_ENDPOINT: "http://localhost:3301" });
    expect(errs.length).toBe(1);
    for (const k of LOGTO_REQUIRED_KEYS) {
      if (k === "LOGTO_ENDPOINT") continue;
      expect(errs[0]).toContain(k);
    }
  });

  test("returns no errors when every LOGTO_* is set", () => {
    expect(crossKeyInvariants({ ...FULL_LOGTO_PROCESS_ENV })).toEqual([]);
  });

  test("treats whitespace-only LOGTO_* values as missing", () => {
    const env: Record<string, string> = { ...FULL_LOGTO_PROCESS_ENV } as Record<
      string,
      string
    >;
    for (const k of LOGTO_REQUIRED_KEYS) {
      env[k] = "  ";
    }
    const errs = crossKeyInvariants(env);
    expect(errs.length).toBe(1);
  });
});
