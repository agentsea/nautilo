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
      upstreamVersion: "1.43.0",
      license: "MPL-2.0",
      upstreamImage: "ghcr.io/logto-io/logto@sha256:41196a1fadbff35eae337965321c57946936755066bd92625ccf8a5b65d4b1be",
      nodeImage: "docker.io/library/node@sha256:206878a60dc7014193f418ab9259b6110c15fbd514b3044a267be706509944e4",
      nodeVersion: "22.23.4",
      localImage: "nautilo/logto:1.43.0-nautilo.1",
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
    expect(dockerfile).toContain("rm /tmp/ca-certificates-bundle.apk");
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
});
