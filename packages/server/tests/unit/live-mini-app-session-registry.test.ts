import { describe, expect, test } from "bun:test";
import { LiveMiniAppSessionRegistry } from "../../src/apps/live-mini-app-session-registry";

const binding = {
  targetKind: "artifact" as const,
  appId: "nautilo-writer",
  userId: "user-1",
  namespaceIds: ["namespace-1"],
  artifactId: "artifact-row-1",
  documentId: "artifact-row-1",
  documentVersion: { kind: "artifact_revision" as const, revision: 7 },
};

const refreshExpected = {
  targetKind: "artifact" as const,
  appId: binding.appId,
  userId: binding.userId,
  artifactId: binding.artifactId,
  documentId: binding.documentId,
};

const validateExpected = {
  targetKind: "artifact" as const,
  appId: binding.appId,
  userId: binding.userId,
  artifactId: binding.artifactId,
  documentId: binding.documentId,
  documentVersion: binding.documentVersion,
};

describe("LiveMiniAppSessionRegistry", () => {
  test("issues distinct opaque token and non-authorizing routing handles", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const first = registry.issue(binding);
    const second = registry.issue(binding);

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.sessionId).not.toBe(first.token);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(registry.validate(first.sessionId, validateExpected)).toEqual({
      ok: false,
      code: "session_closed",
    });
    expect(registry.revokeForSubject(first.sessionId, binding)).toBe(false);
    expect(registry.validate(first.token, validateExpected).ok).toBe(true);
    expect(first.token).not.toContain(binding.artifactId);
    expect(() =>
      registry.issue({
        ...binding,
        documentVersion: { kind: "artifact_revision", revision: -1 },
      }),
    ).toThrow("valid bound document version");
    expect(() => registry.issue({ ...binding, namespaceIds: [] })).toThrow(
      "valid bound document version",
    );
  });

  test("matches current files only by exact owner, pinned relay, and canonical identity", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue({
      targetKind: "currentFile",
      appId: "nautilo-writer",
      userId: "user-1",
      localTargetId: "opaque-target",
      relayId: "relay-1",
      canonicalPath: "/real/project/open.doc.html",
      currentFolderRoot: "/project",
      relativePath: "open.doc.html",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
    });

    expect(registry.hasOpenSessionForCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "relay-1",
      canonicalTargetIdentity: "/real/project/open.doc.html",
    })).toBe(true);
    expect(registry.hasOpenSessionForCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "relay-2",
      canonicalTargetIdentity: "/real/project/open.doc.html",
    })).toBe(false);
    expect(registry.hasOpenSessionForCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "other-user",
      relayId: "relay-1",
      canonicalTargetIdentity: "/real/project/open.doc.html",
    })).toBe(false);
    expect(registry.hasOpenSessionForCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "relay-1",
      canonicalTargetIdentity: "/project/open.doc.html",
    })).toBe(false);

    registry.revokeForSubject(issued.token, {
      appId: "nautilo-writer",
      userId: "user-1",
    });
    expect(registry.hasOpenSessionForCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "relay-1",
      canonicalTargetIdentity: "/real/project/open.doc.html",
    })).toBe(false);
  });

  test("matches canonical directory identities only for exact descendants", () => {
    const registry = new LiveMiniAppSessionRegistry();
    registry.issue({
      targetKind: "currentFile",
      appId: "nautilo-writer",
      userId: "user-1",
      localTargetId: "opaque-target",
      relayId: "relay-1",
      canonicalPath: "/real/project/docs/open.doc.html",
      currentFolderRoot: "/project",
      relativePath: "docs/open.doc.html",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
    });

    expect(registry.hasOpenSessionAtOrBelowCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "relay-1",
      canonicalDirectoryIdentity: "/real/project/docs",
    })).toBe(true);
    expect(registry.hasOpenSessionAtOrBelowCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "relay-1",
      canonicalDirectoryIdentity: "/real/project/doc",
    })).toBe(false);
    expect(registry.hasOpenSessionAtOrBelowCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "relay-1",
      canonicalDirectoryIdentity: "/real/project/other",
    })).toBe(false);
    expect(registry.hasOpenSessionAtOrBelowCurrentFileIdentity({
      appId: "nautilo-writer",
      userId: "user-1",
      relayId: "other-relay",
      canonicalDirectoryIdentity: "/real/project",
    })).toBe(false);
  });

  test("validates the exact application, subject, target, and revision without room binding", () => {
    const registry = new LiveMiniAppSessionRegistry(() => 100, 50);
    const { token, sessionId } = registry.issue(binding);

    expect(registry.validate(token, validateExpected)).toEqual({
      ok: true,
      binding,
      sessionId,
      expiresAt: 150,
    });
    expect(registry.validate(token, { ...validateExpected, appId: "test-canvas" })).toEqual({
      ok: false,
      code: "session_closed",
    });
    expect(registry.validate(token, { ...validateExpected, artifactId: "other-artifact" })).toEqual({
      ok: false,
      code: "session_closed",
    });
    expect(
      registry.validate(token, {
        ...validateExpected,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      }),
    ).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: binding.documentVersion,
    });
    expect(
      registry.validateForSubject(token, {
        appId: binding.appId,
        userId: binding.userId,
        documentVersion: binding.documentVersion,
      }),
    ).toEqual({ ok: true, binding, sessionId, expiresAt: 150 });
    expect(
      registry.validateForSubject(token, {
        appId: binding.appId,
        userId: "other-user",
        documentVersion: binding.documentVersion,
      }),
    ).toEqual({ ok: false, code: "session_closed" });
  });

  test("refreshes only an open session and updates its exact revision", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 50);
    const { token, sessionId } = registry.issue(binding);
    now = 120;

    expect(
      registry.refresh(token, { kind: "artifact_revision", revision: 8 }, refreshExpected),
    ).toEqual({
      ok: true,
      binding: {
        ...binding,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      },
      sessionId,
      expiresAt: 170,
    });
    expect(registry.validate(token, validateExpected)).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: { kind: "artifact_revision", revision: 8 },
    });
    expect(
      registry.validate(token, {
        ...validateExpected,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      }),
    ).toEqual({
      ok: true,
      binding: {
        ...binding,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      },
      sessionId,
      expiresAt: 170,
    });
  });

  test("revokes only for the bound authenticated subject and returns session_closed after expiry", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 10);
    const revoked = registry.issue(binding).token;
    expect(
      registry.revokeForSubject(revoked, {
        appId: binding.appId,
        userId: "other-user",
      }),
    ).toBe(false);
    expect(registry.validate(revoked, validateExpected).ok).toBe(true);
    expect(
      registry.revokeForSubject(revoked, {
        appId: binding.appId,
        userId: binding.userId,
      }),
    ).toBe(true);
    expect(registry.validate(revoked, validateExpected)).toEqual({ ok: false, code: "session_closed" });

    const expired = registry.issue(binding).token;
    now += 10;
    expect(registry.validate(expired, validateExpected)).toEqual({ ok: false, code: "session_closed" });
    expect(
      registry.refresh(expired, { kind: "artifact_revision", revision: 8 }, refreshExpected),
    ).toEqual({ ok: false, code: "session_closed" });
  });

  test("finds only a currently open session for the exact app, user, and internal artifact", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 10);
    const token = registry.issue(binding).token;

    expect(registry.hasOpenSessionForArtifact({
      appId: binding.appId,
      userId: binding.userId,
      artifactId: binding.artifactId,
    })).toBe(true);
    expect(registry.hasOpenSessionForArtifact({
      appId: binding.appId,
      userId: "other-user",
      artifactId: binding.artifactId,
    })).toBe(false);
    expect(registry.hasOpenSessionForArtifact({
      appId: "other-app",
      userId: binding.userId,
      artifactId: binding.artifactId,
    })).toBe(false);
    expect(registry.hasOpenSessionForArtifact({
      appId: binding.appId,
      userId: binding.userId,
      artifactId: "other-artifact",
    })).toBe(false);

    expect(registry.revokeForSubject(token, binding)).toBe(true);
    expect(registry.hasOpenSessionForArtifact({
      appId: binding.appId,
      userId: binding.userId,
      artifactId: binding.artifactId,
    })).toBe(false);

    registry.issue(binding);
    now += 10;
    expect(registry.hasOpenSessionForArtifact({
      appId: binding.appId,
      userId: binding.userId,
      artifactId: binding.artifactId,
    })).toBe(false);
  });
});
