import { afterAll, describe, expect, test } from "bun:test";

import {
  closeVisibilityGrantFixtureConnections,
  createVisibilityGrantCurrentAuthority,
  createVisibilityGrantFixture,
  destroyVisibilityGrant,
  destroyVisibilityGrantFixture,
  inspectVisibilityGrantDomains,
  makeVisibilitySourcePublic,
  mintReusableVisibilityGrant,
  openVisibilityGrant,
  openVisibilityGrantAgainstCurrent,
  planWithReusableVisibilityGrant,
  readVisibilitySourceRoom,
} from "../fixtures/public-room-grant-visibility.ts";

afterAll(closeVisibilityGrantFixtureConnections);

describe("public Room foreground Grant visibility revalidation", () => {
  test("rejects a reusable Grant after visibility changes its exact readable Namespace set", async () => {
    const fixture = await createVisibilityGrantFixture();
    let oldGrant: Awaited<ReturnType<typeof mintReusableVisibilityGrant>> | null = null;
    let freshGrant: Awaited<ReturnType<typeof mintReusableVisibilityGrant>> | null = null;
    let oldCurrent: Awaited<ReturnType<
      typeof createVisibilityGrantCurrentAuthority
    >> = null;
    let freshCurrent: Awaited<ReturnType<
      typeof createVisibilityGrantCurrentAuthority
    >> = null;
    try {
      let readableNamespaceIds: readonly string[] = [
        fixture.namespaceId,
        fixture.targetNamespaceId,
      ];
      const beforeRoom = await readVisibilitySourceRoom(fixture);
      expect(beforeRoom.kind).toBe("group");

      const oldDomains = await inspectVisibilityGrantDomains(
        fixture,
        readableNamespaceIds,
      );
      expect(oldDomains).toHaveLength(1);
      expect(oldDomains[0]?.activeNamespaceBindingCount).toBe(2);
      oldGrant = await mintReusableVisibilityGrant(fixture, oldDomains, "before");
      const oldTurn = await planWithReusableVisibilityGrant(
        fixture,
        readableNamespaceIds,
        oldGrant,
        "before",
      );
      oldCurrent = await createVisibilityGrantCurrentAuthority(
        fixture,
        oldTurn,
        () => readableNamespaceIds,
      );
      expect(oldCurrent).not.toBeNull();
      if (oldCurrent === null) throw new Error("Current authority missing");
      expect(await oldCurrent.verifyCurrentPlan()).toBe(true);
      const oldGrantCurrent = await oldCurrent
        .resolveCurrentForegroundAuthorization();
      expect(oldGrantCurrent).not.toBeNull();
      if (oldGrantCurrent === null) throw new Error("Grant authority missing");
      expect(await openVisibilityGrant(fixture, oldCurrent, oldGrant))
        .toMatchObject({
          status: "opened",
          value: [{ domainId: fixture.domainId, participantCount: 2 }],
        });

      await makeVisibilitySourcePublic(fixture);
      readableNamespaceIds = [fixture.namespaceId];
      expect(await readVisibilitySourceRoom(fixture)).toEqual({
        ...beforeRoom,
        kind: "open",
      });
      expect(await fixture.namespaceProduct.withCurrentReadableNamespaceSet({
        subjectUserId: fixture.userId,
        subjectHumanId: fixture.humanId,
        sourceRoomId: fixture.roomId,
        namespaceIds: [fixture.namespaceId, fixture.targetNamespaceId],
        use: async () => "stale-set-authorized",
      })).toBeNull();
      expect(await oldCurrent.verifyCurrentPlan()).toBe(false);
      expect(await oldCurrent.resolveCurrentForegroundAuthorization()).toBeNull();

      const freshDomains = await inspectVisibilityGrantDomains(
        fixture,
        readableNamespaceIds,
      );
      expect(freshDomains).toHaveLength(1);
      expect(freshDomains[0]?.activeNamespaceBindingCount).toBe(1);
      expect({
        domainId: freshDomains[0]!.domainId,
        sourceNamespaceId: freshDomains[0]!.sourceNamespaceId,
        participantDigest: freshDomains[0]!.participantDigest,
        participantCount: freshDomains[0]!.participantCount,
        keyClass: freshDomains[0]!.keyClass,
        domainKeyGeneration: freshDomains[0]!.domainKeyGeneration,
        authorizationRevision: freshDomains[0]!.authorizationRevision,
        headDigest: freshDomains[0]!.headDigest,
      }).toEqual({
        domainId: oldDomains[0]!.domainId,
        sourceNamespaceId: oldDomains[0]!.sourceNamespaceId,
        participantDigest: oldDomains[0]!.participantDigest,
        participantCount: oldDomains[0]!.participantCount,
        keyClass: oldDomains[0]!.keyClass,
        domainKeyGeneration: oldDomains[0]!.domainKeyGeneration,
        authorizationRevision: oldDomains[0]!.authorizationRevision,
        headDigest: oldDomains[0]!.headDigest,
      });
      expect(freshDomains[0]!.activeNamespaceBindingSetDigest).not.toEqual(
        oldDomains[0]!.activeNamespaceBindingSetDigest,
      );
      expect(await openVisibilityGrantAgainstCurrent(
        fixture,
        Object.freeze({ ...oldGrantCurrent, domains: freshDomains }),
        oldGrant,
      )).toEqual({ status: "unavailable", reason: "authority_stale" });

      freshGrant = await mintReusableVisibilityGrant(
        fixture,
        freshDomains,
        "after",
      );
      const freshTurn = await planWithReusableVisibilityGrant(
        fixture,
        readableNamespaceIds,
        freshGrant,
        "after",
      );
      freshCurrent = await createVisibilityGrantCurrentAuthority(
        fixture,
        freshTurn,
        () => readableNamespaceIds,
      );
      expect(freshCurrent).not.toBeNull();
      if (freshCurrent === null) throw new Error("Fresh authority missing");
      expect(await freshCurrent.verifyCurrentPlan()).toBe(true);
      expect(await openVisibilityGrant(fixture, freshCurrent, freshGrant))
        .toMatchObject({
          status: "opened",
          value: [{ domainId: fixture.domainId, participantCount: 2 }],
        });
    } finally {
      oldCurrent?.destroy();
      freshCurrent?.destroy();
      if (oldGrant !== null) destroyVisibilityGrant(oldGrant);
      if (freshGrant !== null) destroyVisibilityGrant(freshGrant);
      await destroyVisibilityGrantFixture(fixture);
    }
  });
});
