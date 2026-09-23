import { describe, expect, test } from "bun:test";
import { authorizationRevision } from "@nautilo/lattice-crypto";

import {
  createDomainCompressedLiveShadowSessionCapability,
  destroyDomainCompressedLiveShadowSessionCapability,
  inspectDomainCompressedLiveShadowSessionCapability,
  inspectTaskRuntimeDomainCompressedLiveShadowSessionCapability,
  withDomainCompressedLiveShadowSessionCapabilityEntries,
} from "../../src/server/message/domain-compressed-live-shadow-session-capability.ts";

const description = Object.freeze({
  authorizationId: "authorization-1",
  subjectHumanId: "human-1",
  issuingDeviceId: "device-1",
  recipientAgentId: "agent-1",
  recipientKeyId: "recipient-key-1",
  sessionId: "session-1",
  roomId: "room-1",
  policyRevision: 1,
  hostAuthorizationRevision: 1,
  agentAuthorizationRevision: 1,
  agentRuntimeGeneration: 1,
  namespaceIds: Object.freeze(["namespace-1", "namespace-2"]),
  grantDomainIds: Object.freeze(["domain-1", "domain-2"]),
  issuedAt: 1_000,
  expiresAt: 301_000,
  authorizationDigest: new Uint8Array(32).fill(7),
});

const entries = Object.freeze(["domain-1", "domain-2"].map((grantDomainId) =>
  Object.freeze({
    grantDomainId,
    participantDigest: new Uint8Array(32).fill(1),
    domainKeyGeneration: 1,
    headDigest: new Uint8Array(32).fill(2),
    publicationDigest: new Uint8Array(32).fill(3),
    publicationAuthorizationRevision: authorizationRevision(1),
    authorizationRevision: authorizationRevision(1),
    activeNamespaceBindingSetDigest: new Uint8Array(32).fill(4),
    activeNamespaceBindingCount: 1,
    domainAiGrantKey: new Uint8Array(32).fill(5),
  })
));

describe("Domain-compressed live Shadow session capability", () => {
  test("keeps foreground Runtime identity independent of the selected Agent", () => {
    const capability = createDomainCompressedLiveShadowSessionCapability({
      description: {
        authorizationId: "runtime-authorization",
        subjectHumanId: "human-1",
        issuingDeviceId: "device-1",
        recipientKind: "nautilo_foreground_runtime",
        browserSessionId: "browser-session-1",
        topLevelRoomId: "room-1",
        recipientKeyId: "runtime-key-1",
        policyRevision: 1,
        hostAuthorizationRevision: 1,
        namespaceIds: description.namespaceIds,
        grantDomainIds: description.grantDomainIds,
        issuedAt: 1_000,
        expiresAt: 301_000,
        authorizationDigest: new Uint8Array(32).fill(7),
      },
      entries,
    });
    const inspected = inspectDomainCompressedLiveShadowSessionCapability(
      capability,
    );

    expect(inspected).toMatchObject({
      recipientKind: "nautilo_foreground_runtime",
      browserSessionId: "browser-session-1",
      topLevelRoomId: "room-1",
    });
    expect(inspected === null ? true : "recipientAgentId" in inspected)
      .toBeFalse();
    expect(inspected === null ? true : "agentAuthorizationRevision" in inspected)
      .toBeFalse();
    expect(inspected === null ? true : "agentRuntimeGeneration" in inspected)
      .toBeFalse();

    destroyDomainCompressedLiveShadowSessionCapability(capability);
  });

  test("retains an exact Task Runtime authorization episode binding", () => {
    const capability = createDomainCompressedLiveShadowSessionCapability({
      description: {
        authorizationId: "task-authorization",
        subjectHumanId: "human-1",
        issuingDeviceId: "device-1",
        recipientKind: "nautilo_task_runtime",
        taskRunId: "task-run-1",
        authorizationEpisodeId: "task-episode-1",
        sourceRoomId: "room-source-1",
        recipientKeyId: "task-runtime-key-1",
        policyRevision: 1,
        hostAuthorizationRevision: 1,
        namespaceIds: description.namespaceIds,
        grantDomainIds: description.grantDomainIds,
        issuedAt: 1_000,
        expiresAt: 301_000,
        authorizationDigest: new Uint8Array(32).fill(8),
      },
      entries,
    });

    expect(inspectDomainCompressedLiveShadowSessionCapability(capability))
      .toBeNull();
    expect(inspectTaskRuntimeDomainCompressedLiveShadowSessionCapability(capability))
      .toMatchObject({
        recipientKind: "nautilo_task_runtime",
        taskRunId: "task-run-1",
        authorizationEpisodeId: "task-episode-1",
        sourceRoomId: "room-source-1",
        subjectHumanId: "human-1",
        issuingDeviceId: "device-1",
      });

    destroyDomainCompressedLiveShadowSessionCapability(capability);
  });

  test("lends detached key copies and wipes retained authority on destroy", async () => {
    const capability = createDomainCompressedLiveShadowSessionCapability({
      description,
      entries,
    });
    const inspected = inspectDomainCompressedLiveShadowSessionCapability(
      capability,
    );
    expect(inspected?.authorizationId).toBe("authorization-1");
    expect(inspected?.authorizationDigest).toEqual(description.authorizationDigest);

    const borrowed = await withDomainCompressedLiveShadowSessionCapabilityEntries(
      capability,
      (opened) => {
        opened[0]!.domainAiGrantKey[0] = 99;
        return opened[0]!.domainAiGrantKey;
      },
    );
    expect(Array.from(borrowed ?? new Uint8Array(0))).toEqual(
      Array.from({ length: 32 }, () => 0),
    );

    const second = await withDomainCompressedLiveShadowSessionCapabilityEntries(
      capability,
      (opened) => opened[0]!.domainAiGrantKey[0],
    );
    expect(second).toBe(5);

    destroyDomainCompressedLiveShadowSessionCapability(capability);
    expect(inspectDomainCompressedLiveShadowSessionCapability(capability))
      .toBeNull();
  });

  test("rejects an authority inventory that is incomplete or reordered", () => {
    expect(() => createDomainCompressedLiveShadowSessionCapability({
      description,
      entries: entries.slice(0, 1),
    })).toThrow();
    expect(() => createDomainCompressedLiveShadowSessionCapability({
      description,
      entries: [...entries].reverse(),
    })).toThrow();
  });
});
