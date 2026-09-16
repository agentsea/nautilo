import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalReleaseManifestBytes,
  canonicalServerReleaseManifestBytes,
  type ReleaseManifest,
  type RuntimeArtifactRecordV1,
  type ServerReleaseManifest,
} from "@nautilo/hosting";

import {
  RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV,
  RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA_ENV,
  RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH_ENV,
  RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV,
  RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH_ENV,
  RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV,
  RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV,
  RAILWAY_QUALIFICATION_TRUST_ROOT_PATH_ENV,
  RAILWAY_PRODUCTION_RELEASE_BASE_URL,
  immutableHostingManifestUrl,
  resolveRailwayProductionRelease,
  resolveRailwayQualificationRelease,
  resolveRailwayRelease,
} from "../../src/lib/railway-release-source";
import { SERVER_PRODUCTION_RELEASE_MANIFEST_URL } from "../../src/lib/server-release-source";

const digest = (name: string, hex: string): string => `${name}@sha256:${hex.repeat(64)}`;

function runtimeArtifactRecord(): RuntimeArtifactRecordV1 {
  const manifestDigest = `sha256:${"d".repeat(64)}` as const;
  return {
    version: 1,
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    image: `ghcr.io/agentsea/nautilo-runtime-v2@${manifestDigest}`,
    manifestDigest,
    architectures: {
      "linux/amd64": `sha256:${"1".repeat(64)}`,
      "linux/arm64": `sha256:${"2".repeat(64)}`,
    },
    evidence: {
      sbom: `sha256:${"3".repeat(64)}`,
      vulnerabilities: `sha256:${"3".repeat(64)}`,
      disclosure: `sha256:${"3".repeat(64)}`,
      licenses: `sha256:${"3".repeat(64)}`,
      acceptance: `sha256:${"3".repeat(64)}`,
    },
    compatibility: {
      authContract: "Anonymous pull of ghcr.io/agentsea/nautilo-runtime-v2 by immutable digest; runtime requires configured Logto OIDC.",
      database: "This record adds no database migration; use the existing ComposeDriver migration-aware release transaction.",
      rollback: "full-bundle-required",
    },
  };
}

function bootstrapArtifactRecord() {
  const manifestDigest = `sha256:${"e".repeat(64)}`;
  return {
    version: 1,
    sourceSha: "ffffffffffffffffffffffffffffffffffffffff",
    image: `ghcr.io/agentsea/nautilo-bootstrap-runtime-v2@${manifestDigest}`,
    manifestDigest,
    architectures: {
      "linux/amd64": `sha256:${"4".repeat(64)}`,
      "linux/arm64": `sha256:${"5".repeat(64)}`,
    },
    evidence: {
      sbom: `sha256:${"6".repeat(64)}`,
      vulnerabilities: `sha256:${"6".repeat(64)}`,
      disclosure: `sha256:${"6".repeat(64)}`,
      licenses: `sha256:${"6".repeat(64)}`,
      safeFailure: `sha256:${"6".repeat(64)}`,
    },
    compatibility: {
      execution: "One-shot nonroot database and Logto reconciliation; never a long-running customer service.",
      safeFailure: "Missing or invalid environment and unreachable databases exit non-zero with receipt-safe JSON and no secret values.",
      database: "Reconciliation is idempotent and retryable; promotion requires native missing-database safe-failure evidence.",
      rollback: "rerun-idempotently",
    },
  };
}

