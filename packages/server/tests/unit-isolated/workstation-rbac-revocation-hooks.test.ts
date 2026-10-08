import { afterAll, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import * as trust from "@nautilo/trust";
import * as database from "@nautilo/db";
import * as auditLog from "../../src/lib/security-audit-log";
import * as deletion from "../../src/lib/user-account-deletion";
import * as freshness from "../../src/lib/logto-freshness";
import { InMemoryWorkstationSessionRegistry, FULL_WORKSTATION_AGENT_SCOPE } from "@nautilo/runtime";
import { createWorkstationAuthorityReconciler } from "../../src/routes/workstation-access";

const originalTrust = { ...trust };
const originalAuditLog = { ...auditLog };
const originalDeletion = { ...deletion };
const originalFreshness = { ...freshness };

// Exercise the production routes without a database or audit-file side effect.
// Wrappers delegate to the original exports after this file finishes.
let active = true;
let applyResult: trust.ApplyResult = { applied: true, auditRecorded: true, fingerprint: "fixture-fingerprint" };
let applyError: Error | null = null;
let accountFound = true;
let accountChanged = true;
const fakeDb = new Proxy(database.db, { get(target, property) {
  if (!active || property !== "update") return Reflect.get(target, property) as unknown;
  return () => ({ set: () => ({ where: () => ({ returning: async () => accountChanged ? [{ id: "human-fixture" }] : [] }) }) });
} });
mock.module("@nautilo/db", () => ({ ...database, db: fakeDb }));
mock.module("@nautilo/trust", () => ({ ...trust,
  userHasCapability: (...args: Parameters<typeof trust.userHasCapability>) => active ? Promise.resolve(true) : originalTrust.userHasCapability(...args),
  findUserById: (...args: Parameters<typeof trust.findUserById>) => active
    ? Promise.resolve(accountFound ? { id: args[0], server: null } : null) : originalTrust.findUserById(...args),
  findCanonicalGroupByType: (...args: Parameters<typeof trust.findCanonicalGroupByType>) => active ? Promise.resolve(null) : originalTrust.findCanonicalGroupByType(...args),
  applyOperation: (...args: Parameters<typeof trust.applyOperation>) => {
    if (!active) return originalTrust.applyOperation(...args);
    if (applyError) return Promise.reject(applyError); return Promise.resolve(applyResult);
  },
  createProductionMutationEngineDeps: (...args: Parameters<typeof trust.createProductionMutationEngineDeps>) => active ? {} : originalTrust.createProductionMutationEngineDeps(...args),
}));
mock.module("../../src/lib/security-audit-log", () => ({ ...auditLog,
  writeSecurityAuditEvent: (...args: Parameters<typeof auditLog.writeSecurityAuditEvent>) => active ? undefined : originalAuditLog.writeSecurityAuditEvent(...args),
}));
mock.module("../../src/lib/user-account-deletion", () => ({ ...deletion,
  assessAccountDeletion: (...args: Parameters<typeof deletion.assessAccountDeletion>) => active ? Promise.resolve({ eligible: true }) : originalDeletion.assessAccountDeletion(...args),
  deleteLocalUserAccount: (...args: Parameters<typeof deletion.deleteLocalUserAccount>) => {
    if (!active) return originalDeletion.deleteLocalUserAccount(...args);
    args[1]?.onCommitted?.(args[0]);
    return Promise.resolve({ logtoRevoked: true, deletedAgents: 0, deletedRooms: 0, deletedSessions: 0 });
  },
}));
mock.module("../../src/lib/logto-freshness", () => ({ ...freshness,
  requireFreshLogtoAccessToken: (...args: Parameters<typeof freshness.requireFreshLogtoAccessToken>) => active ? Promise.resolve(null) : originalFreshness.requireFreshLogtoAccessToken(...args),
}));
const { accountRoutes } = await import("../../src/routes/account");
const { accessControlMutationRoutes } = await import("../../src/routes/access-control-mutations");
const { adminUsersRoutes } = await import("../../src/routes/admin-users");
afterAll(() => { active = false; });

function registryFixture() {
  const revoked: string[] = [];
  const registry = new InMemoryWorkstationSessionRegistry({ onAuthorityRevoked: ({ binding }) => revoked.push(binding.userId) });
  for (const userId of ["human-fixture", "other-human"]) {
    const binding = { userId, instanceId: "instance-fixture", relayId: `relay-${userId}`, desktopSessionId: "desktop-fixture",
      serverBindingId: "server-fixture", pairingGeneration: "pairing-fixture", profileId: "profile-fixture", profileRevision: 1,
      agentScope: FULL_WORKSTATION_AGENT_SCOPE, grantIds: [], capabilityRevision: 1 };
    registry.activate(binding, binding);
  }
  return { registry, revoked };
}
function appFixture(userId = "admin-fixture") {
  const app = Fastify(); app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async request => { request.sessionUserId = userId; }); return app;
}

