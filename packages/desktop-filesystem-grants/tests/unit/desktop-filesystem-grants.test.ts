import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  findMostSpecificMatchingDesktopFilesystemGrant,
  isPathWithinDesktopFilesystemGrantRoot,
  parseDesktopFilesystemGrant,
  DESKTOP_FILESYSTEM_GRANT_SCHEMA_VERSION,
  type DesktopFilesystemGrant,
  type DesktopFilesystemGrantValidationErrorCode,
} from "../../src/index";

const NOW = new Date("2030-01-01T00:00:00.000Z");

function validGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DESKTOP_FILESYSTEM_GRANT_SCHEMA_VERSION,
    id: "grant-opaque-id",
    canonicalRoot: path.join(path.sep, "Users", "alice", "approved"),
    access: ["read", "create_modify"],
    origin: "user_picker",
    lifetime: "durable",
    subject: {
      userId: "user-1",
      instanceId: "desktop-1",
      relayId: "relay-1",
      agentScope: "all_owned_agents",
    },
    createdBy: "alice",
    createdAt: "2030-01-01T00:00:00.000Z",
    policyVersion: 1,
    ...overrides,
  };
}

function parse(value: unknown) {
  return parseDesktopFilesystemGrant(value, { now: NOW });
}

function expectRejected(value: unknown, code: DesktopFilesystemGrantValidationErrorCode) {
  const result = parse(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("parseDesktopFilesystemGrant — valid persisted grants", () => {
  test("accepts each supported operation in a non-empty subset", () => {
    const result = parse(validGrant({ access: ["read", "create_modify", "delete", "execute"] }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.access).toEqual(["read", "create_modify", "delete", "execute"]);
      expect(result.revoked).toBe(false);
    }
  });

  test("normalizes absolute roots using host path semantics", () => {
    const rawRoot = path.join(path.sep, "Users", "alice", "approved", "..", "approved", "");
    const result = parse(validGrant({ canonicalRoot: rawRoot }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.grant.canonicalRoot).toBe(path.normalize(rawRoot));
  });

  test("accepts every origin and lifetime", () => {
    for (const origin of ["user_picker", "approval", "policy_pack"]) {
      for (const lifetime of ["once", "session", "durable"]) {
        const result = parse(validGrant({ origin, lifetime }));
        expect(result.ok).toBe(true);
      }
    }
  });

  test("canonicalizes valid optional timestamps and preserves opaque authorization", () => {
    const result = parse(
      validGrant({
        expiresAt: "2030-02-01T00:00:00Z",
        lastUsedAt: "2030-01-03T00:00:00Z",
        platformAuthorization: "opaque-safe-storage-reference",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.expiresAt).toBe("2030-02-01T00:00:00.000Z");
      expect(result.grant.lastUsedAt).toBe("2030-01-03T00:00:00.000Z");
      expect(result.grant.platformAuthorization).toBe("opaque-safe-storage-reference");
    }
  });

  test("accepts optional filesystem identity without changing schema version", () => {
    const result = parse(
      validGrant({
        filesystemIdentity: {
          realRoot: path.join(path.sep, "private", "var", "approved"),
          device: 10,
          inode: 20,
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.filesystemIdentity).toEqual({
        realRoot: path.join(path.sep, "private", "var", "approved"),
        device: 10,
        inode: 20,
      });
    }
  });

  test("accepts a valid revoked persisted record without treating it as authority", () => {
    const result = parse(
      validGrant({
        revokedAt: "2030-01-02T00:00:00.000Z",
        lastUsedAt: "2030-01-03T00:00:00.000Z",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revoked).toBe(true);
      expect(result.grant.lastUsedAt).toBe("2030-01-03T00:00:00.000Z");
    }
  });
});

describe("parseDesktopFilesystemGrant — schema and root rejection", () => {
  test("rejects non-record and unknown schema versions", () => {
    expectRejected(null, "invalid_record");
    expectRejected(validGrant({ schemaVersion: 2 }), "unknown_schema_version");
    expectRejected(validGrant({ schemaVersion: "1" }), "unknown_schema_version");
  });

  test("rejects unknown fields to fail closed across schema versions", () => {
    expectRejected(validGrant({ unexpected: true }), "unknown_field");
  });

  test("rejects malformed filesystem identity while accepting legacy records without it", () => {
    expectRejected(
      validGrant({ filesystemIdentity: { realRoot: path.join(path.sep, "approved"), device: 1 } }),
      "invalid_filesystem_identity",
    );
    expectRejected(
      validGrant({ filesystemIdentity: { realRoot: "relative", device: 1, inode: 2 } }),
      "invalid_filesystem_identity",
    );
    expectRejected(
      validGrant({ filesystemIdentity: { realRoot: path.join(path.sep, "approved"), extra: true } }),
      "invalid_filesystem_identity",
    );
    expect(parse(validGrant()).ok).toBe(true);
  });

  test("rejects an empty opaque id", () => {
    expectRejected(validGrant({ id: "" }), "invalid_id");
  });

  test("rejects relative, NUL-containing, and control-character roots", () => {
    expectRejected(validGrant({ canonicalRoot: "relative/root" }), "invalid_canonical_root");
    expectRejected(validGrant({ canonicalRoot: `${path.sep}approved\0root` }), "invalid_canonical_root");
    expectRejected(validGrant({ canonicalRoot: `${path.sep}approved\nroot` }), "invalid_canonical_root");
  });
});

describe("parseDesktopFilesystemGrant — access and binding rejection", () => {
  test("rejects empty, duplicate, and unsupported operation combinations", () => {
    expectRejected(validGrant({ access: [] }), "invalid_access");
    expectRejected(validGrant({ access: ["read", "read"] }), "invalid_access");
    expectRejected(validGrant({ access: ["read", "write"] }), "invalid_access");
  });

  test("rejects unsupported origin and lifetime", () => {
    expectRejected(validGrant({ origin: "renderer" }), "invalid_origin");
    expectRejected(validGrant({ lifetime: "forever" }), "invalid_lifetime");
  });

  test("rejects malformed subjects, including empty agent scope", () => {
    expectRejected(validGrant({ subject: { userId: "u", instanceId: "i", relayId: "r" } }), "invalid_subject");
    expectRejected(
      validGrant({ subject: { userId: "u", instanceId: "i", relayId: "r", agentScope: "   " } }),
      "invalid_subject",
    );
    expectRejected(
      validGrant({
        subject: { userId: "u", instanceId: "i", relayId: "r", agentScope: "scope", extra: "nope" },
      }),
      "invalid_subject",
    );
  });

  test("accepts the default instance (\"\") and rejects whitespace / noncanonical instance ids", () => {
    expect(parse(validGrant({ subject: { userId: "u", instanceId: "", relayId: "r", agentScope: "scope" } })).ok).toBe(
      true,
    );
    expectRejected(
      validGrant({ subject: { userId: "u", instanceId: "  ", relayId: "r", agentScope: "scope" } }),
      "invalid_subject",
    );
    expectRejected(
      validGrant({ subject: { userId: "u", instanceId: "Desktop-1", relayId: "r", agentScope: "scope" } }),
      "invalid_subject",
    );
    expectRejected(
      validGrant({ subject: { userId: "u", instanceId: " bad", relayId: "r", agentScope: "scope" } }),
      "invalid_subject",
    );
  });

  test("rejects missing required actor metadata", () => {
    expectRejected(validGrant({ createdBy: "" }), "invalid_created_by");
    expectRejected(validGrant({ policyVersion: 0 }), "invalid_policy_version");
    expectRejected(validGrant({ policyVersion: 1.5 }), "invalid_policy_version");
  });
});

describe("parseDesktopFilesystemGrant — dates and platform authorization", () => {
  test("rejects malformed and illogical timestamps", () => {
    expectRejected(validGrant({ createdAt: "not-a-date" }), "invalid_created_at");
    expectRejected(validGrant({ createdAt: "2030-01-01T00:00:00+02:00" }), "invalid_created_at");
    expectRejected(validGrant({ createdAt: "2030-02-30T00:00:00.000Z" }), "invalid_created_at");
    expectRejected(validGrant({ expiresAt: "2030-01-01T00:00:00.000Z" }), "invalid_expires_at");
    expectRejected(validGrant({ expiresAt: "2029-12-31T23:59:59.999Z" }), "invalid_expires_at");
    expectRejected(validGrant({ lastUsedAt: "not-a-date" }), "invalid_last_used_at");
    expectRejected(validGrant({ lastUsedAt: "2029-12-31T23:59:59.999Z" }), "invalid_last_used_at");
    expectRejected(validGrant({ expiresAt: "2031-01-01T00:00:00.000Z", revokedAt: "2029-12-31T23:59:59.999Z" }), "invalid_revoked_at");
  });

  test("rejects expired grants against the supplied clock", () => {
    expectRejected(validGrant({ expiresAt: "2029-12-31T23:59:59.999Z" }), "invalid_expires_at");
    expectRejected(
      validGrant({ createdAt: "2029-01-01T00:00:00.000Z", expiresAt: "2029-12-31T23:59:59.999Z" }),
      "expired",
    );
  });

  test("rejects malformed platform authorization", () => {
    expectRejected(validGrant({ platformAuthorization: "" }), "invalid_platform_authorization");
    expectRejected(validGrant({ platformAuthorization: "  " }), "invalid_platform_authorization");
    expectRejected(validGrant({ platformAuthorization: "token\nvalue" }), "invalid_platform_authorization");
    expectRejected(validGrant({ platformAuthorization: { token: "not-an-opaque-string" } }), "invalid_platform_authorization");
  });
});

test("validated result is assignable to the persisted grant contract", () => {
  const result = parse(validGrant());
  expect(result.ok).toBe(true);
  if (result.ok) {
    const persisted: DesktopFilesystemGrant = result.grant;
    expect(persisted.schemaVersion).toBe(DESKTOP_FILESYSTEM_GRANT_SCHEMA_VERSION);
  }
});

describe("Desktop Filesystem Grant root matching", () => {
  const root = path.join(path.sep, "approved");

  test("uses separator-aware containment and handles filesystem root", () => {
    expect(isPathWithinDesktopFilesystemGrantRoot(root, path.join(root, "child.txt"))).toBe(true);
    expect(isPathWithinDesktopFilesystemGrantRoot(root, path.join(path.sep, "approved-sibling", "child.txt"))).toBe(false);
    expect(isPathWithinDesktopFilesystemGrantRoot(path.parse(root).root, path.join(path.sep, "anything"))).toBe(true);
  });

  test("selects the most-specific root with the requested operation", () => {
    const broad = parse(validGrant({ id: "broad", canonicalRoot: root, access: ["read"] }));
    const narrow = parse(
      validGrant({
        id: "narrow",
        canonicalRoot: path.join(root, "projects"),
        access: ["read", "create_modify"],
      }),
    );
    expect(broad.ok && narrow.ok).toBe(true);
    if (!broad.ok || !narrow.ok) return;

    expect(
      findMostSpecificMatchingDesktopFilesystemGrant(
        [broad.grant, narrow.grant],
        path.join(root, "projects", "proposal.md"),
        "read",
      )?.id,
    ).toBe("narrow");
    expect(
      findMostSpecificMatchingDesktopFilesystemGrant(
        [broad.grant, narrow.grant],
        path.join(root, "projects", "proposal.md"),
        "delete",
      ),
    ).toBeUndefined();
  });
});