function manifest(): ReleaseManifest {
  return {
    schemaVersion: 1,
    releaseId: "qualification-local",
    images: [
      { name: "app-postgres", reference: digest("pgvector/pgvector", "a") },
      { name: "logto-postgres", reference: digest("postgres", "b") },
      { name: "logto", reference: digest("ghcr.io/logto-io/logto", "c") },
      { name: "nautilo-server", reference: digest("ghcr.io/agentsea/nautilo-runtime-v2", "d") },
      { name: "nautilo-bootstrap", reference: digest("ghcr.io/agentsea/nautilo-bootstrap-runtime-v2", "e") },
    ],
    topology: {
      schemaVersion: 1,
      bootstrap: { image: "nautilo-bootstrap" },
      services: [
        { name: "app-postgres", role: "app-postgres", image: "app-postgres" },
        { name: "logto-postgres", role: "logto-postgres", image: "logto-postgres" },
        { name: "logto-seed", role: "logto-seed", image: "logto" },
        { name: "logto", role: "logto", image: "logto" },
        { name: "nautilo-server", role: "nautilo-server", image: "nautilo-server" },
      ],
      persistentMounts: [
        { role: "app-postgres-data", service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
        { role: "logto-postgres-data", service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
        { role: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" },
      ],
      environmentSchemaVersion: 1,
      migrationSchemaVersion: 1,
    },
    compatibility: {
      runtime: { minimum: 1, maximum: 1 },
      protocol: { minimum: 1, maximum: 1 },
      topology: { minimum: 1, maximum: 1 },
    },
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nautilo-railway-release-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Railway qualification release source", () => {
  test("distinguishes absent qualification input from a verified local proof manifest", async () => {
    expect(await resolveRailwayQualificationRelease({})).toEqual({ state: "not-published" });

    const keys = generateKeyPairSync("ed25519");
    const body = manifest();
    const signedManifest = {
      manifest: body,
      signature: {
        algorithm: "ed25519",
        keyId: "qualification-local",
        value: sign(null, canonicalReleaseManifestBytes(body), keys.privateKey).toString("base64"),
      },
    };
    const trustRoot = {
      schemaVersion: 1,
      trustedPublicKeys: {
        "qualification-local": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      },
    };
    const manifestPath = join(root, "manifest.json");
    const trustRootPath = join(root, "trust.json");
    const runtimeArtifactRecordPath = join(root, "runtime-artifact-record-v1.json");
    const bootstrapArtifactRecordPath = join(root, "bootstrap-artifact-record-v1.json");
    await writeFile(manifestPath, JSON.stringify(signedManifest), { mode: 0o600 });
    await writeFile(trustRootPath, JSON.stringify(trustRoot), { mode: 0o600 });
    await writeFile(runtimeArtifactRecordPath, JSON.stringify(runtimeArtifactRecord()), { mode: 0o600 });
    await writeFile(bootstrapArtifactRecordPath, JSON.stringify(bootstrapArtifactRecord()), { mode: 0o600 });

    const result = await resolveRailwayQualificationRelease({
      [RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV]: manifestPath,
      [RAILWAY_QUALIFICATION_TRUST_ROOT_PATH_ENV]: trustRootPath,
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH_ENV]: runtimeArtifactRecordPath,
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]: `sha256:${"d".repeat(64)}`,
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH_ENV]: bootstrapArtifactRecordPath,
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]: "ffffffffffffffffffffffffffffffffffffffff",
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]: `sha256:${"e".repeat(64)}`,
    });
    expect(result.state).toBe("verified");
    if (result.state === "verified") {
      expect(result.channel).toBe("qualification");
      expect(result.manifest.releaseId).toBe("qualification-local");
    }
    const complete = {
      [RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV]: manifestPath,
      [RAILWAY_QUALIFICATION_TRUST_ROOT_PATH_ENV]: trustRootPath,
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH_ENV]: runtimeArtifactRecordPath,
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]: `sha256:${"d".repeat(64)}`,
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH_ENV]: bootstrapArtifactRecordPath,
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]: "ffffffffffffffffffffffffffffffffffffffff",
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]: `sha256:${"e".repeat(64)}`,
    };
    expect(await resolveRailwayQualificationRelease({
      ...complete,
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).toEqual({ state: "invalid" });

    const manifestWithPrivatePull = {
      ...body,
      registryCredentials: { username: "must-not-be-accepted", password: "must-not-be-accepted" },
    };
    await writeFile(manifestPath, JSON.stringify({
      manifest: manifestWithPrivatePull,
      signature: {
        algorithm: "ed25519",
        keyId: "qualification-local",
        value: sign(
          null,
          canonicalReleaseManifestBytes(manifestWithPrivatePull as ReleaseManifest),
          keys.privateKey,
        ).toString("base64"),
      },
    }), { mode: 0o600 });
    expect(await resolveRailwayQualificationRelease(complete)).toEqual({ state: "invalid" });

    await writeFile(manifestPath, JSON.stringify(signedManifest), { mode: 0o600 });
    await writeFile(runtimeArtifactRecordPath, JSON.stringify({
      ...runtimeArtifactRecord(),
      imagePullSecret: "must-not-be-accepted",
    }), { mode: 0o600 });
    expect(await resolveRailwayQualificationRelease(complete)).toEqual({ state: "invalid" });

    await writeFile(runtimeArtifactRecordPath, JSON.stringify(runtimeArtifactRecord()), { mode: 0o600 });
    await writeFile(bootstrapArtifactRecordPath, JSON.stringify({
      ...bootstrapArtifactRecord(),
      privatePullAuthority: "must-not-be-accepted",
    }), { mode: 0o600 });
    expect(await resolveRailwayQualificationRelease(complete)).toEqual({ state: "invalid" });
  });

  test("fails closed for incomplete, shared, linked, malformed, and untrusted input", async () => {
    const manifestPath = join(root, "manifest.json");
    const trustRootPath = join(root, "trust.json");
    const runtimeArtifactRecordPath = join(root, "runtime-artifact-record-v1.json");
    const bootstrapArtifactRecordPath = join(root, "bootstrap-artifact-record-v1.json");
    await writeFile(manifestPath, "{}", { mode: 0o600 });
    await writeFile(trustRootPath, "{}", { mode: 0o600 });
    await writeFile(runtimeArtifactRecordPath, JSON.stringify(runtimeArtifactRecord()), { mode: 0o600 });
    await writeFile(bootstrapArtifactRecordPath, JSON.stringify(bootstrapArtifactRecord()), { mode: 0o600 });
    const complete = {
      [RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV]: manifestPath,
      [RAILWAY_QUALIFICATION_TRUST_ROOT_PATH_ENV]: trustRootPath,
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH_ENV]: runtimeArtifactRecordPath,
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]: `sha256:${"d".repeat(64)}`,
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH_ENV]: bootstrapArtifactRecordPath,
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]: "ffffffffffffffffffffffffffffffffffffffff",
      [RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]: `sha256:${"e".repeat(64)}`,
    };
    expect(await resolveRailwayQualificationRelease({
      [RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV]: manifestPath,
    })).toEqual({ state: "invalid" });
    expect(await resolveRailwayQualificationRelease(complete)).toEqual({ state: "invalid" });

    await chmod(manifestPath, 0o644);
    expect(await resolveRailwayQualificationRelease(complete)).toEqual({ state: "invalid" });
    await chmod(manifestPath, 0o600);
    const linkedPath = join(root, "linked.json");
    await symlink(manifestPath, linkedPath);
    expect(await resolveRailwayQualificationRelease({
      ...complete,
      [RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV]: linkedPath,
    })).toEqual({ state: "invalid" });
  });
});

