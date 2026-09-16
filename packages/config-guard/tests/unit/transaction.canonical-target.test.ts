import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeGoogleOAuthClientJsonForEnv,
  GOOGLE_OAUTH_CLIENT_JSON_ENV,
} from "../../src/google-oauth-client-json";
import { resetConfigGuardRateLimitForTests, transaction } from "../../src/transaction";
import { getAllKeyDefinitions } from "../../src/key-registry";
import { LOGTO_REQUIRED_KEYS } from "../../src/mode-registry";

// D445 Phase 0 — regression coverage for the compose env_file / container-local
// instance.env split-brain. The deployed/container contract is: an explicit
// `NAUTILO_DOTENV_PATH` pointing at a writable mounted file shared with compose.
// A missing/unwritable canonical target must fail CLOSED before mutation so
// `process.env` (populated by compose `env_file`) is left unchanged — instead
// of treating an empty fallback as authority and stripping every provider key.

const VALID_GOOGLE_JSON = JSON.stringify({
  installed: {
    client_id: "111111111111-client.apps.googleusercontent.com",
    client_secret: "GOCSPX-canonical-target-test",
  },
});

const OPENAI_VALUE = "sk-proj-canonical-target-fixture-1234567890";
const TAVILY_VALUE = "tvly-canonical-target-12345";

function clearRegistryEnvVars(): void {
  for (const def of getAllKeyDefinitions()) {
    delete process.env[def.envVar];
  }
  delete process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
  delete process.env["NAUTILO_REMOTE_PAIRING_PEPPER"];
  for (const key of LOGTO_REQUIRED_KEYS) delete process.env[key];
}

