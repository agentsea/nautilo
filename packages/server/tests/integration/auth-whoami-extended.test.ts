/**
 * D112 Phase 11 — GET /api/auth/whoami extended identity fields.
 * M128 T18 — GroupChip[] projection on whoami.
 */
import { resolve } from "node:path";
import { config } from "dotenv";
import { describe, expect, test } from "bun:test";
import {
  eq,
  groupMembers,
  groups,
  markPasswordChangeRequired,
  PASSWORD_CHANGE_REASON,
} from "@nautilo/db";
import { pickHighestRoleSlug } from "@nautilo/api-client";
import type { GroupChip, WhoamiResponse } from "@nautilo/types";
import { setupOwnerAppFixture } from "../integration/helpers/app-fixture";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

describe("GET /api/auth/whoami Phase 11 extensions", () => {
  test("guest keeps legacy fields plus empty extended slice", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: `whoami-g-${Date.now().toString(36)}` });
    try {
      const res = await fx.app.inject({ method: "GET", url: "/api/auth/whoami" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(Array.isArray(body["groups"])).toBe(true);
      expect((body["groups"] as unknown[]).length).toBe(0);
      expect(body["sessionUserId"]).toBeNull();
      expect(body["handle"]).toBeNull();
      expect(body["displayName"]).toBeNull();
      // D219 — `serverRole` retired; whoami no longer carries it.
      expect("serverRole" in body).toBe(false);
      expect(body["highestRole"]).toBeNull();
      expect(body["externalId"]).toBeNull();
      expect(typeof body["instanceId"]).toBe("string");
      expect(body["mustChangePassword"]).toBe(false);
      // M129 — guest has no capabilities.
      expect(Array.isArray(body["capabilities"])).toBe(true);
      expect((body["capabilities"] as unknown[]).length).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test("signed-in owner includes populated extended fields", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: `whoami-o-${Date.now().toString(36)}` });
    try {
      const [ownersGroup] = await fx.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      if (!ownersGroup) throw new Error("canonical owners group missing");
      await fx.db
        .insert(groupMembers)
        .values({
          groupId: ownersGroup.id,
          userId: fx.ownerId,
          grantedBy: fx.ownerActorId,
        })
        .onConflictDoNothing({
          target: [groupMembers.groupId, groupMembers.userId],
        });

      const token = await fx.mintOwnerBearer();
      const res = await fx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body["sessionUserId"]).toBe(fx.ownerId);
      expect(body["handle"]).toBe(fx.ownerHandle);
      expect(body["displayName"]).toContain("whoami-o-");
      // D219 — `serverRole` retired; the owner's role badge derives from
      // `highestRole` (owners-Group seeded above) and `capabilities`.
      expect("serverRole" in body).toBe(false);
      expect(body["highestRole"]).toBe("owner");
      expect(body["externalId"]).toBe(fx.ownerLogtoSub);
      expect(typeof body["instanceId"]).toBe("string");
      expect(body["mustChangePassword"]).toBe(false);
      // M246 — existing whoami projection exposes the new authority facts
      // additively; no response field or route contract is introduced.
      expect(body["capabilities"]).toEqual(
        expect.arrayContaining(["invoke_agents", "write_artifacts"]),
      );
    } finally {
      await fx.cleanup();
    }
  });

  test("signed-in owner returns GroupChip[] with owners membership (M128 T18)", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: `whoami-m128-${Date.now().toString(36)}` });
    try {
      const [ownersGroup] = await fx.db
        .select({ id: groups.id, type: groups.type, label: groups.label })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      if (!ownersGroup) throw new Error("canonical owners group missing");
      await fx.db
        .insert(groupMembers)
        .values({
          groupId: ownersGroup.id,
          userId: fx.ownerId,
          grantedBy: fx.ownerActorId,
        })
        .onConflictDoNothing({
          target: [groupMembers.groupId, groupMembers.userId],
        });

      const token = await fx.mintOwnerBearer();
      const res = await fx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as WhoamiResponse;
      expect(Array.isArray(body.groups)).toBe(true);
      for (const chip of body.groups) {
        const keys = Object.keys(chip).sort();
        expect(keys).toEqual(["id", "label", "roleSlug", "type"]);
        expect(typeof chip.id).toBe("string");
        expect(typeof chip.type).toBe("string");
        expect(typeof chip.label).toBe("string");
        expect(typeof chip.roleSlug).toBe("string");
      }
      const ownersChip = body.groups.find((g: GroupChip) => g.type === "owners");
      expect(ownersChip).toBeDefined();
      expect(ownersChip!.roleSlug).toBe("owner");
      expect(ownersChip!.id).toBe(ownersGroup.id);
      expect(pickHighestRoleSlug(body.groups)).toBe("owner");
      // M129 — owner's capability union includes the owner-only cap.
      expect(Array.isArray(body.capabilities)).toBe(true);
      expect(body.capabilities).toContain("manage_server_security");
    } finally {
      await fx.cleanup();
    }
  });

  test("mustChangePassword follows logto_account_security row", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: `whoami-d-${Date.now().toString(36)}` });
    try {
      await markPasswordChangeRequired(fx.db, {
        userId: fx.ownerId,
        reason: PASSWORD_CHANGE_REASON.SETUP_TEMP_PASSWORD,
      });
      const token = await fx.mintOwnerBearer();
      const res = await fx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body["mustChangePassword"]).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });
});
