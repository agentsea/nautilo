import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalReleaseManifestBytes,
  verifyReleaseManifest,
  type ReleaseManifest,
  type SignedReleaseManifest,
  type VerifiedReleaseManifest,
} from "../../src";

const runtime = {
  runtimeVersion: 1,
  protocolVersion: 1,
  topologySchemaVersion: 1,
} as const;

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKeys = {
  "test-key": publicKey.export({ type: "spki", format: "der" }).toString("base64"),
};

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schemaVersion: 1,
    releaseId: "2026.08.03.1",
    images: [
      {
        name: "app-postgres",
        reference: "pgvector/pgvector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        name: "logto-postgres",
        reference: "postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      {
        name: "nautilo-server",
        reference: "ghcr.io/agentsea/nautilo-server@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
      {
        name: "logto",
        reference: "ghcr.io/logto-io/logto@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
      {
        name: "nautilo-bootstrap",
        // Digest-shaped fixture only; this test never asserts registry publication.
        reference: "ghcr.io/agentsea/nautilo-bootstrap@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
    ],
    topology: {
      schemaVersion: 1,
      bootstrap: { image: "nautilo-bootstrap" },
      services: [
        { name: "app-postgres", role: "app-postgres", image: "app-postgres" },
        { name: "logto-postgres", role: "logto-postgres", image: "logto-postgres" },
        { name: "logto-seed", role: "logto-seed", image: "logto" },
        { name: "nautilo-server", role: "nautilo-server", image: "nautilo-server" },
        { name: "logto", role: "logto", image: "logto" },
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
    ...overrides,
  };
}

function signed(value: ReleaseManifest = manifest()): SignedReleaseManifest {
  return {
    manifest: value,
    signature: {
      algorithm: "ed25519",
      keyId: "test-key",
      value: sign(null, canonicalReleaseManifestBytes(value), privateKey).toString("base64"),
    },
  };
}

function verify(input: unknown) {
  return verifyReleaseManifest(input, runtime, { trustedPublicKeys });
}

describe("release manifest verification", () => {
  test("accepts a digest-pinned, valid Ed25519-signed manifest", () => {
    const result = verify(signed());

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(`verification failed: ${result.code}`);
    const runtimeManifest: ReleaseManifest = result.manifest;
    expect(runtimeManifest).toEqual(manifest());
  });

  test("returns the verified-only manifest type without changing its runtime shape", () => {
    const result = verify(signed());
    if (!result.ok) throw new Error(`verification failed: ${result.code}`);

    const consumeVerified = (value: VerifiedReleaseManifest): string => value.releaseId;
    expect(consumeVerified(result.manifest)).toBe("2026.08.03.1");
    expect(Object.getOwnPropertySymbols(result.manifest)).toEqual([]);

    const ordinaryManifest: ReleaseManifest = manifest();
    // @ts-expect-error An ordinary parsed manifest has not crossed the verification gate.
    const verifiedManifest: VerifiedReleaseManifest = ordinaryManifest;
    void verifiedManifest;
  });

  test("requires the exact V1 bootstrap, five-service, five-image, three-mount topology", () => {
    const valid = manifest();

    expect(valid.images).toHaveLength(5);
    expect(valid.topology.services).toHaveLength(5);
    expect(valid.topology.persistentMounts).toHaveLength(3);
    expect(valid.topology.bootstrap).toEqual({ image: "nautilo-bootstrap" });
    expect(valid.topology.services.find((service) => service.role === "logto")?.image).toBe("logto");
    expect(valid.topology.services.find((service) => service.role === "logto-seed")?.image).toBe("logto");
  });

  test("uses deterministic key-sorted canonical bytes", () => {
    const first = manifest();
    const second = {
      compatibility: first.compatibility,
      topology: first.topology,
      images: first.images,
      releaseId: first.releaseId,
      schemaVersion: first.schemaVersion,
    } as ReleaseManifest;

    expect(Buffer.from(canonicalReleaseManifestBytes(first)).toString("utf8")).toBe(
      Buffer.from(canonicalReleaseManifestBytes(second)).toString("utf8"),
    );
  });

  test("fails closed if any signed manifest bytes are tampered", () => {
    const input = signed();
    const tampered = {
      ...input,
      manifest: { ...input.manifest, releaseId: "2026.08.03.2" },
    };

    expect(verify(tampered)).toEqual({ ok: false, code: "hosting.release.invalid-signature" });
  });

  test("returns stable malformed, unsigned, untrusted, and invalid-signature results", () => {
    expect(verify("not-json")).toEqual({ ok: false, code: "hosting.release.malformed" });
    expect(verify({ manifest: manifest() })).toEqual({ ok: false, code: "hosting.release.unsigned" });
    expect(verify({ ...signed(), signature: { algorithm: "rsa", keyId: "test-key", value: "not-a-signature" } })).toEqual({
      ok: false,
      code: "hosting.release.malformed",
    });
    expect(verify({ ...signed(), signature: { ...signed().signature, value: Buffer.alloc(1).toString("base64") } })).toEqual({
      ok: false,
      code: "hosting.release.malformed",
    });
    expect(verify({ ...signed(), signature: { ...signed().signature, keyId: "other-key" } })).toEqual({
      ok: false,
      code: "hosting.release.untrusted-key",
    });
    expect(verify({ ...signed(), signature: { ...signed().signature, value: Buffer.alloc(64).toString("base64") } })).toEqual({
      ok: false,
      code: "hosting.release.invalid-signature",
    });
  });

  test("does not trust inherited key IDs and contains injected verifier failures", () => {
    const inheritedOnly = Object.create({ "test-key": trustedPublicKeys["test-key"] }) as Record<string, string>;
    expect(verifyReleaseManifest(signed(), runtime, { trustedPublicKeys: inheritedOnly })).toEqual({
      ok: false,
      code: "hosting.release.untrusted-key",
    });
    expect(verifyReleaseManifest(signed(), runtime, {
      trustedPublicKeys,
      verifier: { verify: () => { throw new Error("test verifier failure"); } },
    })).toEqual({ ok: false, code: "hosting.release.invalid-signature" });
  });

  test("rejects unknown, secret-shaped schema fields instead of retaining them", () => {
    const input = signed();
    const withSecret = {
      ...input,
      manifest: { ...input.manifest, apiKey: "should-never-be-a-release-field" },
    };

    expect(verify(withSecret)).toEqual({ ok: false, code: "hosting.release.malformed" });
  });

  test("rejects mutable refs and malformed digest refs before deployment", () => {
    for (const reference of [
      "ghcr.io/agentsea/nautilo-server:latest",
      "ghcr.io/agentsea/nautilo-server@sha256:not-a-digest",
      "ghcr.io/agentsea/nautilo-server@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]) {
      const original = manifest();
      const input = signed({
        ...original,
        images: [{ ...original.images[0]!, reference }, ...original.images.slice(1)],
      });
      expect(verify(input)).toEqual({ ok: false, code: "hosting.release.mutable-image" });
    }
  });

  test("rejects missing required artifacts, wrong bootstrap or mounts, and forbidden extras", () => {
    const original = manifest();
    expect(verify(signed({ ...original, images: original.images.filter((image) => image.name !== "app-postgres") }))).toEqual({
      ok: false,
      code: "hosting.release.malformed",
    });
    expect(verify(signed({ ...original, images: original.images.filter((image) => image.name !== "nautilo-bootstrap") }))).toEqual({
      ok: false,
      code: "hosting.release.malformed",
    });
    expect(verify(signed({
      ...original,
      topology: {
        ...original.topology,
        services: original.topology.services.filter((service) => service.role !== "logto-seed"),
      },
    }))).toEqual({ ok: false, code: "hosting.release.malformed" });
    expect(verify(signed({
      ...original,
      topology: {
        ...original.topology,
        persistentMounts: original.topology.persistentMounts.slice(1),
      },
    }))).toEqual({ ok: false, code: "hosting.release.malformed" });

    const wrongMount = signed({
      ...original,
      topology: {
        ...original.topology,
        persistentMounts: [
          { ...original.topology.persistentMounts[0]!, mountPath: "/wrong" },
          ...original.topology.persistentMounts.slice(1),
        ],
      },
    });
    expect(verify(wrongMount)).toEqual({ ok: false, code: "hosting.release.malformed" });

    const wrongBootstrap = {
      ...signed(),
      manifest: { ...original, topology: { ...original.topology, bootstrap: { image: "logto" } } },
    };
    expect(verify(wrongBootstrap)).toEqual({ ok: false, code: "hosting.release.malformed" });

    const extraService = {
      ...signed(),
      manifest: {
        ...original,
        images: [
          ...original.images,
          { name: "collabora", reference: "ghcr.io/example/collabora@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
        ],
        topology: {
          ...original.topology,
          services: [
            ...original.topology.services,
            { name: "collabora", role: "collabora", image: "collabora" },
          ],
        },
      },
    };
    expect(verify(extraService)).toEqual({ ok: false, code: "hosting.release.malformed" });
  });

  test("rejects unsupported manifest schemas and incompatible runtime or topology versions", () => {
    const future = { ...signed(), manifest: { ...manifest(), schemaVersion: 2 } };
    expect(verify(future)).toEqual({ ok: false, code: "hosting.release.unsupported-version" });

    const runtimeIncompatible = signed({
      ...manifest(),
      compatibility: {
        ...manifest().compatibility,
        runtime: { minimum: 2, maximum: 2 },
      },
    });
    expect(verify(runtimeIncompatible)).toEqual({ ok: false, code: "hosting.release.incompatible-runtime" });

    const topologyIncompatible = signed({
      ...manifest(),
      compatibility: {
        ...manifest().compatibility,
        topology: { minimum: 2, maximum: 2 },
      },
    });
    expect(verify(topologyIncompatible)).toEqual({ ok: false, code: "hosting.release.incompatible-topology" });

    const unknownTopologyGrammar = signed({
      ...manifest(),
      topology: { ...manifest().topology, schemaVersion: 2 },
    });
    expect(verify(unknownTopologyGrammar)).toEqual({
      ok: false,
      code: "hosting.release.incompatible-topology",
    });
  });
});
