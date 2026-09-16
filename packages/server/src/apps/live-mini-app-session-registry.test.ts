import { describe, expect, test } from "bun:test";
import type { LiveDocumentVersion } from "@nautilo/types";
import {
  liveDocumentVersionEquals,
  parseArtifactDocumentVersion,
  parseLiveDocumentVersion,
  parseLocalSha256,
  parseLocalShaDocumentVersion,
  parseNonNegativeSafeInteger,
} from "@nautilo/types";
import { LiveMiniAppSessionRegistry } from "./live-mini-app-session-registry";

const LOCAL_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOCAL_SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const artifactBinding = {
  targetKind: "artifact" as const,
  appId: "first-party-review",
  userId: "user",
  namespaceIds: ["ns"],
  artifactId: "artifact",
  documentId: "document",
  documentVersion: { kind: "artifact_revision" as const, revision: 3 },
};

const currentFileBinding = {
  targetKind: "currentFile" as const,
  appId: "first-party-review",
  userId: "user",
  localTargetId: "local-target-1",
  relayId: "relay-1",
  canonicalPath: "/Users/human/project/docs/readme.md",
  currentFolderRoot: "/Users/human/project",
  relativePath: "docs/readme.md",
  documentVersion: { kind: "local_sha" as const, sha256: LOCAL_SHA },
};

