import { describe, expect, test } from "bun:test";

import { loadForegroundAuthoredContext } from
  "../../src/executors/foreground-authored-context";
import { createHmacProfileSoulFingerprint, foregroundMemoryBriefExposure } from
  "../../src/executors/foreground-authored-context";
import { createHmacOrdinarySourceFingerprintPort } from "../../src/reflection/canonical-room-sources";

function dependencies() {
  const calls = { config: 0, skills: 0 };
  return {
    calls,
    deps: {
      getExecutionConfigByAgentId: async () => {
        calls.config += 1;
        return { profileId: "profile-1", userId: "profile-owner", agentId: "agent-1",
          name: "Genie", defaultModel: "model", soulFile: "secret soul", soulRevision: 7 };
      },
      fingerprintProfileSoul: createHmacProfileSoulFingerprint(new Uint8Array(32).fill(7)),
      resolveEnabledBodies: async () => {
        calls.skills += 1;
        return [{
          id: "skill-1",
          name: "authored",
          description: "description",
          body: "secret skill body",
          requiresTools: [],
        }];
      },
    },
  };
}

describe("foreground authored context", () => {
  test("receipts exact selected Memory brief rows with current revision and readable leaf", () => {
    const fingerprint = createHmacOrdinarySourceFingerprintPort(new Uint8Array(32).fill(9)).memory;
    const row = { id: "memory-one", type: "preference", content: "Precise evidence",
      importance: 1, tier: 1 as const, createdAt: new Date(0), contentRevision: 2, namespaceId: "namespace-one" };
    const receipt = foregroundMemoryBriefExposure([row], fingerprint);
    expect(receipt.content).toBe("- [preference] Precise evidence");
    expect(receipt.exposure).toEqual({ status: "complete", dependencies: [{
      kind: "source", sourceKind: "memory", logicalSourceRef: "memory:memory-one", observedRevision: "2",
      observedContentFingerprint: fingerprint(row), terminalAuthorityLeafHandle: "namespace-one",
    }] });
    expect(foregroundMemoryBriefExposure([{ ...row, contentRevision: 3 }], fingerprint).exposure)
      .not.toEqual(receipt.exposure);
    expect(foregroundMemoryBriefExposure([{ ...row, content: "Changed" }], fingerprint).exposure)
      .not.toEqual(receipt.exposure);
    const { namespaceId: _namespace, ...unbound } = row;
    expect(foregroundMemoryBriefExposure([unbound], fingerprint).exposure).toEqual({ status: "incomplete" });
    expect(foregroundMemoryBriefExposure([row], undefined).exposure).toEqual({ status: "incomplete" });
    expect(foregroundMemoryBriefExposure([], undefined).exposure).toEqual({ status: "complete", dependencies: [] });
  });
  test("Full loads the existing authored Soul and Skill context", async () => {
    const { calls, deps } = dependencies();
    expect(await loadForegroundAuthoredContext({
      agentId: "agent-1",
      ownerId: "owner-1",
      isGuest: false,
      namespaceId: "namespace-1",
    }, deps)).toMatchObject({
      profile: { name: "Genie", defaultModel: "model", soulFile: "secret soul", userId: "profile-owner" },
      soulFile: "secret soul",
      soulSourceReceipt: {
        sourceKind: "profile_soul",
        logicalSourceRef: "agent-soul:agent-1",
        observedRevision: "7",
        terminalAuthorityLeafHandle: "namespace-1",
        userId: "profile-owner",
      },
      modelInputDependencies: [{ sourceKind: "profile_soul", logicalSourceRef: "agent-soul:agent-1" }],
      skills: [expect.objectContaining({ body: "secret skill body" })],
    });
    expect(calls).toEqual({ config: 1, skills: 1 });
  });

  test("Shadow preserves ordinary Profile and Skill loading", async () => {
    const { calls, deps } = dependencies();
    expect(await loadForegroundAuthoredContext({
      agentId: "agent-1",
      ownerId: "owner-1",
      isGuest: false,
    }, deps)).toMatchObject({
      soulFile: "secret soul",
      skills: [{ body: "secret skill body" }],
    });
    expect(calls).toEqual({ config: 1, skills: 1 });
  });

  test("guest behavior remains empty without invoking loaders", async () => {
    const { calls, deps } = dependencies();
    expect(await loadForegroundAuthoredContext({
      agentId: "agent-1",
      ownerId: "owner-1",
      isGuest: true,
    }, deps)).toMatchObject({ soulFile: "", soulSourceReceipt: null, modelInputDependencies: [], skills: [] });
    expect(calls).toEqual({ config: 0, skills: 0 });
  });

  test("Soul receipts require the canonical Agent and a trusted Room namespace", async () => {
    const { deps } = dependencies();
    const withoutNamespace = await loadForegroundAuthoredContext({
      agentId: "agent-1", ownerId: "room-owner", isGuest: false,
    }, deps);
    expect(withoutNamespace.soulFile).toBe("secret soul");
    expect(withoutNamespace.soulSourceReceipt).toBeNull();
    expect(withoutNamespace.modelInputDependencies).toEqual([]);

    const mismatch = await loadForegroundAuthoredContext({
      agentId: "other-agent", ownerId: "room-owner", isGuest: false, namespaceId: "namespace-1",
    }, deps);
    expect(mismatch.soulSourceReceipt).toBeNull();
  });

  test("Soul fingerprint commits exact revision and content", () => {
    const fingerprint = createHmacProfileSoulFingerprint(new Uint8Array(32).fill(9));
    const source = {
      agentId: "agent-1", profileId: "profile-1", userId: "profile-owner",
      soulRevision: 2, soulFile: "same soul",
    };
    const original = fingerprint(source);
    expect(original).toStartWith("hmac-sha256:");
    expect(fingerprint({ ...source, soulRevision: 3 })).not.toBe(original);
    expect(fingerprint({ ...source, soulFile: "changed soul" })).not.toBe(original);
  });
});
