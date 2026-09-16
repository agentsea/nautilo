import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  canonicalServerReleaseManifestBytes,
  type RuntimeArtifactRecordV1,
  type ServerReleaseManifest,
} from "@nautilo/hosting";

import {
  SERVER_PRODUCTION_RELEASE_MANIFEST_URL,
  resolveServerProductionRelease,
} from "../../src/lib/server-release-source.ts";

function runtimeArtifact(): RuntimeArtifactRecordV1 {
  const manifestDigest = `sha256:${"d".repeat(64)}` as const;
  return {
    version: 1,
    sourceSha: "a".repeat(40),
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

function signedRelease() {
  const keys = generateKeyPairSync("ed25519");
  const manifest: ServerReleaseManifest = {
    schemaVersion: 1,
    channel: "stable",
    runtimeArtifact: runtimeArtifact(),
  };
  return {
    value: {
      manifest,
      signature: {
        algorithm: "ed25519" as const,
        keyId: "production-test",
        value: sign(null, canonicalServerReleaseManifestBytes(manifest), keys.privateKey).toString("base64"),
      },
    },
    trustedPublicKeys: {
      "production-test": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
  };
}

function publicResponse(
  value: unknown,
  init: ResponseInit = {},
  url: string = SERVER_PRODUCTION_RELEASE_MANIFEST_URL,
): Response {
  const response = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("server production release source", () => {
  test("fetches the exact stable pointer and accepts it only under pinned trust", async () => {
    const release = signedRelease();
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const result = await resolveServerProductionRelease({
      trustedPublicKeys: release.trustedPublicKeys,
      fetchImpl: (input, init) => {
        requestedUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        requestedInit = init;
        return Promise.resolve(publicResponse(release.value));
      },
    });

    expect(requestedUrl).toBe(SERVER_PRODUCTION_RELEASE_MANIFEST_URL);
    expect(requestedInit?.redirect).toBe("error");
    expect(result.state).toBe("verified");
    if (result.state === "verified") {
      expect(JSON.stringify(result.runtimeArtifact)).toBe(JSON.stringify(runtimeArtifact()));
    }
    expect(await resolveServerProductionRelease({
      trustedPublicKeys: { "other-key": release.trustedPublicKeys["production-test"] },
      fetchImpl: () => Promise.resolve(publicResponse(release.value)),
    })).toEqual({ state: "invalid" });
  });

  test("distinguishes unavailable transport from invalid public bytes", async () => {
    expect(await resolveServerProductionRelease({
      fetchImpl: () => Promise.resolve(publicResponse({}, { status: 404 })),
    })).toEqual({ state: "missing" });
    expect(await resolveServerProductionRelease({
      fetchImpl: () => Promise.reject(new Error("offline")),
    })).toEqual({ state: "missing" });
    expect(await resolveServerProductionRelease({
      fetchImpl: () => Promise.resolve(publicResponse({ malformed: true })),
    })).toEqual({ state: "invalid" });
    expect(await resolveServerProductionRelease({
      fetchImpl: () => Promise.resolve(publicResponse({}, {
        headers: { "content-length": String(1024 * 1024 + 1) },
      })),
    })).toEqual({ state: "invalid" });
  });

  test("rejects a redirected or unexpected response URL before verification", async () => {
    const release = signedRelease();
    expect(await resolveServerProductionRelease({
      trustedPublicKeys: release.trustedPublicKeys,
      fetchImpl: () => Promise.resolve(publicResponse(
        release.value,
        {},
        "https://media.nautilo.ai/server/releases/older/manifest.json",
      )),
    })).toEqual({ state: "missing" });
  });
});
