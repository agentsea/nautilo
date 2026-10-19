import { randomUUID } from "node:crypto";

import { expect, test } from "bun:test";
import {
  actors,
  agents,
  capabilities,
  createDirectDb,
  encryptionTransitionPolicy,
  eq,
  groupMembers,
  groupRoles,
  groups,
  inArray,
  namespaces,
  roleCapabilities,
  roles,
  roomMembers,
  rooms,
  serverAdmission,
  users,
} from "@nautilo/db";
import { assertFixtureDbMutationAllowed } from "@nautilo/db/testing";
import { createHumanTerminalAdmissionPort } from "../../../runtime/src/conversation/human-terminal-admission";
import { createTaskLocalExecutionCaptureAdmission } from "../../src/local-execution-task-capture";

const ROLLBACK = new Error("transaction-bound capture fixture rollback");

test("local capture completes through a held transaction when its pool is saturated", async () => {
  assertFixtureDbMutationAllowed();
  const database = createDirectDb(1);
  let completed = false;
  try {
    await database.transaction(async transaction => {
      const suffix = randomUUID();
      const humanUserId = randomUUID();
      const humanActorId = randomUUID();
      const agentId = randomUUID();
      const agentActorId = randomUUID();
      const roomId = randomUUID();
      const namespaceId = randomUUID();
      const graphThreadId = `room:${roomId}`;
      await transaction.insert(users).values({ id: humanUserId, name: "Transaction capture Human" });
      await transaction.insert(serverAdmission).values({ userId: humanUserId, admitted: true });
      await transaction.insert(agents).values({ id: agentId, handle: `transaction-capture-${suffix}` });
      await transaction.insert(actors).values([
        { id: humanActorId, ownerId: humanUserId, displayName: "Transaction capture Human", kind: "user" },
        { id: agentActorId, ownerId: humanUserId, displayName: "Transaction capture Genie", kind: "agent", agentId },
      ]);
      await transaction.insert(namespaces).values({ id: namespaceId, scope: "room", label: "Transaction capture" });
      await transaction.insert(rooms).values({ id: roomId, ownerId: humanUserId, type: "private", kind: "private",
        label: "Transaction capture", graphThreadId, namespaceId, humanActorIds: [humanActorId], createdBy: humanActorId });
      await transaction.insert(roomMembers).values([
        { roomId, actorId: humanActorId, roomRole: "admin" },
        { roomId, actorId: agentActorId, roomRole: "member", agentResponseMode: "active" },
      ]);
      const grants = await transaction.select({ id: capabilities.id, slug: capabilities.slug }).from(capabilities)
        .where(inArray(capabilities.slug, ["invoke_agents", "use_workstation"]));
      if (grants.length !== 2) throw new Error("Disposable clone lacks canonical capture capabilities");
      const [role] = await transaction.insert(roles).values({ slug: `transaction-capture-${suffix}`, label: "Transaction capture", isSystem: false }).returning();
      const [group] = await transaction.insert(groups).values({ ownerId: humanUserId,
        type: `custom:transaction-capture-${suffix}`, label: "Transaction capture", isSystem: false }).returning();
      if (!role || !group) throw new Error("Could not create transaction capture grant");
      await transaction.insert(roleCapabilities).values(grants.map(capability => ({ roleId: role.id, capabilityId: capability.id })));
      await transaction.insert(groupRoles).values({ groupId: group.id, roleId: role.id });
      await transaction.insert(groupMembers).values({ groupId: group.id, userId: humanUserId });
      const [originalPolicy] = await transaction.select().from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server")).limit(1);
      if (!originalPolicy) throw new Error("Disposable clone lacks transition policy");
      const plainRevision = originalPolicy.revision + 1;
      await transaction.update(encryptionTransitionPolicy).set({ mode: "plaintext_only", shadowBehavior: "fallback",
        shadowEncryptionStartedAt: null, revision: plainRevision, updatedAt: new Date() })
        .where(eq(encryptionTransitionPolicy.id, "server"));

      const controller = new AbortController();
      const port = createHumanTerminalAdmissionPort({ signal: controller.signal,
        readPolicy: async () => { throw new Error("global policy reader must not acquire another connection"); },
        readScope: async () => { throw new Error("global source reader must not acquire another connection"); },
        validateProtected: async () => { throw new Error("plaintext capture has no protected owner"); } });
      const borrowed = createTaskLocalExecutionCaptureAdmission({ database: transaction,
        humanUserId, agentId, roomId, conversationId: graphThreadId });
      expect(await port.withBorrowedAdmission!(borrowed, async signal => {
        expect(signal).toBe(controller.signal);
        return "captured";
      })).toBe("captured");

      const protectedRevision = plainRevision + 1;
      await transaction.update(encryptionTransitionPolicy).set({ mode: "shadow_encryption", shadowBehavior: "strict",
        shadowEncryptionStartedAt: new Date(), revision: protectedRevision, updatedAt: new Date() })
        .where(eq(encryptionTransitionPolicy.id, "server"));
      let protectedChecks = 0;
      const protectedBorrowed = createTaskLocalExecutionCaptureAdmission({ database: transaction,
        humanUserId, agentId, roomId, conversationId: graphThreadId,
        assertCurrentProtected: async () => {
          protectedChecks++;
          const [current] = await transaction.select({ revision: encryptionTransitionPolicy.revision })
            .from(encryptionTransitionPolicy).where(eq(encryptionTransitionPolicy.id, "server")).limit(1);
          if (current?.revision !== protectedRevision) throw new Error("protected creation policy changed");
        } });
      expect(await port.withBorrowedAdmission!(protectedBorrowed, async () => "protected-captured"))
        .toBe("protected-captured");
      expect(protectedChecks).toBe(2);

      let effects = 0;
      const stalePolicy = port.withBorrowedAdmission!(protectedBorrowed, async () => {
        effects++;
        await transaction.update(encryptionTransitionPolicy).set({ revision: protectedRevision + 1, updatedAt: new Date() })
          .where(eq(encryptionTransitionPolicy.id, "server"));
        return "must-not-escape";
      });
      expect(await stalePolicy.then(() => false, () => true)).toBeTrue();
      expect(effects).toBe(1);
      await transaction.update(encryptionTransitionPolicy).set({ revision: protectedRevision, updatedAt: new Date() })
        .where(eq(encryptionTransitionPolicy.id, "server"));

      effects = 0;
      const staleSource = port.withBorrowedAdmission!(protectedBorrowed, async () => {
        effects++;
        await transaction.delete(roomMembers).where(eq(roomMembers.actorId, agentActorId));
        return "must-not-escape";
      });
      expect(await staleSource.then(() => false, () => true)).toBeTrue();
      expect(effects).toBe(1);
      await transaction.insert(roomMembers).values({ roomId, actorId: agentActorId,
        roomRole: "member", agentResponseMode: "active" });

      effects = 0;
      const staleCapability = port.withBorrowedAdmission!(protectedBorrowed, async () => {
        effects++;
        await transaction.delete(groupMembers).where(eq(groupMembers.userId, humanUserId));
        return "must-not-escape";
      });
      expect(await staleCapability.then(() => false, () => true)).toBeTrue();
      expect(effects).toBe(1);

      let deniedEffects = 0;
      const deniedBeforeDispatch = port.withBorrowedAdmission!(protectedBorrowed, async () => {
        deniedEffects++;
        return "must-not-dispatch";
      });
      expect(await deniedBeforeDispatch.then(() => false, () => true)).toBeTrue();
      expect(deniedEffects).toBe(0);
      completed = true;
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  } finally {
    await database.end();
  }
  expect(completed).toBeTrue();
}, 10_000);
