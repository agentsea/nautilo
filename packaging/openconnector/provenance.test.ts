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
  tlsTrust: {
    caCertificatesPackage: string;
    opensslPackageVersion: string;
    bundlePath: string;
    bundleSha256: string;
    emptyCertificateDirectory: string;
  };
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
      localImage: "nautilo/openconnector:1.4.1-nautilo.4",
    });
    expect(manifest.upstreamCommit).toMatch(/^[a-f0-9]{40}$/u);
    const base = /^docker\.io\/library\/node:(24\.\d+\.\d+)-alpine3\.23@sha256:[a-f0-9]{64}$/u.exec(manifest.baseImage);
    expect(base).not.toBeNull();
    expect(Bun.semver.satisfies(base?.[1] ?? "", ">=24.22.1 <25")).toBe(true);
    expect(dockerfile).toContain(`ARG OPENCONNECTOR_SOURCE_COMMIT=${manifest.upstreamCommit}`);
    expect(dockerfile).toContain(`ARG NODE_IMAGE=${manifest.baseImage}`);
  });

  test("every network-using stage inherits the verified exclusive CA bundle", () => {
    const instructions = dockerfile.replace(/\\\r?\n/gu, " ").split(/\r?\n/u);
    const stages = instructions.flatMap((line) => {
      const match = /^FROM (\S+) AS (\S+)$/u.exec(line);
      return match ? [[match[1], match[2]]] : [];
    });
    expect(stages).toEqual([
      ["${NODE_IMAGE}", "trust"],
      ["trust", "source"],
      ["source", "build"],
      ["trust", "runtime"],
    ]);
    expect(manifest.tlsTrust).toEqual({
      caCertificatesPackage: "alpine:20261020-r0",
      opensslPackageVersion: "3.5.9-r0",
      bundlePath: "/etc/ssl/certs/ca-certificates.crt",
      bundleSha256: "5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b",
      emptyCertificateDirectory: "/etc/ssl/nautilo-empty-certs",
    });
    const trustInstructions = instructions.slice(
      instructions.indexOf("FROM ${NODE_IMAGE} AS trust") + 1,
      instructions.indexOf("FROM trust AS source"),
    );
    const installation = trustInstructions.find((line) => line.startsWith("RUN apk add "));
    expect(installation).toContain(`ca-certificates=${manifest.tlsTrust.caCertificatesPackage.split(":")[1]}`);
    expect(installation).toContain(`libcrypto3=${manifest.tlsTrust.opensslPackageVersion}`);
    expect(installation).toContain(`libssl3=${manifest.tlsTrust.opensslPackageVersion}`);
    expect(installation).toContain(`echo '${manifest.tlsTrust.bundleSha256}  ${manifest.tlsTrust.bundlePath}' | sha256sum -c -`);
    expect(installation).toContain(`mkdir -p ${manifest.tlsTrust.emptyCertificateDirectory}`);
    expect(dockerfile).not.toContain("--allow-untrusted");

    const environment = new Map(instructions
      .filter((line) => line.startsWith("ENV "))
      .flatMap((line) => line.slice(4).trim().split(/\s+/u))
      .map((assignment): [string, string] => {
        const separator = assignment.indexOf("=");
        return [assignment.slice(0, separator), assignment.slice(separator + 1)];
      }));
    expect(environment.get("NODE_OPTIONS")).toBe("--use-openssl-ca");
    expect(environment.get("SSL_CERT_FILE")).toBe(manifest.tlsTrust.bundlePath);
    expect(environment.get("SSL_CERT_DIR")).toBe(manifest.tlsTrust.emptyCertificateDirectory);
    expect(environment.get("NAUTILO_CA_BUNDLE_SHA256")).toBe(manifest.tlsTrust.bundleSha256);
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
    const configuration = Bun.YAML.parse(compose) as {
      services: { openconnector: { image: string; environment: Record<string, string> } };
    };
    expect(configuration.services.openconnector.image).toBe(manifest.localImage);
    for (const key of ["NODE_OPTIONS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      expect(configuration.services.openconnector.environment[key]).toBeUndefined();
    }
    expect(compose).toContain('"127.0.0.1:${NAUTILO_OPENCONNECTOR_PORT:-3010}:3000"');
    expect(compose).toContain("OOMOL_CONNECT_ENCRYPTION_KEY_FILE: /run/nautilo/openconnector-encryption.key");
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).not.toContain("OOMOL_CONNECT_ENCRYPTION_KEY: ${");
  });
});
