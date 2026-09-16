import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  REMOTE_COMPOSE_PROFILES,
  REMOTE_COMPOSE_SERVICES,
  buildRemoteComposeCommand,
  validateRemoteComposeProfiles,
  validateRemoteComposeProjectName,
  validateRemoteComposeRoot,
  type BuildRemoteComposeCommandInput,
  type RemoteComposeCommandRequest,
} from "../../src/remote-compose-command.ts";
import { shellQuote } from "../../src/remote-exec.ts";

const REMOTE_ROOT = "/opt/nautilo-prod";
const PROJECT = "nautilo-prod";

function build(
  request: RemoteComposeCommandRequest,
  overrides: Partial<Omit<BuildRemoteComposeCommandInput, "request">> = {},
) {
  return buildRemoteComposeCommand({
    remoteRoot: REMOTE_ROOT,
    projectName: PROJECT,
    ...overrides,
    request,
  });
}

function script(result: ReturnType<typeof buildRemoteComposeCommand>): string {
  expect(result.command).toBe("sh");
  expect(result.args[0]).toBe("-lc");
  return result.args[1];
}

function expectRemoteOnly(s: string): void {
  expect(s).toContain(`cd -- ${shellQuote(REMOTE_ROOT)}`);
  expect(s).toContain("exec docker compose");
  expect(s).toContain(`--project-name ${shellQuote(PROJECT)}`);
  expect(s).toContain(
    `-f ${shellQuote(`${REMOTE_ROOT}/docker-compose.yml`)}`,
  );
  expect(s).toContain(
    `--env-file ${shellQuote(`${REMOTE_ROOT}/deploy.compose.env`)}`,
  );
  expect(s).not.toContain("DOCKER_HOST");
  expect(s).not.toContain(".remote-staging");
  expect(s).not.toContain(homedir());
  expect(s).not.toMatch(/\/tmp\//);
  expect(s).not.toMatch(/\/var\/folders\//);
}

describe("buildRemoteComposeCommand", () => {
  describe("verb output shapes", () => {
    test("ps", () => {
      const s = script(build({ verb: "ps" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" ps --format json")).toBe(true);
    });

    test("config", () => {
      const s = script(build({ verb: "config" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" config")).toBe(true);
    });

    test("config images resolves compose image names without mutation", () => {
      const s = script(build({ verb: "config", images: true }));
      expectRemoteOnly(s);
      expect(s.endsWith(" config --images")).toBe(true);
    });

    test("build accepts only an allowlisted service", () => {
      const s = script(build({ verb: "build", service: "nautilo-server" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" build nautilo-server")).toBe(true);
    });

    test("restart with service", () => {
      const s = script(build({ verb: "restart", service: "nautilo-server" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" restart nautilo-server")).toBe(true);
    });

    test("full restart names only the selected long-running services", () => {
      const s = script(build({
        verb: "restart",
        services: ["app-postgres", "logto-postgres", "logto", "nautilo-server"],
      }));
      expectRemoteOnly(s);
      expect(s.endsWith(" restart app-postgres logto-postgres logto nautilo-server")).toBe(true);
      expect(s).not.toContain("logto-seed");
    });

    test("start with service", () => {
      const s = script(build({ verb: "start", service: "logto" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" start logto")).toBe(true);
    });

    test("stop with service", () => {
      const s = script(build({ verb: "stop", service: "caddy" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" stop caddy")).toBe(true);
    });

    test("pull with service", () => {
      const s = script(build({ verb: "pull", service: "nautilo-server" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" pull nautilo-server")).toBe(true);
    });

    test("logs without service", () => {
      const s = script(build({ verb: "logs" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" logs")).toBe(true);
    });

    test("logs with follow and service", () => {
      const s = script(build({ verb: "logs", follow: true, service: "nautilo-server" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" logs -f nautilo-server")).toBe(true);
    });

    test("up has no positional service", () => {
      const s = script(build({ verb: "up" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" up -d")).toBe(true);
      expect(s).not.toMatch(/ up -d \S+/);
    });

    test("up allowlists registry rollback flags and service", () => {
      const s = script(
        build({
          verb: "up",
          noBuild: true,
          noDeps: true,
          service: "nautilo-server",
        }),
      );
      expectRemoteOnly(s);
      expect(s.endsWith(" up -d --no-build --no-deps nautilo-server")).toBe(true);
    });

    test("up with wait gates postgres readiness before psql repair", () => {
      const s = script(
        build({
          verb: "up",
          wait: true,
          noBuild: true,
          service: "app-postgres",
        }),
      );
      expectRemoteOnly(s);
      expect(s.endsWith(" up -d --wait --no-build app-postgres")).toBe(true);
    });

    test("up without wait omits --wait flag", () => {
      const s = script(
        build({
          verb: "up",
          noBuild: true,
          service: "logto-postgres",
        }),
      );
      expectRemoteOnly(s);
      expect(s.endsWith(" up -d --no-build logto-postgres")).toBe(true);
      expect(s).not.toContain(" --wait ");
    });

    test("up allowlists force-recreate for logto core refresh", () => {
      const s = script(
        build({
          verb: "up",
          noBuild: true,
          noDeps: true,
          forceRecreate: true,
          service: "logto",
        }),
      );
      expectRemoteOnly(s);
      expect(s.endsWith(" up -d --no-build --no-deps --force-recreate logto")).toBe(
        true,
      );
    });

    test("full recovery up uses existing images with auth + app profiles", () => {
      const s = script(
        build(
          { verb: "up", noBuild: true },
          { profiles: ["auth", "app"] },
        ),
      );
      expectRemoteOnly(s);
      expect(s).toContain("--profile auth");
      expect(s).toContain("--profile app");
      expect(s.endsWith(" up -d --no-build")).toBe(true);
      expect(s).not.toContain(" build ");
      expect(s).not.toContain(" pull ");
      expect(s).not.toContain(" restart ");
    });

    test("down has no positional service", () => {
      const s = script(build({ verb: "down" }));
      expectRemoteOnly(s);
      expect(s.endsWith(" down")).toBe(true);
      expect(s).not.toMatch(/ down \S+/);
    });
  });

  describe("overlay -f paths", () => {
    test("base only when no overlays", () => {
      const s = script(build({ verb: "ps" }));
      expect(s).not.toContain("deploy.volumes-overlay.yml");
      expect(s).not.toContain("deploy.caddy-overlay.yml");
      expect(s).not.toContain("deploy.registry-overlay.yml");
    });

    test("volumes, caddy, registry, server, restore in fixed order", () => {
      const s = script(
        build(
          { verb: "config" },
          {
            overlays: {
              volumes: true,
              caddy: true,
              registry: true,
              server: true,
              restore: true,
            },
          },
        ),
      );
      const volumesIdx = s.indexOf("deploy.volumes-overlay.yml");
      const caddyIdx = s.indexOf("deploy.caddy-overlay.yml");
      const registryIdx = s.indexOf("deploy.registry-overlay.yml");
      const serverIdx = s.indexOf("deploy.server-overlay.yml");
      const restoreIdx = s.indexOf("deploy.restore-overlay.yml");
      const envIdx = s.indexOf("deploy.compose.env");
      expect(volumesIdx).toBeGreaterThan(-1);
      expect(caddyIdx).toBeGreaterThan(volumesIdx);
      expect(registryIdx).toBeGreaterThan(caddyIdx);
      expect(serverIdx).toBeGreaterThan(registryIdx);
      expect(restoreIdx).toBeGreaterThan(serverIdx);
      expect(envIdx).toBeGreaterThan(restoreIdx);
      expect(s).toContain(
        `-f ${shellQuote(`${REMOTE_ROOT}/deploy.volumes-overlay.yml`)}`,
      );
      expect(s).toContain(
        `-f ${shellQuote(`${REMOTE_ROOT}/deploy.caddy-overlay.yml`)}`,
      );
      expect(s).toContain(
        `-f ${shellQuote(`${REMOTE_ROOT}/deploy.registry-overlay.yml`)}`,
      );
      expect(s).toContain(
        `-f ${shellQuote(`${REMOTE_ROOT}/deploy.restore-overlay.yml`)}`,
      );
    });

    test("individual overlay flags", () => {
      const volumesOnly = script(
        build({ verb: "ps" }, { overlays: { volumes: true } }),
      );
      expect(volumesOnly).toContain("deploy.volumes-overlay.yml");
      expect(volumesOnly).not.toContain("deploy.caddy-overlay.yml");

      const caddyOnly = script(
        build({ verb: "ps" }, { overlays: { caddy: true } }),
      );
      expect(caddyOnly).toContain("deploy.caddy-overlay.yml");
      expect(caddyOnly).not.toContain("deploy.volumes-overlay.yml");
    });
  });

  describe("supported services", () => {
    test("every allowlisted service works for restart", () => {
      for (const service of REMOTE_COMPOSE_SERVICES) {
        const s = script(build({ verb: "restart", service }));
        expect(s.endsWith(` restart ${service}`)).toBe(true);
      }
    });
  });

  describe("hostile remoteRoot rejection", () => {
    test("rejects relative paths", () => {
      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: "opt/nautilo",
          projectName: PROJECT,
          request: { verb: "ps" },
        }),
      ).toThrow(/absolute POSIX path/);
    });

    test("rejects parent traversal", () => {
      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: "/opt/../etc/nautilo",
          projectName: PROJECT,
          request: { verb: "ps" },
        }),
      ).toThrow(/'\.\.' segments/);
    });

    test("rejects dot segments", () => {
      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: "/opt/./nautilo",
          projectName: PROJECT,
          request: { verb: "ps" },
        }),
      ).toThrow(/'\.' segments/);
    });

    test("quotes injection in otherwise valid root", () => {
      const hostile = "/opt/nautilo; rm -rf /";
      const canonical = validateRemoteComposeRoot(hostile);
      const s = script(
        buildRemoteComposeCommand({
          remoteRoot: hostile,
          projectName: PROJECT,
          request: { verb: "ps" },
        }),
      );
      expect(s).toContain(`cd -- ${shellQuote(canonical)}`);
      expect(s).not.toMatch(/'\s&&\srm -rf/);
      expect(s).not.toContain("; rm -rf / &&");
    });

    test("normalizes trailing slashes", () => {
      expect(validateRemoteComposeRoot("/opt/nautilo-prod/")).toBe("/opt/nautilo-prod");
    });
  });

  describe("hostile projectName rejection", () => {
    test("rejects uppercase and special characters", () => {
      expect(() => validateRemoteComposeProjectName("Nautilo")).toThrow(/lowercase/);
      expect(() => validateRemoteComposeProjectName("nautilo prod")).toThrow(
        /start with a letter/,
      );
      expect(() => validateRemoteComposeProjectName("")).toThrow(/empty/);
      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: REMOTE_ROOT,
          projectName: "nautilo;drop",
          request: { verb: "ps" },
        }),
      ).toThrow(/start with a letter/);
    });

    test("quotes safe project names that need quoting", () => {
      const s = script(
        buildRemoteComposeCommand({
          remoteRoot: REMOTE_ROOT,
          projectName: "nautilo_prod-1",
          request: { verb: "ps" },
        }),
      );
      expect(s).toContain("--project-name nautilo_prod-1");
    });
  });

  describe("hostile service rejection", () => {
    test("rejects unsupported service names", () => {
      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: REMOTE_ROOT,
          projectName: PROJECT,
          request: {
            verb: "restart",
            service: "postgres; rm -rf /" as "nautilo-server",
          },
        }),
      ).toThrow(/unsupported service/);

      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: REMOTE_ROOT,
          projectName: PROJECT,
          request: {
            verb: "logs",
            service: "unknown-svc" as "nautilo-server",
          },
        }),
      ).toThrow(/unsupported service/);
    });

    test("rejects service on ps/config/down", () => {
      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: REMOTE_ROOT,
          projectName: PROJECT,
          request: { verb: "ps", service: "nautilo-server" } as {
            verb: "ps";
          },
        }),
      ).toThrow(/must not specify service/);

    });

    test("requires a nonempty unique restart service set", () => {
      expect(() =>
        build(
          { verb: "restart" } as unknown as RemoteComposeCommandRequest,
        ),
      ).toThrow(/requires an allowlisted service/);

      expect(() =>
        build(
          {
            verb: "restart",
            services: [],
          },
        ),
      ).toThrow(/must not be empty/);

      expect(() =>
        build(
          {
            verb: "restart",
            services: ["logto", "logto"],
          },
        ),
      ).toThrow(/must be unique/);

      expect(() =>
        build(
          {
            verb: "restart",
            services: ["logto"],
            service: "nautilo-server",
          } as unknown as RemoteComposeCommandRequest,
        ),
      ).toThrow(/must not specify service/);
    });
  });

  describe("compose profiles", () => {
    test("emits allowlisted profiles after env-file and before verb", () => {
      const s = script(
        build(
          { verb: "up" },
          { profiles: ["auth", "app"] },
        ),
      );
      const envIdx = s.indexOf("deploy.compose.env");
      const authIdx = s.indexOf("--profile auth");
      const appIdx = s.indexOf("--profile app");
      const upIdx = s.lastIndexOf(" up -d");
      expect(authIdx).toBeGreaterThan(envIdx);
      expect(appIdx).toBeGreaterThan(authIdx);
      expect(upIdx).toBeGreaterThan(appIdx);
      expect(s.endsWith(" up -d")).toBe(true);
    });

    test("includes office when requested", () => {
      const s = script(
        build(
          { verb: "config" },
          { profiles: ["auth", "app", "office"] },
        ),
      );
      expect(s).toContain("--profile auth");
      expect(s).toContain("--profile app");
      expect(s).toContain("--profile office");
      expect(s.endsWith(" config")).toBe(true);
    });

    test("deduplicates repeated profile names", () => {
      const s = script(
        build(
          { verb: "pull", service: "nautilo-server" },
          { profiles: ["auth", "auth", "app"] },
        ),
      );
      expect(s.match(/--profile auth/g)?.length).toBe(1);
      expect(s).toContain("--profile app");
    });

    test("rejects unsupported profile names", () => {
      expect(() => validateRemoteComposeProfiles(["auth", "prod"])).toThrow(
        /unsupported compose profile 'prod'/,
      );
      expect(() =>
        buildRemoteComposeCommand({
          remoteRoot: REMOTE_ROOT,
          projectName: PROJECT,
          profiles: ["auth", "office", "app", "staging" as "auth"],
          request: { verb: "up" },
        }),
      ).toThrow(/unsupported compose profile 'staging'/);
    });

    test("omits profile flags when profiles input is absent", () => {
      const s = script(build({ verb: "ps" }));
      for (const profile of REMOTE_COMPOSE_PROFILES) {
        expect(s).not.toContain(`--profile ${profile}`);
      }
    });
  });

  describe("return shape", () => {
    test("returns sh -lc argv", () => {
      const result = build({ verb: "ps" });
      expect(result.command).toBe("sh");
      expect(result.args[0]).toBe("-lc");
      expect(result.args[1]).toContain("exec docker compose");
    });

    test("all compose file paths stay under remoteRoot", () => {
      const s = script(
        build(
          { verb: "pull", service: "nautilo-server" },
          { overlays: { volumes: true, caddy: true, registry: true } },
        ),
      );
      for (const rel of [
        "docker-compose.yml",
        "deploy.volumes-overlay.yml",
        "deploy.caddy-overlay.yml",
        "deploy.registry-overlay.yml",
        "deploy.compose.env",
      ]) {
        expect(s).toContain(join(REMOTE_ROOT, rel).replace(/\\/g, "/"));
      }
      expect(s).not.toContain("templateDir");
      expect(s).not.toContain("docker-compose-driver");
    });
  });
});
