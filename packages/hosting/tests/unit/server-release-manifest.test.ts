import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  canonicalServerReleaseManifestBytes,
  verifyServerReleaseManifest,
  type RuntimeArtifactRecordV1,
  type ServerReleaseManifest,
  type SignedServerReleaseManifest,
} from "../../src";

const sourceSha = "a".repeat(40);
const manifestDigest = `sha256:${"d".repeat(64)}` as const;

function artifact(): RuntimeArtifactRecordV1 {
  const evidenceDigest = `sha256:${"3".repeat(64)}` as const;
  return {
    version: 1,
    sourceSha,
    image: `ghcr.io/agentsea/nautilo-runtime-v2@${manifestDigest}`,
    manifestDigest,
    architectures: {
      "linux/amd64": `sha256:${"1".repeat(64)}`,
      "linux/arm64": `sha256:${"2".repeat(64)}`,
    },
    evidence: {
      sbom: evidenceDigest,
      vulnerabilities: evidenceDigest,
      disclosure: evidenceDigest,
      licenses: evidenceDigest,
      acceptance: evidenceDigest,
    },
    compatibility: {
      authContract: "Anonymous pull of ghcr.io/agentsea/nautilo-runtime-v2 by immutable digest; runtime requires configured Logto OIDC.",
      database: "This record adds no database migration; use the existing ComposeDriver migration-aware release transaction.",
      rollback: "full-bundle-required",
    },
  };
}

const keys = generateKeyPairSync("ed25519");
const trustedPublicKeys = {
  "server-release-test": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
};

function body(overrides: Partial<ServerReleaseManifest> = {}): ServerReleaseManifest {
  return { schemaVersion: 1, channel: "stable", runtimeArtifact: artifact(), ...overrides };
}

function signed(manifest: ServerReleaseManifest = body()): SignedServerReleaseManifest {
  return {
    manifest,
    signature: {
      algorithm: "ed25519",
      keyId: "server-release-test",
      value: sign(null, canonicalServerReleaseManifestBytes(manifest), keys.privateKey).toString("base64"),
    },
  };
}

describe("stable server release manifest", () => {
  test("accepts the exact signed stable envelope and returns a verified runtime record", () => {
    const result = verifyServerReleaseManifest(signed(), { trustedPublicKeys });
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.code);
    expect(result.manifest.channel).toBe("stable");
    expect(result.manifest.runtimeArtifact.image).toBe(`ghcr.io/agentsea/nautilo-runtime-v2@${manifestDigest}`);
    expect(Object.getOwnPropertySymbols(result.manifest)).toEqual([]);
  });

  test("uses deterministic key-sorted canonical bytes", () => {
    const first = body();
    const second = {
      runtimeArtifact: first.runtimeArtifact,
      channel: first.channel,
      schemaVersion: first.schemaVersion,
    } as ServerReleaseManifest;
    expect(Buffer.from(canonicalServerReleaseManifestBytes(first))).toEqual(
      Buffer.from(canonicalServerReleaseManifestBytes(second)),
    );
  });

  test("rejects tampering, wrong channels, future schemas, and extra fields", () => {
    const original = signed();
    expect(verifyServerReleaseManifest({
      ...original,
      manifest: {
        ...original.manifest,
        runtimeArtifact: { ...original.manifest.runtimeArtifact, sourceSha: "b".repeat(40) },
      },
    }, { trustedPublicKeys })).toEqual({ ok: false, code: "hosting.server-release.invalid-signature" });
    expect(verifyServerReleaseManifest({ ...original, manifest: { ...original.manifest, channel: "beta" } }, {
      trustedPublicKeys,
    })).toEqual({ ok: false, code: "hosting.server-release.wrong-channel" });
    expect(verifyServerReleaseManifest({ ...original, manifest: { ...original.manifest, schemaVersion: 2 } }, {
      trustedPublicKeys,
    })).toEqual({ ok: false, code: "hosting.server-release.unsupported-version" });
    expect(verifyServerReleaseManifest({
      ...original,
      manifest: { ...original.manifest, apiKey: "must-not-be-accepted" },
    }, { trustedPublicKeys })).toEqual({ ok: false, code: "hosting.server-release.malformed" });
  });

  test("rejects invalid runtime records before they can become release authority", () => {
    const original = body();
    for (const runtimeArtifact of [
      { ...original.runtimeArtifact, image: "ghcr.io/agentsea/nautilo-runtime-v2:main" },
      { ...original.runtimeArtifact, image: `ghcr.io/example/nautilo-runtime-v2@${manifestDigest}` },
      { ...original.runtimeArtifact, architectures: { ...original.runtimeArtifact.architectures, "linux/amd64": manifestDigest } },
      { ...original.runtimeArtifact, privatePullToken: "must-not-be-accepted" },
    ]) {
      expect(verifyServerReleaseManifest(signed({ ...original, runtimeArtifact } as ServerReleaseManifest), {
        trustedPublicKeys,
      })).toEqual({ ok: false, code: "hosting.server-release.invalid-runtime-artifact" });
    }
  });

  test("fails closed for unsigned, malformed, untrusted, invalid, and throwing verifier inputs", () => {
    expect(verifyServerReleaseManifest({ manifest: body() }, { trustedPublicKeys })).toEqual({
      ok: false,
      code: "hosting.server-release.unsigned",
    });
    expect(verifyServerReleaseManifest("invalid", { trustedPublicKeys })).toEqual({
      ok: false,
      code: "hosting.server-release.malformed",
    });
    expect(verifyServerReleaseManifest({ ...signed(), signature: { ...signed().signature, keyId: "other" } }, {
      trustedPublicKeys,
    })).toEqual({ ok: false, code: "hosting.server-release.untrusted-key" });
    expect(verifyServerReleaseManifest({
      ...signed(),
      signature: { ...signed().signature, value: Buffer.alloc(64).toString("base64") },
    }, { trustedPublicKeys })).toEqual({ ok: false, code: "hosting.server-release.invalid-signature" });
    const inherited = Object.create(trustedPublicKeys) as Record<string, string>;
    expect(verifyServerReleaseManifest(signed(), { trustedPublicKeys: inherited })).toEqual({
      ok: false,
      code: "hosting.server-release.untrusted-key",
    });
    expect(verifyServerReleaseManifest(signed(), {
      trustedPublicKeys,
      verifier: { verify: () => { throw new Error("test verifier failure"); } },
    })).toEqual({ ok: false, code: "hosting.server-release.invalid-signature" });
  });
});
