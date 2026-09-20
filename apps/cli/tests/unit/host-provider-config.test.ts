import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRailwayProviderConfig } from "../../src/lib/host-provider-config.ts";
import { KEY_REGISTRY } from "@nautilo/config-guard";
import { HOSTING_PROVIDER_ENV_VARS, resolveProviderCapabilities } from "@nautilo/hosting";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nautilo-provider-config-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function openRouter(marker: string): string {
  return `sk-or-v1-${marker.repeat(40)}`;
}

function tavily(marker: string): string {
  return `tvly-${marker.repeat(20)}`;
}

function venice(marker: string): string {
  return marker.repeat(40);
}

async function writeProviderConfig(path: string, body: string): Promise<void> {
  await writeFile(path, body, { mode: 0o600 });
}

describe("Railway provider-only TOML", () => {
  test("deployment metadata covers every canonical provider key without accepting runtime secrets", () => {
    expect(Object.fromEntries(KEY_REGISTRY.map((key) => [key.id, key.envVar])))
      .toEqual(HOSTING_PROVIDER_ENV_VARS);
  });

  test("both downloadable template forms include every registered service", async () => {
    const railway = await readFile(new URL("../../templates/nautilo-railway-providers.toml", import.meta.url), "utf8");
    const local = await readFile(new URL("../../templates/nautilo-deploy.toml", import.meta.url), "utf8");
    for (const key of KEY_REGISTRY) {
      expect(railway).toMatch(new RegExp(`^(?:# )?${key.id} = \\{ value =`, "m"));
      expect(local).toContain(`key = "${key.envVar}"`);
    }
  });

  test("reads and selects the complete recommended bundle, with no secret values in the plan", async () => {
    const config = join(root, "providers.toml");
    const values = {
      openai: `sk-${"o".repeat(40)}`,
      anthropic: `sk-ant-${"a".repeat(40)}`,
      "browser-use": `bu_${"b".repeat(40)}`,
      elevenlabs: `sk_${"e".repeat(40)}`,
      tavily: tavily("t"),
      openrouter: openRouter("r"),
      venice: venice("v"),
      typesafe: "synthetic-typesafe-key",
      cloudconvert: ["eyJ" + "a".repeat(70), "b".repeat(70), "c".repeat(70)].join("."),
      google: "g".repeat(40),
      fireworks: `fw_${"f".repeat(40)}`,
      groq: `gsk_${"q".repeat(40)}`,
      gateway: "synthetic-gateway-value",
    };
    for (const source of ["literal", "environment"] as const) {
      await writeProviderConfig(config, [
        "schemaVersion = 1", "[providers]",
        ...Object.entries(values).map(([provider, value]) => {
          const envVar = KEY_REGISTRY.find((key) => key.id === provider)!.envVar;
          return `${provider} = ${source === "literal" ? `{ value = "${value}" }` : `{ fromEnv = "${envVar}" }`}`;
        }),
      ].join("\n"));
      const result = await resolveRailwayProviderConfig({
        providerConfigPath: config,
        environment: {
          HOME: root,
          ...Object.fromEntries(KEY_REGISTRY.map((key) => [key.envVar, values[key.id as keyof typeof values]])),
        },
      });
      expect(result.outcome).toBe("resolved");
      if (result.outcome !== "resolved") return;
      expect(Object.fromEntries([...result.providers].map(([key, value]) => [key, value.value]))).toEqual(values);
      const plan = resolveProviderCapabilities({
        references: [...result.providers].map(([provider]) => ({ provider, source: "documented-config", state: "configured" })),
        allProviders: true,
        infrastructure: "planned",
        coreDegradedConsent: false,
      });
      expect(plan.issues).toEqual([]);
      expect(plan.providers.filter((provider) => provider.selected)).toHaveLength(KEY_REGISTRY.length);
      for (const value of Object.values(values)) expect(JSON.stringify(plan)).not.toContain(value);
    }
  });

  test("resolves declared TOML providers before environment and legacy dotenv per provider", async () => {
    const config = join(root, "providers.toml");
    const compatibility = join(root, "legacy.env");
    const tomlOpenRouter = openRouter("t");
    const environmentTavily = tavily("e");
    const legacyVenice = venice("v");
    await writeProviderConfig(config, [
      "schemaVersion = 1",
      "[providers]",
      `openrouter = { value = "${tomlOpenRouter}" }`,
      'tavily = { fromEnv = "TAVILY_API_KEY" }',
      "",
    ].join("\n"));
    await writeFile(compatibility, `VENICE_API_KEY=${legacyVenice}\n`, { mode: 0o600 });

    const result = await resolveRailwayProviderConfig({
      environment: {
        HOME: root,
        OPENROUTER_API_KEY: openRouter("e"),
        TAVILY_API_KEY: environmentTavily,
        NAUTILO_DOTENV_PATH: compatibility,
      },
      providerConfigPath: config,
    });

    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.providers).toEqual(new Map([
      ["openrouter", { value: tomlOpenRouter, source: "documented-config" }],
      ["tavily", { value: environmentTavily, source: "documented-config" }],
      ["venice", { value: legacyVenice, source: "documented-config" }],
    ]));
  });

  test("uses the exact default only when no explicit path is named and treats its absence normally", async () => {
    const defaultDirectory = join(root, ".config", "nautilo");
    await mkdir(defaultDirectory, { recursive: true, mode: 0o700 });
    const defaultConfig = join(defaultDirectory, "providers.toml");
    const defaultOpenRouter = openRouter("d");
    await writeProviderConfig(defaultConfig, [
      "schemaVersion = 1",
      "[providers]",
      `openrouter = { value = "${defaultOpenRouter}" }`,
      "",
    ].join("\n"));

    const resolved = await resolveRailwayProviderConfig({
      environment: { HOME: root, OPENROUTER_API_KEY: openRouter("e") },
    });
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome === "resolved") {
      expect(resolved.providers.get("openrouter")).toEqual({
        value: defaultOpenRouter,
        source: "documented-config",
      });
    }

    const missingDefault = await resolveRailwayProviderConfig({
      environment: { HOME: join(root, "no-default"), TAVILY_API_KEY: tavily("e") },
    });
    expect(missingDefault).toEqual({
      outcome: "resolved",
      providers: new Map([["tavily", { value: tavily("e"), source: "environment" }]]),
    });
  });

  test("does not touch legacy dotenv when every provider resolves from higher-precedence sources", async () => {
    const config = join(root, "providers.toml");
    const unsafeCompatibility = join(root, "unsafe.env");
    await writeProviderConfig(config, [
      "schemaVersion = 1",
      "[providers]",
      `openrouter = { value = "${openRouter("t")}" }`,
      "",
    ].join("\n"));
    await writeFile(unsafeCompatibility, "TAVILY_API_KEY=not-read\n", { mode: 0o644 });
    await chmod(unsafeCompatibility, 0o644);
    const cloudConvert = `${"a".repeat(70)}.${"b".repeat(70)}.${"c".repeat(70)}`;

    const result = await resolveRailwayProviderConfig({
      environment: {
        HOME: root,
        TAVILY_API_KEY: tavily("e"),
        ELEVENLABS_API_KEY: `sk_${"e".repeat(24)}`,
        CLOUDCONVERT_API_KEY: cloudConvert,
        VENICE_API_KEY: venice("e"),
        TYPESAFE_API_KEY: "synthetic-typesafe-key",
        OPENAI_API_KEY: `sk-${"o".repeat(40)}`,
        ANTHROPIC_API_KEY: `sk-ant-${"a".repeat(40)}`,
        BROWSER_USE_API_KEY: `bu_${"b".repeat(40)}`,
        GOOGLE_API_KEY: "g".repeat(40),
        FIREWORKS_API_KEY: `fw_${"f".repeat(40)}`,
        GROQ_API_KEY: `gsk_${"q".repeat(40)}`,
        NAUTILO_GATEWAY_API_KEY: "synthetic-gateway-key",
        NAUTILO_DOTENV_PATH: unsafeCompatibility,
      },
      providerConfigPath: config,
    });
    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") expect(result.providers.size).toBe(KEY_REGISTRY.length);
  });

  test("fails closed for malformed process-environment and legacy-dotenv provider values", async () => {
    expect(await resolveRailwayProviderConfig({
      environment: { HOME: root, OPENROUTER_API_KEY: tavily("wrong-provider") },
    })).toEqual({ outcome: "failure", code: "railway.plan.provider-config-invalid" });

    const compatibility = join(root, "legacy.env");
    await writeFile(compatibility, "TAVILY_API_KEY=not-a-tavily-key\n", { mode: 0o600 });
    const result = await resolveRailwayProviderConfig({
      environment: { HOME: root, NAUTILO_DOTENV_PATH: compatibility },
    });
    expect(result).toEqual({ outcome: "failure", code: "railway.plan.provider-config-invalid" });
    expect(JSON.stringify(result)).not.toContain("not-a-tavily-key");
    expect(JSON.stringify(result)).not.toContain(compatibility);
  });

  test("fails closed for invalid schema, unknown fields, duplicate keys, wrong references, and invalid values", async () => {
    const invalidBodies = [
      "schemaVersion = 2\n[providers]\n",
      "schemaVersion = 1\n[providers]\nopenrouter = { value = \"value\", extra = true }\n",
      "schemaVersion = 1\n[providers]\nunknown = { value = \"value\" }\n",
      "schemaVersion = 1\n[providers]\ntavily = { fromEnv = \"OPENROUTER_API_KEY\" }\n",
      `schemaVersion = 1\n[providers]\nopenrouter = { value = "${tavily("x")}" }\n`,
      `schemaVersion = 1\nschemaVersion = 1\n[providers]\nopenrouter = { value = "${openRouter("d")}" }\n`,
    ];

    for (const [index, body] of invalidBodies.entries()) {
      const config = join(root, `invalid-${index}.toml`);
      await writeProviderConfig(config, body);
      const result = await resolveRailwayProviderConfig({
        environment: { HOME: root },
        providerConfigPath: config,
      });
      expect(result).toEqual({ outcome: "failure", code: "railway.plan.provider-config-invalid" });
      expect(JSON.stringify(result)).not.toContain(config);
      expect(JSON.stringify(result)).not.toContain(openRouter("d"));
    }
  });

  test("rejects an explicit missing, unsafe, or oversized file without exposing its path", async () => {
    expect(await resolveRailwayProviderConfig({
      environment: { HOME: root },
      providerConfigPath: "",
    })).toEqual({ outcome: "failure", code: "railway.plan.provider-config-invalid" });

    const missing = join(root, "missing.toml");
    const missingResult = await resolveRailwayProviderConfig({
      environment: { HOME: root },
      providerConfigPath: missing,
    });
    expect(missingResult).toEqual({ outcome: "failure", code: "railway.plan.provider-config-unreadable" });
    expect(JSON.stringify(missingResult)).not.toContain(missing);

    const actual = join(root, "actual.toml");
    const linked = join(root, "linked.toml");
    await writeProviderConfig(actual, "schemaVersion = 1\n[providers]\n");
    await symlink(actual, linked);
    expect(await resolveRailwayProviderConfig({
      environment: { HOME: root },
      providerConfigPath: linked,
    })).toEqual({ outcome: "failure", code: "railway.plan.provider-config-unsafe" });

    const shared = join(root, "shared.toml");
    await writeProviderConfig(shared, "schemaVersion = 1\n[providers]\n");
    await chmod(shared, 0o644);
    expect(await resolveRailwayProviderConfig({
      environment: { HOME: root },
      providerConfigPath: shared,
    })).toEqual({ outcome: "failure", code: "railway.plan.provider-config-unsafe" });

    const oversized = join(root, "oversized.toml");
    await writeProviderConfig(oversized, "#".repeat(1024 * 1024 + 1));
    expect(await resolveRailwayProviderConfig({
      environment: { HOME: root },
      providerConfigPath: oversized,
    })).toEqual({ outcome: "failure", code: "railway.plan.provider-config-too-large" });
  });

  test("does not scan an unrelated file when no documented source names it", async () => {
    const unrelated = join(root, "unrelated.toml");
    const secret = openRouter("u");
    await writeProviderConfig(unrelated, [
      "schemaVersion = 1",
      "[providers]",
      `openrouter = { value = "${secret}" }`,
      "",
    ].join("\n"));

    const result = await resolveRailwayProviderConfig({ environment: { HOME: root } });
    expect(result).toEqual({ outcome: "resolved", providers: new Map() });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(unrelated);
  });
});