describe("LiveDocumentVersion helpers", () => {
  test("parseNonNegativeSafeInteger accepts only non-negative safe integers", () => {
    expect(parseNonNegativeSafeInteger(0)).toBe(0);
    expect(parseNonNegativeSafeInteger(7)).toBe(7);
    expect(parseNonNegativeSafeInteger(-1)).toBeNull();
    expect(parseNonNegativeSafeInteger(1.5)).toBeNull();
    expect(parseNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(parseNonNegativeSafeInteger("7")).toBeNull();
  });

  test("parseLocalSha256 requires canonical lowercase 64 hex", () => {
    expect(parseLocalSha256(LOCAL_SHA)).toBe(LOCAL_SHA);
    expect(parseLocalSha256(LOCAL_SHA.toUpperCase())).toBeNull();
    expect(parseLocalSha256(`${LOCAL_SHA}0`)).toBeNull();
    expect(parseLocalSha256("not-hex")).toBeNull();
  });

  test("parseLiveDocumentVersion rejects malformed and mismatched kinds", () => {
    expect(parseArtifactDocumentVersion({ kind: "artifact_revision", revision: 3 })).toEqual({
      kind: "artifact_revision",
      revision: 3,
    });
    expect(parseLocalShaDocumentVersion({ kind: "local_sha", sha256: LOCAL_SHA })).toEqual({
      kind: "local_sha",
      sha256: LOCAL_SHA,
    });
    expect(parseLiveDocumentVersion({ kind: "artifact_revision", revision: -1 })).toBeNull();
    expect(parseLiveDocumentVersion({ kind: "local_sha", sha256: "bad" })).toBeNull();
    expect(parseLiveDocumentVersion({ kind: "local_sha", revision: 3 })).toBeNull();
  });

  test("liveDocumentVersionEquals compares kind and payload", () => {
    const left: LiveDocumentVersion = { kind: "artifact_revision", revision: 3 };
    const right: LiveDocumentVersion = { kind: "artifact_revision", revision: 3 };
    expect(liveDocumentVersionEquals(left, right)).toBe(true);
    expect(liveDocumentVersionEquals(left, { kind: "artifact_revision", revision: 4 })).toBe(false);
    expect(liveDocumentVersionEquals(left, { kind: "local_sha", sha256: LOCAL_SHA })).toBe(false);
    expect(
      liveDocumentVersionEquals(
        { kind: "local_sha", sha256: LOCAL_SHA },
        { kind: "local_sha", sha256: LOCAL_SHA },
      ),
    ).toBe(true);
  });
});

describe("LiveMiniAppSessionRegistry artifact sessions", () => {
  test("issues distinct opaque token and non-authorizing routing handles", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const first = registry.issue(artifactBinding);
    const second = registry.issue(artifactBinding);

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.sessionId).not.toBe(first.token);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(registry.validate(first.sessionId, artifactBinding)).toEqual({
      ok: false,
      code: "session_closed",
    });
    expect(registry.revokeForSubject(first.sessionId, artifactBinding)).toBe(false);
    expect(registry.validate(first.token, artifactBinding).ok).toBe(true);
    expect(first.token).not.toContain(artifactBinding.artifactId);
    expect(() =>
      registry.issue({
        ...artifactBinding,
        documentVersion: { kind: "artifact_revision", revision: -1 },
      }),
    ).toThrow("valid bound document version");
    expect(() => registry.issue({ ...artifactBinding, namespaceIds: [] })).toThrow(
      "valid bound document version",
    );
  });

  test("validates the exact application, subject, target, and version", () => {
    const registry = new LiveMiniAppSessionRegistry(() => 100, 50);
    const { token, sessionId } = registry.issue(artifactBinding);

    expect(registry.validate(token, artifactBinding)).toEqual({
      ok: true,
      binding: artifactBinding,
      sessionId,
      expiresAt: 150,
    });
    expect(registry.validate(token, { ...artifactBinding, appId: "other-app" })).toEqual({
      ok: false,
      code: "session_closed",
    });
    expect(registry.validate(token, { ...artifactBinding, artifactId: "other-artifact" })).toEqual({
      ok: false,
      code: "session_closed",
    });
    expect(
      registry.validate(token, {
        ...artifactBinding,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      }),
    ).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: artifactBinding.documentVersion,
    });
    expect(
      registry.validateForSubject(token, {
        appId: artifactBinding.appId,
        userId: artifactBinding.userId,
        documentVersion: artifactBinding.documentVersion,
      }),
    ).toEqual({ ok: true, binding: artifactBinding, sessionId, expiresAt: 150 });
    expect(
      registry.validateForSubject(token, {
        appId: artifactBinding.appId,
        userId: "other-user",
        documentVersion: artifactBinding.documentVersion,
      }),
    ).toEqual({ ok: false, code: "session_closed" });
  });

  test("refreshes only an open session and updates its exact version", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 50);
    const { token, sessionId } = registry.issue(artifactBinding);
    now = 120;

    expect(
      registry.refresh(token, { kind: "artifact_revision", revision: 8 }, artifactBinding),
    ).toEqual({
      ok: true,
      binding: {
        ...artifactBinding,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      },
      sessionId,
      expiresAt: 170,
    });
    expect(registry.validate(token, artifactBinding)).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: { kind: "artifact_revision", revision: 8 },
    });
    expect(
      registry.validate(token, {
        ...artifactBinding,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      }),
    ).toEqual({
      ok: true,
      binding: {
        ...artifactBinding,
        documentVersion: { kind: "artifact_revision", revision: 8 },
      },
      sessionId,
      expiresAt: 170,
    });
  });

  test("replays completed direct mutations across version refresh and rejects key collisions", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(artifactBinding);
    const claimArgs = {
      appId: artifactBinding.appId,
      userId: artifactBinding.userId,
      documentVersion: artifactBinding.documentVersion,
      idempotencyKey: "edit-1",
      operationFingerprint: "fingerprint-a",
    };
    expect(registry.claimDirectMutation(issued.token, claimArgs)).toMatchObject({
      ok: true,
      status: "claimed",
      sessionId: issued.sessionId,
    });
    expect(registry.claimDirectMutation(issued.token, claimArgs)).toEqual({
      ok: false,
      code: "idempotency_in_progress",
    });
    expect(registry.completeDirectMutation(issued.token, {
      ...claimArgs,
      sessionId: issued.sessionId,
    }, "{\"ok\":true,\"receiptId\":\"receipt-1\"}", {
      kind: "artifact_revision",
      revision: 4,
    })).toBe(true);
    expect(registry.claimDirectMutation(issued.token, claimArgs)).toEqual({
      ok: true,
      status: "replay",
      resultContent: "{\"ok\":true,\"receiptId\":\"receipt-1\"}",
    });
    expect(registry.claimDirectMutation(issued.token, {
      ...claimArgs,
      operationFingerprint: "fingerprint-b",
    })).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(registry.claimDirectMutation(issued.token, {
      ...claimArgs,
      documentVersion: { kind: "artifact_revision", revision: 4 },
    })).toEqual({
      ok: true,
      status: "replay",
      resultContent: "{\"ok\":true,\"receiptId\":\"receipt-1\"}",
    });
  });

  test("returns the current bound version for authenticated stale validation and claims", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const revision4 = { kind: "artifact_revision" as const, revision: 4 };
    const revision5 = { kind: "artifact_revision" as const, revision: 5 };
    const binding = { ...artifactBinding, documentVersion: revision4 };
    const issued = registry.issue(binding);
    registry.refresh(issued.token, revision5, binding);

    expect(registry.validateForSubject(issued.token, {
      appId: binding.appId,
      userId: binding.userId,
      documentVersion: revision4,
    })).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: revision5,
    });
    expect(registry.claimDirectMutation(issued.token, {
      appId: binding.appId,
      userId: binding.userId,
      documentVersion: revision4,
      idempotencyKey: "stale-v4",
      operationFingerprint: "stale-fingerprint",
    })).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: revision5,
    });
    expect(registry.claimDirectMutation(issued.token, {
      appId: binding.appId,
      userId: binding.userId,
      documentVersion: revision5,
      idempotencyKey: "retry-v5",
      operationFingerprint: "retry-fingerprint",
    })).toMatchObject({ ok: true, status: "claimed" });
  });

  test("bounds direct mutation results and purges the ledger with session lifecycle", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 50, 2);
    const issued = registry.issue(artifactBinding);
    const claim = (idempotencyKey: string) => ({
      appId: artifactBinding.appId,
      userId: artifactBinding.userId,
      documentVersion: artifactBinding.documentVersion,
      idempotencyKey,
      operationFingerprint: `fingerprint-${idempotencyKey}`,
    });
    for (const key of ["one", "two", "three"]) {
      const result = registry.claimDirectMutation(issued.token, claim(key));
      expect(result).toMatchObject({ ok: true, status: "claimed" });
      expect(registry.completeDirectMutation(issued.token, {
        ...claim(key),
        sessionId: issued.sessionId,
      }, `result-${key}`, artifactBinding.documentVersion)).toBe(true);
    }
    expect(registry.claimDirectMutation(issued.token, claim("one"))).toMatchObject({
      ok: true,
      status: "claimed",
    });
    expect(registry.abortDirectMutation(issued.token, {
      ...claim("one"),
      sessionId: issued.sessionId,
    })).toBe(true);
    const oversized = claim("oversized");
    expect(registry.claimDirectMutation(issued.token, oversized)).toMatchObject({
      ok: true,
      status: "claimed",
    });
    expect(registry.completeDirectMutation(issued.token, {
      ...oversized,
      sessionId: issued.sessionId,
    }, "x".repeat(64 * 1024 + 1), artifactBinding.documentVersion)).toBe(false);
    expect(registry.abortDirectMutation(issued.token, {
      ...oversized,
      sessionId: issued.sessionId,
    })).toBe(true);
    expect(registry.claimDirectMutation(issued.token, oversized)).toMatchObject({
      ok: true,
      status: "claimed",
    });

    now = 151;
    expect(registry.claimDirectMutation(issued.token, claim("three"))).toEqual({
      ok: false,
      code: "session_closed",
    });
    const replacement = registry.issue(artifactBinding);
    expect(registry.claimDirectMutation(replacement.token, claim("three"))).toMatchObject({
      ok: true,
      status: "claimed",
    });
    expect(registry.revokeForSubject(replacement.token, artifactBinding)).toBe(true);
    expect(registry.claimDirectMutation(replacement.token, claim("three"))).toEqual({
      ok: false,
      code: "session_closed",
    });
  });

  test("refuses unbounded concurrent claims when every ledger slot is pending", () => {
    const registry = new LiveMiniAppSessionRegistry(Date.now, 50_000, 1);
    const issued = registry.issue(artifactBinding);
    const claim = (idempotencyKey: string) => ({
      appId: artifactBinding.appId,
      userId: artifactBinding.userId,
      documentVersion: artifactBinding.documentVersion,
      idempotencyKey,
      operationFingerprint: `fingerprint-${idempotencyKey}`,
    });
    expect(registry.claimDirectMutation(issued.token, claim("pending"))).toMatchObject({
      ok: true,
      status: "claimed",
    });
    expect(registry.claimDirectMutation(issued.token, claim("second"))).toEqual({
      ok: false,
      code: "idempotency_ledger_full",
    });
  });

  test("finds only a currently open session for the exact artifact target", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 10);
    const token = registry.issue(artifactBinding).token;

    expect(
      registry.hasOpenSessionForArtifact({
        appId: artifactBinding.appId,
        userId: artifactBinding.userId,
        artifactId: artifactBinding.artifactId,
      }),
    ).toBe(true);
    expect(
      registry.hasOpenSessionForTarget({
        targetKind: "artifact",
        appId: artifactBinding.appId,
        userId: artifactBinding.userId,
        artifactId: artifactBinding.artifactId,
      }),
    ).toBe(true);
    expect(
      registry.hasOpenSessionForArtifact({
        appId: artifactBinding.appId,
        userId: "other-user",
        artifactId: artifactBinding.artifactId,
      }),
    ).toBe(false);

    expect(registry.revokeForSubject(token, artifactBinding)).toBe(true);
    expect(
      registry.hasOpenSessionForArtifact({
        appId: artifactBinding.appId,
        userId: artifactBinding.userId,
        artifactId: artifactBinding.artifactId,
      }),
    ).toBe(false);

    registry.issue(artifactBinding);
    now += 10;
    expect(
      registry.hasOpenSessionForArtifact({
        appId: artifactBinding.appId,
        userId: artifactBinding.userId,
        artifactId: artifactBinding.artifactId,
      }),
    ).toBe(false);
  });
});

