/**
 * M071 Phase 2B — compose project name and derived container names match
 * `resolveInstance()` without invoking Docker.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetResolvedInstanceForTests,
  deriveComposeContainerBundle,
  resolveInstance,
} from "@nautilo/config";
import {
  applyInfraComposeEnv,
  assertServiceSecretFallbackIsFresh,
  classifyDockerVolumeInspect,
  dockerComposeNautiloPrefixArgs,
  ensureClonedInfraCredentialAuthorityBeforeVolume,
  ensureInfraCredentialAuthorityForInfraStart,
  ensureOpenConnectorEncryptionKeyForInstance,
  formatInfraInstanceBanner,
  INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH,
  infraPersistentVolumeNames,
  inspectInfraCredentialAuthority,
  NAUTILO_COMPOSE_FILE,
  ensureInfraCryptoDbPassword,
  ensureInfraCryptoDbPasswordForInstance,
  DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
  resolveInstanceServiceSecrets,
  writeProtectedInstanceSecretFile,
} from "../../src/lib/compose-infra";
import {
  isSafeRepairCandidate,
  parseContainerNameConflict,
  waitForPgEntrypointComplete,
} from "../../src/commands/infra-start";

describe("compose propagation (M071 2B)", () => {
  let userHomeDir: string;

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-2b-"));
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  test("deriveComposeContainerBundle matches default project nautilo", () => {
    const c = deriveComposeContainerBundle("nautilo");
    expect(c.legacyPostgres).toBe("nautilo-postgres");
    expect(c.logtoPostgres).toBe("nautilo-postgres-1");
    expect(c.logtoCore).toBe("nautilo-logto-1");
  });

  test("default instance → docker compose prefix uses -p nautilo", () => {
    const env = { NAUTILO_INSTANCE_ID: "", HOME: userHomeDir } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.compose.projectName).toBe("nautilo");
    const prefix = dockerComposeNautiloPrefixArgs(inst);
    expect(prefix).toEqual([
      "compose",
      "-p",
      "nautilo",
      "-f",
      NAUTILO_COMPOSE_FILE,
    ]);
  });

  test("named instance beta → -p nautilo-beta and distinct logto postgres container", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "beta",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.compose.projectName).toBe("nautilo-beta");
    expect(inst.compose.containers.logtoPostgres).toBe("nautilo-beta-postgres-1");
    const prefix = dockerComposeNautiloPrefixArgs(inst);
    expect(prefix[2]).toBe("nautilo-beta");
    expect(infraPersistentVolumeNames(inst)).toEqual([
      "nautilo-beta_nautilo_pgdata",
      "nautilo-beta_pgdata",
    ]);
  });

  test("infra env propagation exports selected instance ports", async () => {
    const prevEnv = { ...process.env };
    try {
      const env = {
        NAUTILO_INSTANCE_ID: "beta",
        HOME: userHomeDir,
      } as NodeJS.ProcessEnv;
      process.env["HOME"] = userHomeDir;
      process.env["NAUTILO_INSTANCE_ID"] = "beta";
      const inst = resolveInstance(env, { userHomeDir });
      process.env["NAUTILO_CRYPTO_DB_PASSWORD"] =
        await ensureInfraCryptoDbPasswordForInstance(inst, env);
      applyInfraComposeEnv(inst);

      expect(process.env["NAUTILO_INSTANCE_ID"]).toBe("beta");
      expect(process.env["COMPOSE_PROJECT_NAME"]).toBe("nautilo-beta");
      expect(process.env["NAUTILO_DB_PORT"]).toBe(String(inst.db.postgresHostPort));
      expect(process.env["NAUTILO_LOGTO_PORT"]).toBe(String(inst.logto.corePort));
      expect(process.env["NAUTILO_OPENCONNECTOR_PORT"]).toBeDefined();
      expect(() => readFileSync(join(
        userHomeDir,
        ".nautilo-beta",
        DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
      ), "utf8")).toThrow();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      __resetResolvedInstanceForTests();
    }
  });

  test("creates one protected OpenConnector key and reuses it", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "beta",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const first = ensureOpenConnectorEncryptionKeyForInstance(inst, env);
    const second = ensureOpenConnectorEncryptionKeyForInstance(inst, env, {
      randomKey: () => {
        throw new Error("must not regenerate");
      },
    });
    expect(second).toEqual(first);
    expect(readFileSync(first.keyPath, "utf8").trim()).toMatch(/^[a-f0-9]{64}$/u);
    expect(statSync(first.keyPath).mode & 0o777).toBe(0o600);
    expect(first.dataDir).toBe(join(userHomeDir, ".nautilo-beta", "openconnector-data"));
  });

  test("D475: selected instance service secrets override drifted ambient credentials", () => {
    const prevEnv = { ...process.env };
    try {
      process.env["HOME"] = userHomeDir;
      process.env["NAUTILO_INSTANCE_ID"] = "beta";
      process.env["NAUTILO_DB_PASSWORD"] = "wrong-ambient-full";
      process.env["NAUTILO_AGENT_DB_PASSWORD"] = "wrong-ambient-agent";
      process.env["LOGTO_DB_PASSWORD"] = "wrong-ambient-logto";

      const root = join(userHomeDir, ".nautilo-beta");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "instance.env"),
        [
          "NAUTILO_DB_PASSWORD=selected/full",
          "NAUTILO_AGENT_DB_PASSWORD=selected agent",
          "NAUTILO_CRYPTO_DB_PASSWORD=selected crypto",
          "LOGTO_DB_PASSWORD=selected:logto",
          "POSTGRES_PASSWORD=selected-postgres",
          "",
        ].join("\n"),
      );

      const inst = resolveInstance(process.env, { userHomeDir });
      applyInfraComposeEnv(inst);

      expect(process.env["NAUTILO_DB_PASSWORD"]).toBe("selected/full");
      expect(process.env["NAUTILO_AGENT_DB_PASSWORD"]).toBe("selected agent");
      expect(process.env["NAUTILO_CRYPTO_DB_PASSWORD"]).toBeUndefined();
      expect(process.env["LOGTO_DB_PASSWORD"]).toBe("selected:logto");
      expect(process.env["DB_CONNECTION_STRING"]).toBe(
        `postgres://nautilo:selected%2Ffull@localhost:${inst.db.postgresHostPort}/nautilo`,
      );
      expect(process.env["DB_AGENT_CONNECTION_STRING"]).toBe(
        `postgres://nautilo_agent:selected%20agent@localhost:${inst.db.postgresHostPort}/nautilo`,
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      __resetResolvedInstanceForTests();
    }
  });

  test("M231: existing dev instance gets one crypto credential without rotating existing secrets", async () => {
    const instanceEnvPath = join(userHomeDir, ".nautilo-beta", "instance.env");
    const original = [
      "NAUTILO_DB_PASSWORD=selected-full",
      "NAUTILO_AGENT_DB_PASSWORD=selected-agent",
      "LOGTO_DB_PASSWORD=selected-logto",
      "",
    ].join("\n");
    let persisted: { path: string; secret: string } | undefined;
    const secret = await ensureInfraCryptoDbPassword(
      { instanceEnvPath, instanceEnvRaw: original },
      {
        randomHexPassword: () => "crypto-only",
        persistCryptoPassword: async (path, value) => {
          persisted = { path, secret: value };
        },
      },
    );

    expect(secret).toBe("crypto-only");
    expect(persisted).toEqual({
      path: join(
        userHomeDir,
        ".nautilo-beta",
        DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
      ),
      secret: "crypto-only",
    });
    expect(original).toContain("NAUTILO_DB_PASSWORD=selected-full");
    expect(original).toContain("NAUTILO_AGENT_DB_PASSWORD=selected-agent");
    expect(original).toContain("LOGTO_DB_PASSWORD=selected-logto");
  });

  test("M231: legacy dev credential migrates once into role-only authority", async () => {
    let writes = 0;
    const secret = await ensureInfraCryptoDbPassword(
      {
        instanceEnvPath: "/tmp/instance.env",
        instanceEnvRaw: "NAUTILO_CRYPTO_DB_PASSWORD=already-there\n",
      },
      {
        randomHexPassword: () => "must-not-generate",
        persistCryptoPassword: async () => {
          writes += 1;
        },
      },
    );
    expect(secret).toBe("already-there");
    expect(writes).toBe(1);
  });

  test("D475: an existing incomplete instance.env fails before mutating startup env", () => {
    const prevEnv = { ...process.env };
    try {
      process.env["HOME"] = userHomeDir;
      process.env["NAUTILO_INSTANCE_ID"] = "beta";
      process.env["NAUTILO_DB_PASSWORD"] = "ambient-must-not-win";
      delete process.env["DB_CONNECTION_STRING"];

      const root = join(userHomeDir, ".nautilo-beta");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "instance.env"),
        "NAUTILO_DB_PASSWORD=selected-full\n",
      );

      const inst = resolveInstance(process.env, { userHomeDir });
      expect(() => applyInfraComposeEnv(inst)).toThrow(
        /missing internal service credential.*NAUTILO_AGENT_DB_PASSWORD.*LOGTO_DB_PASSWORD/,
      );
      expect(process.env["NAUTILO_DB_PASSWORD"]).toBe("ambient-must-not-win");
      expect(process.env["DB_CONNECTION_STRING"]).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      __resetResolvedInstanceForTests();
    }
  });

  test("D475: missing instance.env is refused when selected volumes prove persisted state", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "beta",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const plan = resolveInstanceServiceSecrets(
      {
        instanceId: "beta",
        instanceEnvPath: join(userHomeDir, ".nautilo-beta", "instance.env"),
      },
      env,
    );
    expect(plan.source).toBe("fresh-instance-fallback");
    expect(() =>
      assertServiceSecretFallbackIsFresh(
        inst,
        plan,
        (volume) => volume === "nautilo-beta_pgdata",
      ),
    ).toThrow(/refusing development credential fallbacks.*nautilo-beta_pgdata/);
  });

  test("D475: missing instance.env fallback remains available only with no persisted volumes", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "fresh",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const plan = resolveInstanceServiceSecrets(
      {
        instanceId: "fresh",
        instanceEnvPath: join(userHomeDir, ".nautilo-fresh", "instance.env"),
      },
      env,
    );
    expect(() =>
      assertServiceSecretFallbackIsFresh(inst, plan, () => false),
    ).not.toThrow();
  });

  test("D508: an absent fresh authority publishes one random protected set and sentinel", () => {
    const env = {
      HOME: userHomeDir,
      NAUTILO_INSTANCE_ID: "fresh",
      NAUTILO_DB_PASSWORD: "ambient-must-not-persist",
      NAUTILO_AGENT_DB_PASSWORD: "ambient-agent-must-not-persist",
      LOGTO_DB_PASSWORD: "ambient-logto-must-not-persist",
      NAUTILO_CRYPTO_DB_PASSWORD: "ambient-crypto-must-not-persist",
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    let next = 0;
    const plan = ensureInfraCredentialAuthorityForInfraStart(inst, env, {
      volumeExists: () => false,
      randomHexPassword: () => `random-${++next}`,
    });
    const root = join(userHomeDir, ".nautilo-fresh");
    const instanceEnvPath = join(root, "instance.env");
    const cryptoPath = join(root, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
    const sentinelPath = join(root, INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH);

    expect(plan.source).toBe("selected-instance");
    expect(readFileSync(instanceEnvPath, "utf8")).toContain("NAUTILO_DB_PASSWORD=random-1");
    expect(readFileSync(instanceEnvPath, "utf8")).toContain("NAUTILO_AGENT_DB_PASSWORD=random-2");
    expect(readFileSync(instanceEnvPath, "utf8")).toContain("LOGTO_DB_PASSWORD=random-3");
    expect(readFileSync(instanceEnvPath, "utf8")).not.toContain("=nautilo\n");
    expect(readFileSync(instanceEnvPath, "utf8")).not.toContain("ambient-must-not-persist");
    expect(readFileSync(instanceEnvPath, "utf8")).not.toContain("ambient-agent-must-not-persist");
    expect(readFileSync(instanceEnvPath, "utf8")).not.toContain("ambient-logto-must-not-persist");
    expect(readFileSync(cryptoPath, "utf8")).toBe("random-4\n");
    expect(readFileSync(cryptoPath, "utf8")).not.toContain("ambient-crypto-must-not-persist");
    expect(readFileSync(sentinelPath, "utf8")).toContain("credential-authority-v1");
    for (const path of [instanceEnvPath, cryptoPath, sentinelPath]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(inspectInfraCredentialAuthority({
      instanceEnvPath,
      cryptoSecretPath: cryptoPath,
      sentinelPath,
      hasPersistentVolume: false,
    }).state).toBe("committed");

  });

  test("D508: every interrupted pre-volume publication is discarded and regenerated as one set", () => {
    for (const crashAfterPublish of [1, 2]) {
      const instanceId = `crash-${crashAfterPublish}`;
      const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: instanceId } as NodeJS.ProcessEnv;
      __resetResolvedInstanceForTests();
      const inst = resolveInstance(env, { userHomeDir });
      const root = join(userHomeDir, `.nautilo-${instanceId}`);
      const instanceEnvPath = join(root, "instance.env");
      const cryptoPath = join(root, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
      const sentinelPath = join(root, INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH);
      let writes = 0;

      expect(() => ensureInfraCredentialAuthorityForInfraStart(inst, env, {
        volumeExists: () => false,
        randomHexPassword: () => `interrupted-${crashAfterPublish}-${writes}`,
        writeProtectedFile: (path, contents) => {
          writeProtectedInstanceSecretFile(path, contents);
          writes += 1;
          if (writes === crashAfterPublish) throw new Error("simulated publication interruption");
        },
      })).toThrow("simulated publication interruption");

      expect(inspectInfraCredentialAuthority({
        instanceEnvPath,
        cryptoSecretPath: cryptoPath,
        sentinelPath,
        hasPersistentVolume: false,
      }).state).toBe("partial-before-volume");

      let recovered = 0;
      ensureInfraCredentialAuthorityForInfraStart(inst, env, {
        volumeExists: () => false,
        randomHexPassword: () => `recovered-${crashAfterPublish}-${++recovered}`,
      });
      const published = `${readFileSync(instanceEnvPath, "utf8")}\n${readFileSync(cryptoPath, "utf8")}`;
      expect(published).toContain(`recovered-${crashAfterPublish}-1`);
      expect(published).toContain(`recovered-${crashAfterPublish}-4`);
      expect(published).not.toContain(`interrupted-${crashAfterPublish}`);
      expect(inspectInfraCredentialAuthority({
        instanceEnvPath,
        cryptoSecretPath: cryptoPath,
        sentinelPath,
        hasPersistentVolume: false,
      }).state).toBe("committed");
    }
  });

  test("D508: sentinel is last and a post-sentinel interruption remains a committed idempotent authority", () => {
    const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: "sentinel" } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    let publications = 0;
    let secrets = 0;
    expect(() => ensureInfraCredentialAuthorityForInfraStart(inst, env, {
      volumeExists: () => false,
      randomHexPassword: () => `sentinel-${++secrets}`,
      writeProtectedFile: (path, contents) => {
        writeProtectedInstanceSecretFile(path, contents);
        publications += 1;
        if (publications === 3) throw new Error("simulated interruption after sentinel");
      },
    })).toThrow("simulated interruption after sentinel");
    const root = join(userHomeDir, ".nautilo-sentinel");
    const instanceEnvPath = join(root, "instance.env");
    const cryptoPath = join(root, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
    const sentinelPath = join(root, INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH);
    expect(inspectInfraCredentialAuthority({
      instanceEnvPath,
      cryptoSecretPath: cryptoPath,
      sentinelPath,
      hasPersistentVolume: false,
    }).state).toBe("committed");
    expect(() => ensureInfraCredentialAuthorityForInfraStart(inst, env, {
      volumeExists: () => false,
      randomHexPassword: () => { throw new Error("committed authority must not rotate"); },
    })).not.toThrow();
  });

  test("D508: partial authority after a durable volume fails closed without replacing it", () => {
    const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: "durable" } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const root = join(userHomeDir, ".nautilo-durable");
    const cryptoPath = join(root, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
    mkdirSync(join(root, ".bootstrap"), { recursive: true });
    writeFileSync(cryptoPath, "orphaned-crypto\n", { mode: 0o600 });
    let writes = 0;

    expect(() => ensureInfraCredentialAuthorityForInfraStart(inst, env, {
      volumeExists: () => true,
      randomHexPassword: () => "must-not-generate",
      writeProtectedFile: () => { writes += 1; },
    })).toThrow(/inconsistent-after-volume.*No credentials were changed/);
    expect(writes).toBe(0);
    expect(readFileSync(cryptoPath, "utf8")).toBe("orphaned-crypto\n");
  });

  test("D508: a complete durable pre-sentinel authority adopts only the marker", () => {
    for (const cryptoAuthority of ["role-only", "legacy-instance-env"] as const) {
      const instanceId = `legacy-${cryptoAuthority}`;
      const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: instanceId } as NodeJS.ProcessEnv;
      __resetResolvedInstanceForTests();
      const inst = resolveInstance(env, { userHomeDir });
      const root = join(userHomeDir, `.nautilo-${instanceId}`);
      const instanceEnvPath = join(root, "instance.env");
      const cryptoPath = join(root, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
      const sentinelPath = join(root, INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH);
      mkdirSync(join(root, ".bootstrap"), { recursive: true });
      const legacyCryptoLine = cryptoAuthority === "legacy-instance-env"
        ? "NAUTILO_CRYPTO_DB_PASSWORD=legacy-crypto\n"
        : "";
      writeFileSync(
        instanceEnvPath,
        [
          "NAUTILO_DB_PASSWORD=legacy-nautilo",
          "NAUTILO_AGENT_DB_PASSWORD=legacy-agent",
          "LOGTO_DB_PASSWORD=legacy-logto",
          legacyCryptoLine.trim(),
          "",
        ].filter(Boolean).join("\n") + "\n",
        { mode: 0o600 },
      );
      if (cryptoAuthority === "role-only") {
        writeFileSync(cryptoPath, "legacy-crypto\n", { mode: 0o600 });
      }
      const beforeEnv = readFileSync(instanceEnvPath, "utf8");
      const beforeCrypto = cryptoAuthority === "role-only"
        ? readFileSync(cryptoPath, "utf8")
        : undefined;
      const before = inspectInfraCredentialAuthority({
        instanceEnvPath,
        cryptoSecretPath: cryptoPath,
        sentinelPath,
        hasPersistentVolume: true,
      });
      expect(before.state).toBe("committed");
      expect(before.needsSentinelAdoption).toBe(true);
      const published: string[] = [];

      const plan = ensureInfraCredentialAuthorityForInfraStart(inst, env, {
        volumeExists: () => true,
        randomHexPassword: () => { throw new Error("complete durable authority must not rotate"); },
        writeProtectedFile: (path, contents) => {
          published.push(path);
          writeProtectedInstanceSecretFile(path, contents);
        },
      });

      expect(plan.source).toBe("selected-instance");
      expect(published).toEqual([sentinelPath]);
      expect(readFileSync(instanceEnvPath, "utf8")).toBe(beforeEnv);
      if (beforeCrypto !== undefined) {
        expect(readFileSync(cryptoPath, "utf8")).toBe(beforeCrypto);
      }
      expect(inspectInfraCredentialAuthority({
        instanceEnvPath,
        cryptoSecretPath: cryptoPath,
        sentinelPath,
        hasPersistentVolume: true,
      }).needsSentinelAdoption).toBe(false);
    }
  });

  test("D508: a verified legacy clone commits its copied authority before volumes", () => {
    const env = {
      HOME: userHomeDir,
      NAUTILO_INSTANCE_ID: "legacy-clone",
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const root = join(userHomeDir, ".nautilo-legacy-clone");
    const instanceEnvPath = join(root, "instance.env");
    const cryptoPath = join(root, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
    const sentinelPath = join(
      root,
      INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH,
    );
    mkdirSync(root, { recursive: true });
    const copiedEnv = [
      "NAUTILO_DB_PASSWORD=copied-nautilo",
      "NAUTILO_AGENT_DB_PASSWORD=copied-agent",
      "LOGTO_DB_PASSWORD=copied-logto",
      "LOGTO_ENDPOINT=http://localhost:4001",
      "",
    ].join("\n");
    writeFileSync(instanceEnvPath, copiedEnv, { mode: 0o600 });
    const published: string[] = [];

    const plan = ensureClonedInfraCredentialAuthorityBeforeVolume(inst, env, {
      volumeExists: () => false,
      randomHexPassword: () => "new-clone-crypto-only",
      writeProtectedFile: (path, contents) => {
        published.push(path);
        writeProtectedInstanceSecretFile(path, contents);
      },
    });

    expect(published).toEqual([cryptoPath, sentinelPath]);
    expect(readFileSync(instanceEnvPath, "utf8")).toBe(copiedEnv);
    expect(readFileSync(cryptoPath, "utf8")).toBe("new-clone-crypto-only\n");
    expect(plan.serviceSecrets).toEqual({
      NAUTILO_DB_PASSWORD: "copied-nautilo",
      NAUTILO_AGENT_DB_PASSWORD: "copied-agent",
      LOGTO_DB_PASSWORD: "copied-logto",
      NAUTILO_CRYPTO_DB_PASSWORD: "new-clone-crypto-only",
    });
    expect(inspectInfraCredentialAuthority({
      instanceEnvPath,
      cryptoSecretPath: cryptoPath,
      sentinelPath,
      hasPersistentVolume: false,
    }).state).toBe("committed");

    ensureClonedInfraCredentialAuthorityBeforeVolume(inst, env, {
      volumeExists: () => false,
      randomHexPassword: () => {
        throw new Error("committed clone authority must not rotate");
      },
      writeProtectedFile: (path, contents) => {
        published.push(path);
        writeProtectedInstanceSecretFile(path, contents);
      },
    });
    expect(published).toEqual([cryptoPath, sentinelPath]);
    expect(readFileSync(instanceEnvPath, "utf8")).toBe(copiedEnv);
  });

  test("D508: clone authority completion refuses to mutate after a volume exists", () => {
    const env = {
      HOME: userHomeDir,
      NAUTILO_INSTANCE_ID: "late-clone",
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const root = join(userHomeDir, ".nautilo-late-clone");
    mkdirSync(root, { recursive: true });
    const instanceEnvPath = join(root, "instance.env");
    const copiedEnv = [
      "NAUTILO_DB_PASSWORD=copied-nautilo",
      "NAUTILO_AGENT_DB_PASSWORD=copied-agent",
      "LOGTO_DB_PASSWORD=copied-logto",
      "",
    ].join("\n");
    writeFileSync(instanceEnvPath, copiedEnv, { mode: 0o600 });
    let writes = 0;

    expect(() => ensureClonedInfraCredentialAuthorityBeforeVolume(inst, env, {
      volumeExists: () => true,
      randomHexPassword: () => "must-not-generate",
      writeProtectedFile: () => { writes += 1; },
    })).toThrow(/must be committed before persistent volumes exist.*No credentials were changed/);
    expect(writes).toBe(0);
    expect(readFileSync(instanceEnvPath, "utf8")).toBe(copiedEnv);
  });

  test("D508: pre-volume recovery preserves unrelated Logto projection while replacing partial authority", () => {
    const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: "projection" } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const root = join(userHomeDir, ".nautilo-projection");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "instance.env"), "LOGTO_ENDPOINT=http://localhost:3301\n", { mode: 0o600 });

    ensureInfraCredentialAuthorityForInfraStart(inst, env, {
      volumeExists: () => false,
      randomHexPassword: () => "projection-random",
    });

    const persisted = readFileSync(join(root, "instance.env"), "utf8");
    expect(persisted).toContain("LOGTO_ENDPOINT=http://localhost:3301");
    expect(persisted).toContain("NAUTILO_DB_PASSWORD=projection-random");
  });

  test("D475: an unavailable volume authority fails closed instead of proving freshness", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "uncertain",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    const plan = resolveInstanceServiceSecrets(
      {
        instanceId: "uncertain",
        instanceEnvPath: join(userHomeDir, ".nautilo-uncertain", "instance.env"),
      },
      env,
    );
    expect(() =>
      assertServiceSecretFallbackIsFresh(inst, plan, () => {
        throw new Error("Docker daemon unavailable");
      }),
    ).toThrow(/Docker daemon unavailable/);
  });

  test("D475: Docker volume inspection distinguishes absence from authority failure", () => {
    expect(
      classifyDockerVolumeInspect({
        status: 1,
        stderr: "Error response from daemon: get example: no such volume",
      }),
    ).toBe(false);
    expect(
      classifyDockerVolumeInspect({ status: 0, stderr: "" }),
    ).toBe(true);
    expect(() =>
      classifyDockerVolumeInspect({
        status: 1,
        stderr: "Cannot connect to the Docker daemon",
      }),
    ).toThrow(/cannot prove this instance is fresh/);
  });

  test("infra instance banner distinguishes shared default from isolated named", () => {
    const defaultEnv = { NAUTILO_INSTANCE_ID: "", HOME: userHomeDir } as NodeJS.ProcessEnv;
    const defaultInst = resolveInstance(defaultEnv, { userHomeDir });
    const defaultBanner = formatInfraInstanceBanner(defaultInst);
    expect(defaultBanner).toContain("instance: shared default");
    expect(defaultBanner).toContain("data dir: ~/.nautilo");
    expect(defaultBanner).toContain("compose project: nautilo");

    __resetResolvedInstanceForTests();
    const namedEnv = { NAUTILO_INSTANCE_ID: "beta", HOME: userHomeDir } as NodeJS.ProcessEnv;
    const namedInst = resolveInstance(namedEnv, { userHomeDir });
    const namedBanner = formatInfraInstanceBanner(namedInst);
    expect(namedBanner).toContain("instance: isolated named (beta)");
    expect(namedBanner).toContain("data dir: ~/.nautilo-beta");
    expect(namedBanner).toContain("compose project: nautilo-beta");
  });

  test("infra orphan repair only accepts expected current-project containers", () => {
    const expected = new Set(["nautilo-postgres"]);

    expect(
      isSafeRepairCandidate(
        {
          name: "nautilo-postgres",
          status: "exited",
          project: "nautilo",
          service: "postgres",
        },
        expected,
        "nautilo",
      ),
    ).toBe(true);

    expect(
      isSafeRepairCandidate(
        {
          name: "other-postgres",
          status: "exited",
          project: "other",
          service: "postgres",
        },
        expected,
        "nautilo",
      ),
    ).toBe(false);

    expect(
      isSafeRepairCandidate(
        {
          name: "nautilo-postgres",
          status: "exited",
          project: "different-project",
          service: "postgres",
        },
        expected,
        "nautilo",
      ),
    ).toBe(false);
  });

  test("infra orphan repair parses Docker name-conflict errors", () => {
    const stderr = [
      'Error response from daemon: Conflict. The container name "/nautilo-postgres"',
      'is already in use by container "abc123".',
    ].join(" ");

    expect(parseContainerNameConflict(stderr)).toBe("nautilo-postgres");
    expect(parseContainerNameConflict("some other docker failure")).toBeNull();
  });

  test("infra-start waits only for legacy postgres health (M215)", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/commands/infra-start.ts"),
      "utf8",
    );

    expect(source).toContain("waitForPgReady");
    expect(source).not.toContain("waitForNeonProxyReady");
    expect(source).not.toContain("Neon-Pool-Opt-In");
    expect(source).toContain("expectedContainers: [inst.compose.containers.legacyPostgres]");
  });

  test("D475: persisted roles are repaired before Logto seed and migrations", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/commands/infra-start.ts"),
      "utf8",
    );
    const appRepair = source.indexOf(
      'console.log("[infra:start] reconciling persisted Nautilo service roles...")',
    );
    const logtoRepair = source.indexOf(
      'console.log("[infra:start] reconciling persisted Logto service role...")',
    );
    const logtoStack = source.indexOf(
      '"[infra:start] bringing up Logto compose stack (postgres + logto + logto-seed)..."',
    );
    const migrations = source.indexOf(
      'console.log("[infra:start] applying nautilo DB migrations...")',
    );

    expect(appRepair).toBeGreaterThan(0);
    expect(logtoRepair).toBeGreaterThan(appRepair);
    expect(logtoStack).toBeGreaterThan(logtoRepair);
    expect(migrations).toBeGreaterThan(logtoStack);
  });

  test("D508: PostgreSQL readiness waits through the temporary init server", async () => {
    let probes = 0;
    await waitForPgEntrypointComplete("fresh-postgres", 1_000, {
      pollIntervalMs: 1,
      probe: () => Promise.resolve(++probes >= 3),
    });
    expect(probes).toBe(3);
  });
});