describe("post-commit RBAC and account authority hooks", () => {
  test("successful Role/Group mutations stop only Humans who lost effective permission", async () => {
    for (const operation of [
      { kind: "role.set_capabilities", roleId: "role-fixture", capabilities: [] },
      { kind: "group.set_roles", groupId: "group-fixture", roleSlugs: [] },
      { kind: "role.delete", roleId: "role-fixture" },
      { kind: "group.delete", groupId: "group-fixture" },
    ]) {
      const { registry, revoked } = registryFixture(); const app = appFixture();
      applyError = null; applyResult = { applied: true, auditRecorded: true, fingerprint: "fixture-fingerprint" };
      accessControlMutationRoutes(app, { onAuthorityChanged: createWorkstationAuthorityReconciler({ registry: () => registry,
        getCapabilities: userId => Promise.resolve(userId === "human-fixture" ? [] : ["use_workstation"]) }) });
      try {
        const response = await app.inject({ method: "POST", url: "/api/admin/access-control/changes/apply", payload: { operation, fingerprint: "fixture-fingerprint" } });
        expect(response.statusCode).toBe(200); expect(revoked).toEqual(["human-fixture"]);
        expect(registry.get("other-human")).not.toBeNull();
      } finally { await app.close(); }
    }
  });
  test("alternate grants survive, and stale/denied/failed mutations never invoke the post-success hook", async () => {
    const { registry, revoked } = registryFixture(); const app = appFixture(); let calls = 0;
    const reconcile = createWorkstationAuthorityReconciler({ registry: () => registry, getCapabilities: () => Promise.resolve(["use_workstation"]) });
    accessControlMutationRoutes(app, { onAuthorityChanged: async operation => { calls++; await reconcile(operation); } });
    const payload = { operation: { kind: "role.set_capabilities", roleId: "role-fixture", capabilities: [] }, fingerprint: "fixture-fingerprint" };
    try {
      applyResult = { applied: true, auditRecorded: false, fingerprint: "fixture-fingerprint" }; applyError = null;
      expect((await app.inject({ method: "POST", url: "/api/admin/access-control/changes/apply", payload })).statusCode).toBe(200);
      expect(calls).toBe(1); expect(revoked).toEqual([]);
      applyResult = { applied: false, code: "stale_preview", failures: [] };
      expect((await app.inject({ method: "POST", url: "/api/admin/access-control/changes/apply", payload })).statusCode).toBe(409);
      applyResult = { applied: false, code: "authorization_denied", failures: [] };
      expect((await app.inject({ method: "POST", url: "/api/admin/access-control/changes/apply", payload })).statusCode).toBe(403);
      applyError = new Error("fixture failure");
      expect((await app.inject({ method: "POST", url: "/api/admin/access-control/changes/apply", payload })).statusCode).toBe(500);
      expect(calls).toBe(1); expect(revoked).toEqual([]);
    } finally { applyError = null; await app.close(); }
  });
  test("account disable and deletion invoke the exact user fence after success; enable never resurrects consent", async () => {
    const { registry, revoked } = registryFixture(); const app = appFixture(); accountFound = true; accountChanged = true;
    adminUsersRoutes(app, { onAuthorityRevoked: userId => { registry.disable(userId); } });
    try {
      const disabled = await app.inject({ method: "POST", url: "/api/admin/users/human-fixture/disable", payload: {} });
      expect(disabled.statusCode).toBe(200); expect(revoked).toEqual(["human-fixture"]);
      expect((await app.inject({ method: "POST", url: "/api/admin/users/human-fixture/enable" })).statusCode).toBe(200);
      expect(registry.get("human-fixture")).toBeNull();
      const deleted = await app.inject({ method: "DELETE", url: "/api/admin/users/other-human" });
      expect(deleted.statusCode).toBe(200); expect(revoked).toEqual(["human-fixture", "other-human"]);
      accountFound = false;
      expect((await app.inject({ method: "POST", url: "/api/admin/users/foreign-human/disable", payload: {} })).statusCode).toBe(404);
      expect(revoked).toHaveLength(2);
    } finally { accountFound = true; await app.close(); }
  });
  test("self-service account deletion passes the authenticated Human fence into the committed helper", async () => {
    const { registry, revoked } = registryFixture(); const app = appFixture("human-fixture");
    accountRoutes(app, { onAuthorityRevoked: userId => { registry.disable(userId); } });
    try {
      const invalid = await app.inject({ method: "DELETE", url: "/api/account", payload: { confirmation: "wrong" } });
      expect(invalid.statusCode).toBe(400); expect(revoked).toEqual([]);
      const deleted = await app.inject({ method: "DELETE", url: "/api/account", payload: { confirmation: "DELETE MY ACCOUNT" } });
      expect(deleted.statusCode).toBe(200); expect(revoked).toEqual(["human-fixture"]);
      expect(registry.get("other-human")).not.toBeNull();
    } finally { await app.close(); }
  });

});