describe("transaction canonical-target guard (D445 Phase 0)", () => {
  let home: string;
  let envPath: string;
  const prevHome = process.env["HOME"];
  const prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
  const prevNautiloHome = process.env["NAUTILO_HOME"];

  beforeEach(async () => {
    clearRegistryEnvVars();
    home = await mkdtemp(join(tmpdir(), "cg-canonical-"));
    envPath = join(home, "config", "instance.env");
    process.env["HOME"] = home;
    delete process.env["NAUTILO_HOME"];
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
    resetConfigGuardRateLimitForTests();
  });

  afterEach(async () => {
    clearRegistryEnvVars();
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    if (prevNautiloHome !== undefined) process.env["NAUTILO_HOME"] = prevNautiloHome;
    else delete process.env["NAUTILO_HOME"];
    if (prevDotenv !== undefined) process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    else delete process.env["NAUTILO_DOTENV_PATH"];
    await rm(home, { recursive: true, force: true });
    resetConfigGuardRateLimitForTests();
  });

  test("missing canonical target: set fails closed and preserves compose-injected provider keys", async () => {
    // Topology: compose env_file injected provider keys into process.env,
    // but the container-local canonical file is MISSING (no mount / authority).
    process.env["OPENAI_API_KEY"] = OPENAI_VALUE;
    process.env["TAVILY_API_KEY"] = TAVILY_VALUE;

    const r = await transaction({
      operations: [
        {
          type: "set",
          key: GOOGLE_OAUTH_CLIENT_JSON_ENV,
          value: encodeGoogleOAuthClientJsonForEnv(VALID_GOOGLE_JSON),
        },
      ],
      healthCheck: "none",
      overwrite: true,
      reason: "google oauth upload",
      actor: "agent",
    });

    expect(r.success).toBe(false);
    expect(r.rolledBack).toBe(false);
    expect(r.applied).toBe(0);
    // Pre-fix this would strip every provider key from process.env; the guard
    // refuses to mutate, so the compose-injected keys survive untouched.
    expect(process.env["OPENAI_API_KEY"]).toBe(OPENAI_VALUE);
    expect(process.env["TAVILY_API_KEY"]).toBe(TAVILY_VALUE);
    expect(process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV]).toBeUndefined();
    // Secret-safe: the error must not echo the encoded Google credential.
    expect(r.error).toContain("Canonical config target is missing");
    expect(r.error).not.toContain(encodeGoogleOAuthClientJsonForEnv(VALID_GOOGLE_JSON));
    expect(r.error).not.toContain("GOCSPX");
  });

  test("missing canonical target: clear fails closed and preserves provider keys", async () => {
    process.env["OPENAI_API_KEY"] = OPENAI_VALUE;
    process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV] = encodeGoogleOAuthClientJsonForEnv(
      VALID_GOOGLE_JSON,
    );

    const r = await transaction({
      operations: [{ type: "remove", key: GOOGLE_OAUTH_CLIENT_JSON_ENV }],
      healthCheck: "none",
      overwrite: true,
      reason: "google oauth clear",
      actor: "agent",
    });

    expect(r.success).toBe(false);
    expect(r.applied).toBe(0);
    expect(process.env["OPENAI_API_KEY"]).toBe(OPENAI_VALUE);
    // The pre-existing Google credential in process.env is also left untouched.
    expect(process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV]).toBeDefined();
  });

  test("unwritable canonical target: set fails closed and leaves process.env unchanged", async () => {
    if (process.platform === "win32") return;
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(envPath, `OPENAI_API_KEY=${OPENAI_VALUE}\n`, "utf-8");
    await chmod(join(home, "config"), 0o500); // dir not writable
    process.env["TAVILY_API_KEY"] = TAVILY_VALUE;

    let r: Awaited<ReturnType<typeof transaction>>;
    try {
      r = await transaction({
        operations: [
          {
            type: "set",
            key: GOOGLE_OAUTH_CLIENT_JSON_ENV,
            value: encodeGoogleOAuthClientJsonForEnv(VALID_GOOGLE_JSON),
          },
        ],
        healthCheck: "none",
        overwrite: true,
        reason: "google oauth upload",
        actor: "agent",
      });
    } finally {
      // Restore writability so afterEach can rm the temp tree.
      await chmod(join(home, "config"), 0o700).catch(() => undefined);
    }

    expect(r!.success).toBe(false);
    expect(r!.applied).toBe(0);
    expect(process.env["TAVILY_API_KEY"]).toBe(TAVILY_VALUE);
    expect(r!.error).toContain("not writable");
    expect(r!.error).not.toContain("GOCSPX");
  });

  test("populated canonical target: set preserves unrelated keys on disk and in process.env", async () => {
    // Topology: the mounted canonical file IS the compose env_file source,
    // so it already holds the compose-injected provider keys.
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      envPath,
      `OPENAI_API_KEY=${OPENAI_VALUE}\nTAVILY_API_KEY=${TAVILY_VALUE}\n`,
      "utf-8",
    );
    process.env["OPENAI_API_KEY"] = OPENAI_VALUE;
    process.env["TAVILY_API_KEY"] = TAVILY_VALUE;

    const r = await transaction({
      operations: [
        {
          type: "set",
          key: GOOGLE_OAUTH_CLIENT_JSON_ENV,
          value: encodeGoogleOAuthClientJsonForEnv(VALID_GOOGLE_JSON),
        },
      ],
      healthCheck: "none",
      overwrite: true,
      reason: "google oauth upload",
      actor: "agent",
    });

    expect(r.success).toBe(true);
    expect(r.applied).toBe(1);

    const disk = await readFile(envPath, "utf-8");
    expect(disk).toContain("OPENAI_API_KEY=" + OPENAI_VALUE);
    expect(disk).toContain("TAVILY_API_KEY=" + TAVILY_VALUE);
    expect(disk).toContain(GOOGLE_OAUTH_CLIENT_JSON_ENV + "=");
    // Running process sees all three.
    expect(process.env["OPENAI_API_KEY"]).toBe(OPENAI_VALUE);
    expect(process.env["TAVILY_API_KEY"]).toBe(TAVILY_VALUE);
    expect(process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV]).toBeDefined();
    // Snapshot + audit share the explicit dotenv parent, so the complete
    // transaction record persists in the same narrow directory mount.
    expect((await readdir(join(home, "config", "config-snapshots"))).length).toBeGreaterThan(0);
    expect(await readFile(join(home, "config", "config-audit.jsonl"), "utf8")).toContain(
      GOOGLE_OAUTH_CLIENT_JSON_ENV,
    );
  });

  test("canonical Logto block overrides a partial orchestrator environment", async () => {
    await mkdir(join(home, "config"), { recursive: true });
    const logtoLines = LOGTO_REQUIRED_KEYS.map((key) => {
      const value = key.includes("ENDPOINT") || key.includes("ISSUER") || key.includes("URI")
        ? "http://127.0.0.1:3501/oidc"
        : `fixture-${key.toLowerCase()}`;
      return `${key}=${value}`;
    });
    await writeFile(envPath, `${logtoLines.join("\n")}\n`, "utf-8");

    // dev-stack prepares routing in the parent process before server-start,
    // leaving LOGTO_ENDPOINT ambient while the full block lives on disk.
    process.env["LOGTO_ENDPOINT"] = "http://127.0.0.1:3501";

    const result = await transaction({
      operations: [
        {
          type: "set",
          key: "NAUTILO_REMOTE_PAIRING_PEPPER",
          value: "ab".repeat(32),
        },
      ],
      healthCheck: "none",
      overwrite: true,
      reason: "remote pairing pepper boot initialization",
      actor: "cli",
    });

    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
    const disk = await readFile(envPath, "utf-8");
    expect(disk).toContain("NAUTILO_REMOTE_PAIRING_PEPPER=" + "ab".repeat(32));
    for (const line of logtoLines) expect(disk).toContain(line);
  });

  test("populated canonical target: clear removes only the Google key and preserves providers", async () => {
    await mkdir(join(home, "config"), { recursive: true });
    const encoded = encodeGoogleOAuthClientJsonForEnv(VALID_GOOGLE_JSON);
    await writeFile(
      envPath,
      `OPENAI_API_KEY=${OPENAI_VALUE}\nTAVILY_API_KEY=${TAVILY_VALUE}\n${GOOGLE_OAUTH_CLIENT_JSON_ENV}=${encoded}\n`,
      "utf-8",
    );
    process.env["OPENAI_API_KEY"] = OPENAI_VALUE;
    process.env["TAVILY_API_KEY"] = TAVILY_VALUE;
    process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV] = encoded;

    const r = await transaction({
      operations: [{ type: "remove", key: GOOGLE_OAUTH_CLIENT_JSON_ENV }],
      healthCheck: "none",
      overwrite: true,
      reason: "google oauth clear",
      actor: "agent",
    });

    expect(r.success).toBe(true);
    expect(r.applied).toBe(1);

    const disk = await readFile(envPath, "utf-8");
    expect(disk).toContain("OPENAI_API_KEY=" + OPENAI_VALUE);
    expect(disk).toContain("TAVILY_API_KEY=" + TAVILY_VALUE);
    expect(disk).not.toContain(GOOGLE_OAUTH_CLIENT_JSON_ENV + "=");
    expect(process.env["OPENAI_API_KEY"]).toBe(OPENAI_VALUE);
    expect(process.env["TAVILY_API_KEY"]).toBe(TAVILY_VALUE);
    // config-guard's reload strips only KEY_REGISTRY entries absent from disk;
    // GOOGLE_OAUTH_CLIENT_JSON is a MODE_REGISTRY key, so its process.env
    // removal is the server store's responsibility (covered there).
  });

  test("durability: a recreated container re-reading the canonical file loads Google + providers", async () => {
    // Simulate container recreation: compose re-reads env_file from the same
    // canonical disk file. After a set, the disk file is the single authority
    // a fresh container would load.
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      envPath,
      `OPENAI_API_KEY=${OPENAI_VALUE}\nTAVILY_API_KEY=${TAVILY_VALUE}\n`,
      "utf-8",
    );

    const r = await transaction({
      operations: [
        {
          type: "set",
          key: GOOGLE_OAUTH_CLIENT_JSON_ENV,
          value: encodeGoogleOAuthClientJsonForEnv(VALID_GOOGLE_JSON),
        },
      ],
      healthCheck: "none",
      overwrite: true,
      reason: "google oauth upload",
      actor: "agent",
    });
    expect(r.success).toBe(true);

    // A "recreated container" loads env from the canonical file only.
    const recreated = new Map<string, string>();
    for (const line of (await readFile(envPath, "utf-8")).split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) recreated.set(line.slice(0, eq), line.slice(eq + 1));
    }
    expect(recreated.get("OPENAI_API_KEY")).toBe(OPENAI_VALUE);
    expect(recreated.get("TAVILY_API_KEY")).toBe(TAVILY_VALUE);
    expect(recreated.get(GOOGLE_OAUTH_CLIENT_JSON_ENV)).toBeDefined();
    // Secret-safe: the on-disk Google value is base64 (not plaintext), and the
    // fixture secret never appears as a literal in the file.
    expect(recreated.get(GOOGLE_OAUTH_CLIENT_JSON_ENV)).not.toContain("GOCSPX");
  });
});