describe("Railway production release source", () => {
  function signedProductionRelease() {
    const keys = generateKeyPairSync("ed25519");
    const body = manifest();
    const hostingManifest = {
      manifest: body,
      signature: {
        algorithm: "ed25519" as const,
        keyId: "production-test",
        value: sign(null, canonicalReleaseManifestBytes(body), keys.privateKey).toString("base64"),
      },
    };
    const serverBody: ServerReleaseManifest = {
      schemaVersion: 1,
      channel: "stable",
      runtimeArtifact: runtimeArtifactRecord(),
    };
    const serverManifest = {
      manifest: serverBody,
      signature: {
        algorithm: "ed25519" as const,
        keyId: "production-test",
        value: sign(null, canonicalServerReleaseManifestBytes(serverBody), keys.privateKey).toString("base64"),
      },
    };
    return {
      hostingManifest,
      serverManifest,
      immutableHostingUrl: `${RAILWAY_PRODUCTION_RELEASE_BASE_URL}/runtime-v2/${serverBody.runtimeArtifact.sourceSha}/${
        serverBody.runtimeArtifact.manifestDigest.replace(":", "-")
      }/hosting-manifest.json`,
      trustedPublicKeys: {
        "production-test": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      },
    };
  }

  function publicResponse(
    value: unknown,
    url: string = SERVER_PRODUCTION_RELEASE_MANIFEST_URL,
    init: ResponseInit = {},
  ): Response {
    const response = new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }

  test("derives and verifies the immutable hosting manifest from the signed server channel", async () => {
    const release = signedProductionRelease();
    const requestedUrls: string[] = [];
    const result = await resolveRailwayProductionRelease({
      trustedPublicKeys: release.trustedPublicKeys,
      fetchImpl: ((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        requestedUrls.push(url);
        return Promise.resolve(url === SERVER_PRODUCTION_RELEASE_MANIFEST_URL
          ? publicResponse(release.serverManifest)
          : publicResponse(release.hostingManifest, release.immutableHostingUrl));
      }),
    });
    expect(requestedUrls).toEqual([
      SERVER_PRODUCTION_RELEASE_MANIFEST_URL,
      release.immutableHostingUrl,
    ]);
    expect(result.state).toBe("verified");
    if (result.state === "verified") {
      expect(result.channel).toBe("production");
      expect(result.manifest.releaseId).toBe("qualification-local");
    }
    expect(await resolveRailwayProductionRelease({
      trustedPublicKeys: { "other-key": release.trustedPublicKeys["production-test"] },
      fetchImpl: () => Promise.resolve(publicResponse(release.serverManifest)),
    })).toEqual({ state: "invalid" });
  });

  test.each(["server", "hosting"] as const)(
    "accepts a verified %s response after the former ten-second deadline",
    async (slowStage) => {
      const release = signedProductionRelease();
      const result = await resolveRailwayProductionRelease({
        trustedPublicKeys: release.trustedPublicKeys,
        fetchImpl: async (input, init) => {
          const isServer = (input instanceof Request ? input.url : input instanceof URL ? input.href : input) === SERVER_PRODUCTION_RELEASE_MANIFEST_URL;
          if ((slowStage === "server") === isServer) {
            await new Promise<void>((resolve, reject) => {
              const signal = init?.signal;
              const onAbort = () => {
                clearTimeout(timer);
                reject(new Error("metadata-request-aborted"));
              };
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              }, 11_000);
              signal?.addEventListener("abort", onAbort, { once: true });
            });
          }
          return isServer
            ? publicResponse(release.serverManifest)
            : publicResponse(release.hostingManifest, release.immutableHostingUrl);
        },
      });
      expect(result.state).toBe("verified");
      if (result.state === "verified") {
        expect(result.manifest.releaseId).toBe("qualification-local");
        expect(result.signedManifest).toEqual(release.hostingManifest);
      }
    },
    15_000,
  );

  test.each(["server", "hosting"] as const)(
    "cancels a stalled %s attempt and permits a fresh verified retry",
    async (stalledStage) => {
      const release = signedProductionRelease();
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      // Accelerate only the timer; the resolver must still supply its real budget.
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(20));
      let cancelled = false;
      try {
        const result = await resolveRailwayProductionRelease({
          trustedPublicKeys: release.trustedPublicKeys,
          fetchImpl: async (input, init) => {
            const isServer = (input instanceof Request ? input.url : input instanceof URL ? input.href : input) === SERVER_PRODUCTION_RELEASE_MANIFEST_URL;
            if ((stalledStage === "server") === isServer) {
              return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  cancelled = true;
                  reject(new Error("metadata-request-aborted"));
                }, { once: true });
              });
            }
            return publicResponse(release.serverManifest);
          },
        });
        expect(timeout).toHaveBeenCalledWith(60_000);
        expect(cancelled).toBe(true);
        expect(result.state).toBe(stalledStage === "server" ? "missing" : "invalid");
      } finally {
        timeout.mockRestore();
      }
      const retry = await resolveRailwayProductionRelease({
        trustedPublicKeys: release.trustedPublicKeys,
        fetchImpl: async (input) => (input instanceof Request ? input.url : input instanceof URL ? input.href : input) === SERVER_PRODUCTION_RELEASE_MANIFEST_URL
          ? publicResponse(release.serverManifest)
          : publicResponse(release.hostingManifest, release.immutableHostingUrl),
      });
      expect(retry.state).toBe("verified");
    },
  );

  test("re-verifies the retained signed release without consulting a newer or unavailable stable channel", async () => {
    const release = signedProductionRelease();
    let fetched = false;
    const options = { trustedPublicKeys: release.trustedPublicKeys, fetchImpl: async () => {
      fetched = true;
      throw new Error("stable has advanced or is unavailable");
    } };
    const result = await resolveRailwayRelease({}, options, release.hostingManifest);
    expect(result).toMatchObject({ state: "verified", manifest: { releaseId: "qualification-local" } });
    expect(fetched).toBe(false);
    const changed = { ...release.hostingManifest, manifest: { ...release.hostingManifest.manifest, releaseId: "forged-release" } };
    expect(await resolveRailwayRelease({}, options, changed)).toEqual({ state: "invalid" });
    expect(fetched).toBe(false);
  });

  test("preserves the legacy immutable route and isolates the v2 namespace", () => {
    const current = runtimeArtifactRecord();
    expect(immutableHostingManifestUrl(current)).toContain("/server/releases/runtime-v2/");
    const legacy = {
      ...current,
      image: current.image.replace("nautilo-runtime-v2", "nautilo-runtime"),
    };
    expect(immutableHostingManifestUrl(legacy)).toBe(
      `${RAILWAY_PRODUCTION_RELEASE_BASE_URL}/${legacy.sourceSha}/${
        legacy.manifestDigest.replace(":", "-")
      }/hosting-manifest.json`,
    );
    expect(() => immutableHostingManifestUrl({
      ...current,
      image: current.image.replace("ghcr.io", "ghcrXio"),
    })).toThrow("unsupported-runtime-repository");
  });

  test("distinguishes an unavailable server channel from invalid public bytes", async () => {
    expect(await resolveRailwayProductionRelease({
      fetchImpl: () => Promise.resolve(publicResponse({}, SERVER_PRODUCTION_RELEASE_MANIFEST_URL, { status: 404 })),
    })).toEqual({ state: "missing" });
    expect(await resolveRailwayProductionRelease({
      fetchImpl: () => Promise.reject(new Error("offline")),
    })).toEqual({ state: "missing" });
    expect(await resolveRailwayProductionRelease({
      fetchImpl: () => Promise.resolve(publicResponse({ malformed: true })),
    })).toEqual({ state: "invalid" });
    expect(await resolveRailwayProductionRelease({
      fetchImpl: () => Promise.resolve(publicResponse({}, SERVER_PRODUCTION_RELEASE_MANIFEST_URL, {
        headers: { "content-length": String(1024 * 1024 + 1) },
      })),
    })).toEqual({ state: "invalid" });
  });

  test("fails closed when the immutable hosting manifest is unavailable or names another server", async () => {
    const release = signedProductionRelease();
    expect(await resolveRailwayProductionRelease({
      trustedPublicKeys: release.trustedPublicKeys,
      fetchImpl: (input) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        return Promise.resolve(url === SERVER_PRODUCTION_RELEASE_MANIFEST_URL
          ? publicResponse(release.serverManifest)
          : publicResponse({}, release.immutableHostingUrl, { status: 404 }));
      },
    })).toEqual({ state: "invalid" });

    const originalBody = manifest();
    const mismatchedBody: ReleaseManifest = {
      ...originalBody,
      images: originalBody.images.map((image) => image.name === "nautilo-server"
        ? { ...image, reference: digest("ghcr.io/agentsea/nautilo-runtime-v2", "f") }
        : image),
    };
    const keys = generateKeyPairSync("ed25519");
    const mismatchedHosting = {
      manifest: mismatchedBody,
      signature: {
        algorithm: "ed25519" as const,
        keyId: "mismatch-test",
        value: sign(null, canonicalReleaseManifestBytes(mismatchedBody), keys.privateKey).toString("base64"),
      },
    };
    const serverBody = release.serverManifest.manifest;
    const serverManifest = {
      manifest: serverBody,
      signature: {
        algorithm: "ed25519" as const,
        keyId: "mismatch-test",
        value: sign(null, canonicalServerReleaseManifestBytes(serverBody), keys.privateKey).toString("base64"),
      },
    };
    const trustedPublicKeys = {
      "mismatch-test": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    };
    expect(await resolveRailwayProductionRelease({
      trustedPublicKeys,
      fetchImpl: (input) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        return Promise.resolve(url === SERVER_PRODUCTION_RELEASE_MANIFEST_URL
          ? publicResponse(serverManifest)
          : publicResponse(mismatchedHosting, release.immutableHostingUrl));
      },
    })).toEqual({ state: "invalid" });
  });

  test("an explicit qualification input overrides production and fails closed when partial", async () => {
    let productionRequests = 0;
    expect(await resolveRailwayRelease({
      [RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV]: "/tmp/incomplete",
    }, {
      fetchImpl: (() => {
        productionRequests += 1;
        return Promise.resolve(publicResponse({}));
      }),
    })).toEqual({ state: "invalid" });
    expect(productionRequests).toBe(0);
  });
});
