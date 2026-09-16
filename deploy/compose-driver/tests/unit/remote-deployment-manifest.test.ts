import { describe, expect, test } from "bun:test";

import {
  assertRemoteDeploymentManifestIdentity,
  migrateRemoteDeploymentManifest,
  remoteDeploymentManifestSchema,
  type RemoteDeploymentManifest,
} from "../../src/remote-deployment-manifest.ts";

const VALID_MANIFEST: RemoteDeploymentManifest = {
  version: 1,
  instanceId: "prod",
  composeProjectName: "nautilo-prod",
  lifecycle: "compose",
  image: {
    mode: "registry",
    reference: "ghcr.io/example/nautilo:1.2.3",
  },
  remoteRoot: "/opt/nautilo-prod",
  https: "letsencrypt",
  createdAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-10T12:30:00.000Z",
};

function parse(input: unknown) {
  return remoteDeploymentManifestSchema.safeParse(input);
}

describe("remoteDeploymentManifestSchema", () => {
  test("accepts a valid registry manifest", () => {
    const result = parse(VALID_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_MANIFEST);
    }
  });

  test("accepts v2 contracts and migrates v1 in memory without inventing an auth stamp", () => {
    const parsedV1 = remoteDeploymentManifestSchema.parse(VALID_MANIFEST);
    expect(migrateRemoteDeploymentManifest(parsedV1)).toEqual({
      ...VALID_MANIFEST,
      version: 2,
      contracts: {},
    });

    expect(
      parse({
        ...VALID_MANIFEST,
        version: 2,
        contracts: {
          authApplied: {
            contractVersion: 1,
            contractHash: "a".repeat(64),
            appliedAt: "2026-07-10T12:30:00.000Z",
            logtoEngine: {
              image: "ghcr.io/logto-io/logto:1.38.0",
              minimumVersion: "1.38.0",
            },
          },
        },
      }).success,
    ).toBe(true);
  });

  test("accepts empty instanceId", () => {
    const result = parse({
      ...VALID_MANIFEST,
      instanceId: "",
      composeProjectName: "nautilo",
      remoteRoot: "/opt/nautilo",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    const { version: _v, ...withoutVersion } = VALID_MANIFEST;
    expect(parse(withoutVersion).success).toBe(false);
    expect(parse({ version: 1 }).success).toBe(false);
  });

  test("rejects malformed field types", () => {
    expect(parse({ ...VALID_MANIFEST, version: 2 }).success).toBe(false);
    expect(parse({ ...VALID_MANIFEST, lifecycle: "external" }).success).toBe(
      false,
    );
    expect(parse({ ...VALID_MANIFEST, https: "selfsigned" }).success).toBe(
      false,
    );
    expect(
      parse({ ...VALID_MANIFEST, image: { mode: "source", reference: "x" } })
        .success,
    ).toBe(false);
  });

  test("rejects secret-bearing top-level fields via strict()", () => {
    expect(
      parse({ ...VALID_MANIFEST, dbPassword: "secret" }).success,
    ).toBe(false);
    expect(
      parse({ ...VALID_MANIFEST, bootstrapToken: "tok" }).success,
    ).toBe(false);
    expect(
      parse({ ...VALID_MANIFEST, instanceEnv: "NAUTILO_DB_PASSWORD=x" })
        .success,
    ).toBe(false);
  });

  test("rejects unknown top-level keys via strict()", () => {
    expect(parse({ ...VALID_MANIFEST, extra: "field" }).success).toBe(false);
  });

  test("rejects unknown image keys via strict()", () => {
    expect(
      parse({
        ...VALID_MANIFEST,
        image: {
          ...VALID_MANIFEST.image,
          credentials: "user:pass",
        },
      }).success,
    ).toBe(false);
  });

  test("rejects invalid instanceId values", () => {
    expect(parse({ ...VALID_MANIFEST, instanceId: "PROD" }).success).toBe(
      false,
    );
    expect(
      parse({ ...VALID_MANIFEST, instanceId: "a".repeat(17) }).success,
    ).toBe(false);
    expect(parse({ ...VALID_MANIFEST, instanceId: "bad_id" }).success).toBe(
      false,
    );
  });

  test("rejects invalid composeProjectName values", () => {
    expect(parse({ ...VALID_MANIFEST, composeProjectName: "" }).success).toBe(
      false,
    );
    expect(
      parse({ ...VALID_MANIFEST, composeProjectName: "Nautilo-Prod" }).success,
    ).toBe(false);
    expect(
      parse({ ...VALID_MANIFEST, composeProjectName: "nautilo.prod" }).success,
    ).toBe(false);
  });

  test("rejects empty image.reference", () => {
    expect(
      parse({
        ...VALID_MANIFEST,
        image: { mode: "registry", reference: "" },
      }).success,
    ).toBe(false);
  });

  test("rejects invalid remoteRoot values", () => {
    expect(parse({ ...VALID_MANIFEST, remoteRoot: "opt/nautilo" }).success).toBe(
      false,
    );
    expect(parse({ ...VALID_MANIFEST, remoteRoot: "/opt//nautilo" }).success).toBe(
      false,
    );
    expect(
      parse({ ...VALID_MANIFEST, remoteRoot: "/opt/./nautilo" }).success,
    ).toBe(false);
    expect(
      parse({ ...VALID_MANIFEST, remoteRoot: "/opt/../nautilo" }).success,
    ).toBe(false);
    expect(
      parse({ ...VALID_MANIFEST, remoteRoot: "/opt/nautilo/" }).success,
    ).toBe(false);
  });

  test("accepts remote root /", () => {
    expect(parse({ ...VALID_MANIFEST, remoteRoot: "/" }).success).toBe(true);
  });

  test("rejects invalid date strings", () => {
    expect(parse({ ...VALID_MANIFEST, createdAt: "not-a-date" }).success).toBe(
      false,
    );
    expect(parse({ ...VALID_MANIFEST, updatedAt: "" }).success).toBe(false);
  });
});

describe("assertRemoteDeploymentManifestIdentity", () => {
  const expected = {
    instanceId: "prod",
    composeProjectName: "nautilo-prod",
    remoteRoot: "/opt/nautilo-prod",
  };

  test("succeeds when identity fields match", () => {
    expect(() =>
      assertRemoteDeploymentManifestIdentity(VALID_MANIFEST, expected),
    ).not.toThrow();
  });

  test("throws on instanceId mismatch", () => {
    expect(() =>
      assertRemoteDeploymentManifestIdentity(VALID_MANIFEST, {
        ...expected,
        instanceId: "staging",
      }),
    ).toThrow(/instanceId: expected 'staging', got 'prod'/);
  });

  test("throws on composeProjectName mismatch", () => {
    expect(() =>
      assertRemoteDeploymentManifestIdentity(VALID_MANIFEST, {
        ...expected,
        composeProjectName: "nautilo-staging",
      }),
    ).toThrow(/composeProjectName: expected 'nautilo-staging', got 'nautilo-prod'/);
  });

  test("throws on remoteRoot mismatch", () => {
    expect(() =>
      assertRemoteDeploymentManifestIdentity(VALID_MANIFEST, {
        ...expected,
        remoteRoot: "/opt/nautilo-staging",
      }),
    ).toThrow(/remoteRoot: expected '\/opt\/nautilo-staging', got '\/opt\/nautilo-prod'/);
  });

  test("reports multiple mismatches in one error", () => {
    expect(() =>
      assertRemoteDeploymentManifestIdentity(VALID_MANIFEST, {
        instanceId: "staging",
        composeProjectName: "nautilo-staging",
        remoteRoot: "/opt/nautilo-staging",
      }),
    ).toThrow(/instanceId: expected 'staging', got 'prod'/);
    expect(() =>
      assertRemoteDeploymentManifestIdentity(VALID_MANIFEST, {
        instanceId: "staging",
        composeProjectName: "nautilo-staging",
        remoteRoot: "/opt/nautilo-staging",
      }),
    ).toThrow(/composeProjectName: expected 'nautilo-staging', got 'nautilo-prod'/);
    expect(() =>
      assertRemoteDeploymentManifestIdentity(VALID_MANIFEST, {
        instanceId: "staging",
        composeProjectName: "nautilo-staging",
        remoteRoot: "/opt/nautilo-staging",
      }),
    ).toThrow(/remoteRoot: expected '\/opt\/nautilo-staging', got '\/opt\/nautilo-prod'/);
  });
});
