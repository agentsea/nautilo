import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  canonicalInstanceEnvPath,
  CONFIG_CONTAINER_DIR,
  CONFIG_CONTAINER_ENV_PATH,
  ensureCanonicalConfigLayout,
  RUNTIME_CONFIG_DIR_NAME,
  runtimeConfigDir,
  serverOverlayYaml,
} from "../../src/ComposeDriver.ts";

// D445 Phase 0 — focused coverage for the server overlay wiring that gives
// the deployed container one durable writable canonical compose config
// target. The overlay must (a) set NAUTILO_DOTENV_PATH at the mounted file,
// (b) bind-mount the dedicated runtime-config DIRECTORY (not a single file,
// so config-guard's atomic temp-write + rename stays durable), and
// (c) keep env_file pointing at the same host instance.env so compose and
// config-guard share one authority. env_file is resolved client-side; the
// volumes source is resolved daemon-side, so the two may differ for remote.

describe("serverOverlayYaml D445 Phase 0 canonical config wiring", () => {
  test("emits NAUTILO_DOTENV_PATH at the mounted config file", () => {
    const out = serverOverlayYaml("/h/srv.env", "/h/instance.env");
    expect(out).toContain(`NAUTILO_DOTENV_PATH: ${CONFIG_CONTAINER_ENV_PATH}`);
    expect(CONFIG_CONTAINER_ENV_PATH).toBe(`${CONFIG_CONTAINER_DIR}/instance.env`);
  });

  test("derives the crypto-role URL only inside the private server overlay", () => {
    const out = serverOverlayYaml("/h/srv.env", "/h/instance.env");
    expect(out).toContain("DB_CRYPTO_CONNECTION_STRING:");
    expect(out).toContain("postgres://nautilo_crypto:${NAUTILO_CRYPTO_DB_PASSWORD:");
    expect(out).toContain("@app-postgres:5432/nautilo");
    expect(out).not.toContain("crypto-secret");
  });

  test("mounts the dedicated config directory and preserves the named data volumes", () => {
    const out = serverOverlayYaml(
      "/h/srv.env",
      `/h/${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
    );
    expect(out).toContain(
      `- /h/${RUNTIME_CONFIG_DIR_NAME}:${CONFIG_CONTAINER_DIR}`,
    );
    // The base template's named data volumes are re-listed so a REPLACE-style
    // volume merge does not drop artifacts/media/apps.
    expect(out).toContain("- app_artifacts:/var/lib/nautilo/artifacts");
    expect(out).toContain("- app_media:/var/lib/nautilo/media");
    expect(out).toContain("- app_apps:/var/lib/nautilo/apps");
    // The mount exposes ONLY the runtime-config directory (no sibling host
    // paths are bind-mounted).
    const mountLines = out
      .split("\n")
      .filter((l) => l.includes(CONFIG_CONTAINER_DIR) && l.includes("-"));
    expect(mountLines).toHaveLength(1);
  });

  test("keeps env_file order: instance.env before deploy.server.env", () => {
    const instanceEnv = `/h/${RUNTIME_CONFIG_DIR_NAME}/instance.env`;
    const out = serverOverlayYaml("/h/deploy.server.env", instanceEnv);
    const i = out.indexOf(instanceEnv);
    const s = out.indexOf("/h/deploy.server.env");
    expect(i).toBeLessThan(s);
    expect(out).toContain("env_file:");
  });

  test("inserts an optional managed provider environment between tenant and internal layers", () => {
    const instanceEnv = `/h/${RUNTIME_CONFIG_DIR_NAME}/instance.env`;
    const managedEnv = "/custody/provider-g2.env";
    const serverEnv = "/h/deploy.server.env";
    const out = serverOverlayYaml(serverEnv, instanceEnv, undefined, managedEnv);
    expect(out.indexOf(instanceEnv)).toBeLessThan(out.indexOf(managedEnv));
    expect(out.indexOf(managedEnv)).toBeLessThan(out.indexOf(serverEnv));
    expect(out).not.toContain(`${managedEnv}:${CONFIG_CONTAINER_DIR}`);
  });

  test("defaults the volume source to the parent of instance.env (local transport)", () => {
    // Local transport: client-side == daemon-side, so the default dirname
    // of the env_file path is the correct daemon-side mount source.
    const out = serverOverlayYaml(
      "/home/op/.nautilo/srv.env",
      `/home/op/.nautilo/${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
    );
    expect(out).toContain(
      `- /home/op/.nautilo/${RUNTIME_CONFIG_DIR_NAME}:${CONFIG_CONTAINER_DIR}`,
    );
    expect(out).not.toContain(`- /home/op/.nautilo:${CONFIG_CONTAINER_DIR}`);
  });

  test("accepts an explicit daemon-side config dir for ssh-native remote transport", () => {
    // Remote transport: env_file is parsed client-side (operator staging path),
    // but the volumes source is resolved daemon-side (remote root). The caller
    // passes the remote parent explicitly so the mount lands on the droplet.
    const remoteRoot = "/root/.nautilo";
    const out = serverOverlayYaml(
      "/Users/op/stage/srv.env", // client-side env_file
      `/Users/op/stage/${RUNTIME_CONFIG_DIR_NAME}/instance.env`, // client-side env_file
      posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME), // daemon-side config dir
    );
    expect(out).toContain(
      `- ${remoteRoot}/${RUNTIME_CONFIG_DIR_NAME}:${CONFIG_CONTAINER_DIR}`,
    );
    expect(out).toContain(
      `- /Users/op/stage/${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
    );
    expect(out).toContain("- /Users/op/stage/srv.env");
  });

  test("remote staged overlay: default dirname of a remote env_file path is the remote config dir", () => {
    // Staged-remote deploy: compose runs on the remote, so env_file is read
    // daemon-side too; the default dirname is the correct mount source.
    const remoteRoot = "/root/.nautilo";
    const instanceEnv = posix.join(
      remoteRoot,
      RUNTIME_CONFIG_DIR_NAME,
      "instance.env",
    );
    const serverEnv = posix.join(remoteRoot, "deploy.server.env");
    const out = serverOverlayYaml(serverEnv, instanceEnv);
    expect(out).toContain(
      `- ${remoteRoot}/${RUNTIME_CONFIG_DIR_NAME}:${CONFIG_CONTAINER_DIR}`,
    );
    expect(out).toContain(`- ${instanceEnv}`);
    expect(out).toContain(`- ${serverEnv}`);
  });

  test("migrates a legacy file into one authority and re-establishes the compatibility symlink", async () => {
    const root = await mkdtemp(posix.join(tmpdir(), "d445-layout-"));
    try {
      await writeFile(posix.join(root, "instance.env"), "OPENAI_API_KEY=legacy\n");

      await ensureCanonicalConfigLayout(root);

      expect(await readFile(canonicalInstanceEnvPath(root), "utf8")).toBe(
        "OPENAI_API_KEY=legacy\n",
      );
      expect(await readlink(posix.join(root, "instance.env"))).toBe(
        `${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
      );
      expect(runtimeConfigDir(root)).toBe(
        posix.join(root, RUNTIME_CONFIG_DIR_NAME),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("adopts a compatibility writer that atomically replaced the symlink", async () => {
    const root = await mkdtemp(posix.join(tmpdir(), "d445-relink-"));
    try {
      await ensureCanonicalConfigLayout(root);
      // Atomic rename through the legacy path replaces the symlink itself.
      const temporary = posix.join(root, "instance.env.tmp");
      await writeFile(temporary, "TAVILY_API_KEY=newest\n");
      await rename(temporary, posix.join(root, "instance.env"));

      await ensureCanonicalConfigLayout(root);

      expect(await readFile(canonicalInstanceEnvPath(root), "utf8")).toBe(
        "TAVILY_API_KEY=newest\n",
      );
      expect(await readlink(posix.join(root, "instance.env"))).toBe(
        `${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