describe("LiveMiniAppSessionRegistry currentFile sessions", () => {
  test("issues, validates, refreshes, and queries local SHA sessions", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 50);
    const { token, sessionId } = registry.issue(currentFileBinding);

    expect(registry.validate(token, currentFileBinding)).toEqual({
      ok: true,
      binding: currentFileBinding,
      sessionId,
      expiresAt: 150,
    });
    expect(
      registry.hasOpenSessionForLocalTarget({
        appId: currentFileBinding.appId,
        userId: currentFileBinding.userId,
        localTargetId: currentFileBinding.localTargetId,
      }),
    ).toBe(true);

    now = 120;
    expect(
      registry.refresh(token, { kind: "local_sha", sha256: LOCAL_SHA_B }, currentFileBinding),
    ).toEqual({
      ok: true,
      binding: {
        ...currentFileBinding,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA_B },
      },
      sessionId,
      expiresAt: 170,
    });
    expect(registry.validate(token, currentFileBinding)).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: { kind: "local_sha", sha256: LOCAL_SHA_B },
    });
  });

  test("rejects stale SHA and version kind mismatch", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(currentFileBinding);

    expect(
      registry.validate(token, {
        ...currentFileBinding,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA_B },
      }),
    ).toEqual({
      ok: false,
      code: "stale_version",
      currentDocumentVersion: currentFileBinding.documentVersion,
    });
    expect(
      registry.validate(token, {
        ...currentFileBinding,
        documentVersion: { kind: "artifact_revision", revision: 3 },
      } as never),
    ).toEqual({ ok: false, code: "session_closed" });
    expect(
      registry.refresh(token, { kind: "artifact_revision", revision: 3 }, currentFileBinding),
    ).toEqual({ ok: false, code: "session_closed" });
  });

  test("revokeForRelay closes only matching local sessions", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const local = registry.issue(currentFileBinding);
    const artifact = registry.issue(artifactBinding);
    const otherRelay = registry.issue({
      ...currentFileBinding,
      localTargetId: "local-target-2",
      relayId: "relay-2",
    });

    expect(registry.revokeForRelay("other-user", currentFileBinding.relayId)).toEqual([]);
    expect(registry.revokeForRelay(currentFileBinding.userId, currentFileBinding.relayId)).toEqual([
      local.sessionId,
    ]);
    expect(registry.validate(local.token, currentFileBinding)).toEqual({
      ok: false,
      code: "session_closed",
    });
    expect(registry.validate(artifact.token, artifactBinding).ok).toBe(true);
    expect(
      registry.validate(otherRelay.token, {
        targetKind: "currentFile",
        appId: currentFileBinding.appId,
        userId: currentFileBinding.userId,
        localTargetId: "local-target-2",
        documentVersion: currentFileBinding.documentVersion,
      }).ok,
    ).toBe(true);
  });
});

