import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

type Manifest = {
  schemaVersion: number;
  component: string;
  upstreamVersion: string;
  upstreamTag: string;
  upstreamCommit: string;
  license: string;
  nautiloPatchSha256: string;
  baseImage: string;
  localImage: string;
};

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const patch = readFileSync(join(root, "nautilo.patch"));

describe("OpenConnector derivative provenance", () => {
  test("pins one exact upstream revision and immutable base image", () => {
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      component: "@oomol-lab/open-connector",
      upstreamVersion: "1.4.1",
      upstreamTag: "v1.4.1",
      license: "Apache-2.0",
      localImage: "nautilo/openconnector:1.4.1-nautilo.2",
    });
    expect(manifest.upstreamCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(manifest.baseImage).toMatch(/@sha256:[a-f0-9]{64}$/u);
    expect(dockerfile).toContain(`ARG OPENCONNECTOR_SOURCE_COMMIT=${manifest.upstreamCommit}`);
    expect(dockerfile).toContain(`ARG NODE_IMAGE=${manifest.baseImage}`);
  });

  test("binds the reviewed Nautilo patch by digest", () => {
    const digest = createHash("sha256").update(patch).digest("hex");
    expect(digest).toBe(manifest.nautiloPatchSha256);
    expect(dockerfile).toContain("git apply --check /tmp/nautilo-openconnector.patch");
  });

  test("keeps secrets out of the compose environment declaration", () => {
    const entrypoint = readFileSync(join(root, "entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("OOMOL_CONNECT_ENCRYPTION_KEY_FILE");
    expect(dockerfile).not.toContain("ENV OOMOL_CONNECT_ENCRYPTION_KEY=");
  });

  test("a core.autocrlf checkout preserves the pinned patch and valid diff syntax", () => {
    const temporary = mkdtempSync(join(tmpdir(), "openconnector-checkout-"));
    const source = join(temporary, "source");
    const checkout = join(temporary, "checkout");
    const globalConfig = join(temporary, "gitconfig");
    writeFileSync(globalConfig, "");
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
    };
    function git(cwd: string, args: string[]): void {
      const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    try {
      mkdirSync(join(source, "packaging/openconnector"), { recursive: true });
      writeFileSync(join(source, ".gitattributes"), readFileSync(join(root, "../../.gitattributes")));
      writeFileSync(join(source, "packaging/openconnector/nautilo.patch"), patch);
      git(source, ["init", "--quiet"]);
      git(source, ["-c", "core.autocrlf=false", "add", "."]);
      git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"]);
      git(temporary, ["clone", "--quiet", "--config", "core.autocrlf=true", source, checkout]);
      const checkedOutPatch = readFileSync(join(checkout, "packaging/openconnector/nautilo.patch"));
      expect(createHash("sha256").update(checkedOutPatch).digest("hex")).toBe(manifest.nautiloPatchSha256);
      git(checkout, ["apply", "--numstat", "packaging/openconnector/nautilo.patch"]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("is owned by the loopback-only, restartable Compose service", () => {
    const compose = readFileSync(join(root, "../../infra/compose/nautilo.yml"), "utf8");
    expect(compose).toContain(`image: ${manifest.localImage}`);
    expect(compose).toContain('"127.0.0.1:${NAUTILO_OPENCONNECTOR_PORT:-3010}:3000"');
    expect(compose).toContain("OOMOL_CONNECT_ENCRYPTION_KEY_FILE: /run/nautilo/openconnector-encryption.key");
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).not.toContain("OOMOL_CONNECT_ENCRYPTION_KEY: ${");
  });
});
