import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Architecture = "amd64" | "arm64";
type Manifest = {
  schemaVersion: number;
  component: string;
  upstreamRepository: string;
  upstreamVersion: string;
  license: string;
  upstreamImage: string;
  upstreamManifests: Record<Architecture, string>;
  nodeImage: string;
  nodeVersion: string;
  npm: { version: string; archiveUrl: string; archiveSha256: string };
  npmUndici: { version: string; archiveUrl: string; archiveSha256: string };
  systemPackages: Record<string, string>;
  nodeManifests: Record<Architecture, string>;
  tlsTrust: {
    caCertificatesPackage: string;
    repository: string;
    signatureVerification: string;
    apk: Record<Architecture, {
      repositoryArchitecture: string;
      sha256: string;
    }>;
    bundlePath: string;
    bundleSha256: string;
    emptyCertificateDirectory: string;
  };
  upstreamRuntime: {
    workingDirectory: string;
    entrypoint: string[];
    command: string[];
    port: number;
  };
  localImage: string;
};

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const contract = readFileSync(join(root, "runtime-contract.mjs"), "utf8");
const instructions = dockerfile.replace(/\\\r?\n/gu, " ").split(/\r?\n/u);

describe("Logto runtime derivative", () => {
  test("pins the exact upstream app and official Node release for both architectures", () => {
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      component: "logto",
      upstreamRepository: "https://github.com/logto-io/logto",
      upstreamVersion: "1.45.0",
      license: "MPL-2.0",
      upstreamImage: "ghcr.io/logto-io/logto@sha256:9a9aff9423ab7863f00c881c31408e0bfe4def730bac2182d0097367002f5854",
      nodeImage: "docker.io/library/node@sha256:206878a60dc7014193f418ab9259b6110c15fbd514b3044a267be706509944e4",
      nodeVersion: "22.23.4",
      localImage: "nautilo/logto:1.45.0-nautilo.2",
    });
    for (const digest of [
      ...Object.values(manifest.upstreamManifests),
      ...Object.values(manifest.nodeManifests),
    ]) expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(dockerfile).toContain(`ARG LOGTO_IMAGE=${manifest.upstreamImage}`);
    expect(dockerfile).toContain(`ARG NODE_IMAGE=${manifest.nodeImage}`);
    expect(dockerfile).toContain("COPY --from=trust-package /usr/local/bin/node /usr/local/bin/node");
  });

  test("fetches hash-bound APKs and verifies Alpine signatures offline", () => {
    expect(manifest.tlsTrust).toEqual({
      caCertificatesPackage: "alpine:20261020-r0",
      repository: "https://dl-cdn.alpinelinux.org/alpine/v3.24/main",
      signatureVerification: "apk verifies the package against the unchanged upstream Alpine keyring",
      apk: {
        amd64: {
          repositoryArchitecture: "x86_64",
          sha256: "bb008f6d214b6af7576324659856fb63dc8dcb4373f8345ff706388696f1254d",
        },
        arm64: {
          repositoryArchitecture: "aarch64",
          sha256: "d0a573c27d337c369ad3abe3f39f09ffe67b95af23861577a8d134738375176a",
        },
      },
      bundlePath: "/etc/ssl/certs/ca-certificates.crt",
      bundleSha256: "5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b",
      emptyCertificateDirectory: "/etc/ssl/nautilo-empty-certs",
    });
    expect(dockerfile).toContain("https://dl-cdn.alpinelinux.org/alpine/v3.24/main/${apk_arch}/ca-certificates-bundle-${CA_CERTIFICATES_VERSION}.apk");
    for (const value of Object.values(manifest.tlsTrust.apk)) {
      expect(dockerfile).toContain(value.repositoryArchitecture);
      expect(dockerfile).toContain(value.sha256);
    }
    expect(dockerfile).toContain("apk add --no-cache --no-network --upgrade /tmp/ca-certificates-bundle.apk");
    expect(dockerfile).toContain(`echo '${manifest.tlsTrust.bundleSha256}  ${manifest.tlsTrust.bundlePath}' | sha256sum -c -`);
    expect(dockerfile).not.toContain("--allow-untrusted");
    expect(dockerfile).toContain("rm /tmp/ca-certificates-bundle.apk /tmp/npm.tgz");
  });

  test("uses the maintained bundle exclusively without replacing Logto runtime behavior", () => {
    const environment = new Map(instructions
      .filter((line) => line.startsWith("ENV "))
      .flatMap((line) => line.slice(4).trim().split(/\s+/u))
      .map((assignment): [string, string] => {
        const separator = assignment.indexOf("=");
        return [assignment.slice(0, separator), assignment.slice(separator + 1)];
      }));
    expect(environment.get("NODE_VERSION")).toBe(manifest.nodeVersion);
    expect(environment.get("NODE_OPTIONS")).toBe("--use-openssl-ca");
    expect(environment.get("SSL_CERT_FILE")).toBe(manifest.tlsTrust.bundlePath);
    expect(environment.get("SSL_CERT_DIR")).toBe(manifest.tlsTrust.emptyCertificateDirectory);
    expect(environment.get("NAUTILO_CA_CERTIFICATES_PACKAGE")).toBe(manifest.tlsTrust.caCertificatesPackage);
    expect(environment.get("NAUTILO_CA_BUNDLE_SHA256")).toBe(manifest.tlsTrust.bundleSha256);
    expect(manifest.upstreamRuntime).toEqual({
      workingDirectory: "/etc/logto",
      entrypoint: ["npm", "run"],
      command: ["start"],
      port: 3001,
    });
    expect(dockerfile).not.toMatch(/^\s*(?:ENTRYPOINT|CMD|WORKDIR|EXPOSE)\b/mu);
    expect(dockerfile).not.toMatch(/\b(?:COPY|ADD)\s+[^\n]*\/etc\/logto\b/u);
    expect(dockerfile).not.toContain("YARN_VERSION=");
  });

  test("upgrades supported Alpine packages and binds every security baseline", () => {
    expect(dockerfile).toContain("apk upgrade --no-cache");
    expect(manifest.systemPackages).toEqual({
      "alpine-release": "3.24.3-r0",
      musl: "1.2.6-r3",
      libcrypto3: "3.5.9-r0",
      libssl3: "3.5.9-r0",
      zlib: "1.3.2-r1",
      "apk-tools": "3.0.8-r0",
    });
    for (const [name, version] of Object.entries(manifest.systemPackages)) {
      expect(contract).toContain(name);
      expect(contract).toContain(version);
      if (name !== "alpine-release") expect(dockerfile).toContain(`${name}=${version}`);
    }
    expect(contract).toContain("['info', '-e', `${name}=${version}`]");
  });

  test("cleanly replaces the npm toolchain from its hash-bound archive without lifecycle scripts", () => {
    expect(manifest.npm).toEqual({
      version: "12.2.1",
      archiveUrl: "https://registry.npmjs.org/npm/-/npm-12.2.1.tgz",
      archiveSha256: "228bd64aaef23270dbdbd2cf3d5ef5c467602ef38c4066246cef1984adab9a67",
    });
    expect(dockerfile).toContain(`ARG NPM_VERSION=${manifest.npm.version}`);
    expect(dockerfile).toContain(`ARG NPM_ARCHIVE_SHA256=${manifest.npm.archiveSha256}`);
    expect(dockerfile).toContain('echo "${NPM_ARCHIVE_SHA256}  /tmp/npm.tgz" | sha256sum -c -');
    const removal = dockerfile.indexOf("rm -rf /usr/local/lib/node_modules/npm");
    const unpack = dockerfile.indexOf("tar -xzf /tmp/npm.tgz -C /usr/local/lib/node_modules/npm --strip-components=1");
    expect(removal).toBeGreaterThan(0);
    expect(unpack).toBeGreaterThan(removal);
    expect(dockerfile).not.toContain("npm install --global");
    expect(contract).toContain("readVersion('/usr/local/lib/node_modules/npm/package.json'), '12.2.1'");
  });

  test("runtime contract binds app, architecture, package, bundle, and default trust", () => {
    for (const expected of [
      manifest.upstreamVersion,
      manifest.nodeVersion,
      manifest.tlsTrust.caCertificatesPackage,
      manifest.tlsTrust.bundlePath,
      manifest.tlsTrust.bundleSha256,
      manifest.tlsTrust.emptyCertificateDirectory,
      ...Object.values(manifest.tlsTrust.apk).map(({ sha256 }) => sha256),
    ]) expect(dockerfile + contract).toContain(expected);
    expect(contract).toContain("['x64', 'arm64'].includes(process.arch)");
    expect(contract).toContain("tls.createSecureContext()");
    expect(contract).toContain("ca-certificates-bundle=20261020-r0");
    expect(contract.match(/[a-f0-9]{64}/gu)).toHaveLength(4);
  });
  test("patches npm's bundled HTTP client from a verified same-major upstream archive", () => {
    expect(manifest.npmUndici).toEqual({
      version: "6.29.1",
      archiveUrl: "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz",
      archiveSha256: "29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f",
    });
    expect(dockerfile).toContain(`ARG UNDICI_VERSION=${manifest.npmUndici.version}`);
    expect(dockerfile).toContain(`ARG UNDICI_ARCHIVE_SHA256=${manifest.npmUndici.archiveSha256}`);
    expect(dockerfile).toContain('echo "${UNDICI_ARCHIVE_SHA256}  /tmp/undici.tgz" | sha256sum -c -');
    expect(dockerfile).toContain("tar -xzf /tmp/undici.tgz -C /usr/local/lib/node_modules/npm/node_modules/undici --strip-components=1");
    expect(contract).toContain("readVersion('/usr/local/lib/node_modules/npm/node_modules/undici/package.json'), '6.29.1'");
    expect(contract).toContain("typeof npmHttpClient.Agent");
  });
});