describe("live review proposal records", () => {
  test("notifies composition of expiry before discarding the exact session", () => {
    let now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 50);
    const issued = registry.issue(artifactBinding);
    const observed: string[] = [];
    registry.setExpiryObserver((sessionId) => observed.push(sessionId));

    now = 151;
    // Any ordinary registry use may reap expiry; the observer is the sole
    // composition seam that can terminalize a Task before lineage is removed.
    registry.expire();

    expect(observed).toEqual([issued.sessionId]);
    expect(registry.validateOpenForSubject(issued.token, {
      appId: artifactBinding.appId,
      userId: artifactBinding.userId,
    })).toEqual({ ok: false, code: "session_closed" });
  });

  test("registers, looks up, caches acceptance, and expires with the session", () => {
    const now = 100;
    const registry = new LiveMiniAppSessionRegistry(() => now, 50);
    const issued = registry.issue(artifactBinding);
    const operations = [{ kind: "replace", blockId: "block-1", scope: { kind: "block" }, text: "next" }];
    const metadata = [{ operationIndex: 0, kind: "replace", blockId: "block-1" }];
    const deliveryOperations = [{ kind: "replace", blockId: "block-1", scope: { kind: "range", start: 0, end: 1 }, text: "next" }];

    const registered = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
      agentId: "agent-1",
      turnId: "turn-1",
      operations,
      deliveryOperations,
      operationMetadata: metadata,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.proposalId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const lookup = registry.lookupProposal({
      sessionId: issued.sessionId,
      proposalId: registered.proposalId,
      documentVersion: artifactBinding.documentVersion,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.record.turnId).toBe("turn-1");
    expect(lookup.record.operations).toEqual(operations);
    expect(lookup.record.operations).not.toBe(operations);
    expect(lookup.record.deliveryOperations).toEqual(deliveryOperations);
    expect(lookup.record.operationMetadata).toEqual(metadata);
    const listed = registry.listProposalsForSession({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      proposalId: registered.proposalId,
      operations,
      deliveryOperations,
    });
    expect(registry.listProposalsForSession({
      sessionId: issued.sessionId,
      documentVersion: { kind: "artifact_revision", revision: 99 },
    })).toEqual([]);

    const acceptance = {
      requestId: "req-1",
      acceptedContentSha256: LOCAL_SHA,
      acceptedOperationIndexes: [0] as const,
      result: {
        documentVersion: { kind: "local_sha" as const, sha256: LOCAL_SHA_B },
        contentSha256: LOCAL_SHA_B,
        localRevisionRef: "local:relay-1:abc",
      },
    };
    expect(
      registry.recordProposalAcceptance(
        {
          sessionId: issued.sessionId,
          proposalId: registered.proposalId,
          documentVersion: artifactBinding.documentVersion,
        },
        acceptance,
      ).ok,
    ).toBe(true);
    expect(
      registry.recordProposalAcceptance(
        {
          sessionId: issued.sessionId,
          proposalId: registered.proposalId,
          documentVersion: artifactBinding.documentVersion,
        },
        acceptance,
      ).ok,
    ).toBe(true);
    expect(
      registry.recordProposalAcceptance(
        {
          sessionId: issued.sessionId,
          proposalId: registered.proposalId,
          documentVersion: artifactBinding.documentVersion,
        },
        { ...acceptance, requestId: "req-2" },
      ),
    ).toEqual({ ok: false, code: "acceptance_conflict" });

    registry.revokeForSubject(issued.token, {
      appId: artifactBinding.appId,
      userId: artifactBinding.userId,
    });
    expect(
      registry.lookupProposal({
        sessionId: issued.sessionId,
        proposalId: registered.proposalId,
        documentVersion: artifactBinding.documentVersion,
      }),
    ).toEqual({ ok: false, code: "proposal_not_found" });
  });

  test("replays one unresolved same-session review across a binding refresh until it closes", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(artifactBinding);
    const oldProposal = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
      agentId: "agent-old",
      turnId: "turn-old",
      operations: [{ kind: "replace", text: "old" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(oldProposal.ok).toBe(true);
    if (!oldProposal.ok) return;

    const currentVersion = { kind: "artifact_revision" as const, revision: 4 };
    expect(registry.refresh(issued.token, currentVersion, artifactBinding).ok).toBe(true);
    expect(registry.listProposalsForSession({
      sessionId: issued.sessionId,
      documentVersion: currentVersion,
    }).map((proposal) => proposal.proposalId)).toEqual([oldProposal.proposalId]);
    // A caller cannot use the reconciliation API as historical lookup.
    expect(registry.listProposalsForSession({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
    })).toEqual([]);

    expect(registry.completeProposalReview({
      sessionId: issued.sessionId,
      proposalId: oldProposal.proposalId,
      outcome: "rejected",
    }).ok).toBe(true);
    expect(registry.listProposalsForSession({
      sessionId: issued.sessionId,
      documentVersion: currentVersion,
    })).toEqual([]);

    const nextProposal = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: currentVersion,
      agentId: "agent-new",
      turnId: "turn-new",
      operations: [{ kind: "replace", text: "new" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(nextProposal.ok).toBe(true);
    if (!nextProposal.ok) return;
    expect(registry.completeProposalReview({
      sessionId: issued.sessionId,
      proposalId: nextProposal.proposalId,
      outcome: "rejected",
    }).ok).toBe(true);
    expect(registry.listProposalsForSession({
      sessionId: issued.sessionId,
      documentVersion: currentVersion,
    })).toEqual([]);
  });

  test("rejects registration without a turnId and stale document versions", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(currentFileBinding);
    expect(
      registry.registerProposal({
        sessionId: issued.sessionId,
        documentVersion: currentFileBinding.documentVersion,
        agentId: "agent-1",
        turnId: "",
        operations: [],
        operationMetadata: [],
      }),
    ).toEqual({ ok: false, code: "missing_turn_id" });
    expect(
      registry.registerProposal({
        sessionId: issued.sessionId,
        documentVersion: currentFileBinding.documentVersion,
        agentId: "",
        turnId: "turn-1",
        operations: [],
        operationMetadata: [],
      }),
    ).toEqual({ ok: false, code: "missing_turn_id" });
    expect(
      registry.registerProposal({
        sessionId: issued.sessionId,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA_B },
        agentId: "agent-1",
        turnId: "turn-1",
        operations: [],
        operationMetadata: [],
      }),
    ).toEqual({ ok: false, code: "stale_version" });
  });

  test("allows exactly one unresolved visible review owner per live session", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(artifactBinding);
    const first = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
      agentId: "agent-1",
      turnId: "turn-1",
      operations: [{ kind: "replace" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(first.ok).toBe(true);
    expect(registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
      agentId: "agent-2",
      turnId: "turn-2",
      operations: [{ kind: "replace" }],
      operationMetadata: [{ operationIndex: 0 }],
    })).toEqual({ ok: false, code: "session_closed", reason: "review_owner_busy" });
    if (!first.ok) return;
    expect(registry.completeProposalReview({
      sessionId: issued.sessionId,
      proposalId: first.proposalId,
      outcome: "rejected",
    })).toMatchObject({ ok: true });
    expect(registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
      agentId: "agent-3",
      turnId: "turn-3",
      operations: [{ kind: "replace" }],
      operationMetadata: [{ operationIndex: 0 }],
    }).ok).toBe(true);
  });

  test("acceptance resolution requires the exact canonical proposal save receipt", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(artifactBinding);
    const registered = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: artifactBinding.documentVersion,
      agentId: "agent-1",
      turnId: "turn-1",
      operations: [{ kind: "replace" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const resolution = {
      sessionId: issued.sessionId,
      proposalId: registered.proposalId,
      documentVersion: artifactBinding.documentVersion,
      outcome: "accepted" as const,
      resultDocumentVersion: { kind: "artifact_revision" as const, revision: 4 },
    };
    expect(registry.validateProposalReviewResolution(resolution))
      .toEqual({ ok: false, code: "stale_version" });
    expect(registry.refresh(
      issued.token,
      resolution.resultDocumentVersion,
      artifactBinding,
    ).ok).toBe(true);
    expect(registry.validateProposalReviewResolution(resolution))
      .toEqual({ ok: false, code: "stale_version" });
    const receiptRegistry = new LiveMiniAppSessionRegistry();
    const receiptSession = receiptRegistry.issue(artifactBinding);
    const receiptProposal = receiptRegistry.registerProposal({
      sessionId: receiptSession.sessionId,
      documentVersion: artifactBinding.documentVersion,
      agentId: "agent-receipt",
      turnId: "turn-receipt",
      operations: [{ kind: "replace" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    if (!receiptProposal.ok) throw new Error(receiptProposal.code);
    expect(receiptRegistry.commitArtifactAcceptance(
      receiptSession.token,
      {
        sessionId: receiptSession.sessionId,
        proposalId: receiptProposal.proposalId,
        documentVersion: artifactBinding.documentVersion,
      },
      {
        requestId: "request-1",
        acceptedContentSha256: LOCAL_SHA,
        acceptedOperationIndexes: [0],
        result: {
          documentVersion: resolution.resultDocumentVersion,
          contentSha256: LOCAL_SHA_B,
        },
      },
    ).ok).toBe(true);
    expect(receiptRegistry.validateProposalReviewResolution({
      ...resolution,
      sessionId: receiptSession.sessionId,
      proposalId: receiptProposal.proposalId,
    })).toMatchObject({
      ok: true,
      record: { proposalId: receiptProposal.proposalId, turnId: "turn-receipt" },
    });
  });

  test("rejection resolution requires an unchanged unaccepted proposal", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(currentFileBinding);
    const registered = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: currentFileBinding.documentVersion,
      agentId: "agent-1",
      turnId: "turn-1",
      operations: [{ kind: "replace" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registry.validateProposalReviewResolution({
      sessionId: issued.sessionId,
      proposalId: registered.proposalId,
      documentVersion: currentFileBinding.documentVersion,
      outcome: "rejected",
    })).toMatchObject({ ok: true });
    registry.refresh(issued.token, { kind: "local_sha", sha256: LOCAL_SHA_B }, currentFileBinding);
    expect(registry.validateProposalReviewResolution({
      sessionId: issued.sessionId,
      proposalId: registered.proposalId,
      documentVersion: currentFileBinding.documentVersion,
      outcome: "rejected",
    })).toEqual({ ok: false, code: "proposal_closed" });
  });
});

describe("live review locator handles", () => {
  test("binds an opaque payload to session and documentVersion for artifact sessions", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(artifactBinding);
    const payload = { opaque: "extension-owned" };
    const handle = registry.issueLocator(
      issued.sessionId,
      artifactBinding.documentVersion,
      payload,
    );
    expect(
      registry.validateLocator(handle, {
        sessionId: issued.sessionId,
        documentVersion: artifactBinding.documentVersion,
      }),
    ).toEqual({ ok: true, payload });
    expect(
      registry.validateLocator(handle, {
        sessionId: "different-session",
        documentVersion: artifactBinding.documentVersion,
      }),
    ).toEqual({ ok: false, code: "session_closed" });
    expect(
      registry.validateLocator(handle, {
        sessionId: issued.sessionId,
        documentVersion: { kind: "artifact_revision", revision: 4 },
      }),
    ).toEqual({ ok: false, code: "stale_version" });
  });

  test("binds locators to local SHA sessions", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(currentFileBinding);
    const handle = registry.issueLocator(
      issued.sessionId,
      currentFileBinding.documentVersion,
      { opaque: "local-owned" },
    );
    expect(
      registry.validateLocator(handle, {
        sessionId: issued.sessionId,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA_B },
      }),
    ).toEqual({ ok: false, code: "stale_version" });
  });

  test("invalidates locator when its session closes", () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(artifactBinding);
    const handle = registry.issueLocator(
      issued.sessionId,
      artifactBinding.documentVersion,
      { opaque: "extension-owned" },
    );
    registry.revokeForSubject(issued.token, {
      appId: artifactBinding.appId,
      userId: artifactBinding.userId,
    });
    expect(
      registry.validateLocator(handle, {
        sessionId: issued.sessionId,
        documentVersion: artifactBinding.documentVersion,
      }),
    ).toEqual({ ok: false, code: "session_closed" });
  });
});
