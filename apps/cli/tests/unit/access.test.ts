import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
  AccessControlCatalogue,
  AccessControlMutationOperation,
  EffectiveAccessResponse,
} from "@nautilo/api-client";
import yargs from "yargs/yargs";
import { createAccessModule } from "../../src/commands/access.ts";
import type { AuthenticatedAdminClient } from "../../src/lib/authenticated-admin-client.ts";

const catalogue: AccessControlCatalogue = {
  capabilities: [
    { slug: "invoke_other_agents", description: "Invoke other agents", category: "agents" },
    { slug: "use_personal_provider_credentials", description: "Use personal credentials", category: "providers" },
    { slug: "use_server_provider_credentials", description: "Use server credentials", category: "providers" },
  ],
  roles: [{ id: "role-1", slug: "community", label: "Community", isSystem: true, capabilitySlugs: ["use_personal_provider_credentials"], groupCount: 1 }],
  groups: [{ id: "group-1", type: "communities", label: "Communities", isSystem: true, ownerId: null, roleSlugs: ["community"], memberCount: 0 }],
};
const effective: EffectiveAccessResponse = {
  user: { id: "user-1", handle: "agent_tester", displayName: "AgentX", server: null },
  highestRole: "community",
  capabilities: [{
    slug: "manage_members",
    description: "Manage people",
    category: "admin",
    granted: true,
    provenance: [{
      groupId: "group-1",
      groupType: "admins",
      groupLabel: "Admins",
      groupIsSystem: true,
      groupOwnerId: null,
      roleSlug: "admin",
      roleLabel: "Admins",
      roleIsSystem: true,
    }],
  }],
  groups: [{ id: "group-1", type: "admins", label: "Admins", isSystem: true, ownerId: null, roleSlugs: ["admin"] }],
  roles: [{ slug: "admin", label: "Admins", isSystem: true, capabilitySlugs: ["manage_members"] }],
  groupRoleFacts: [],
};

let stdout = "";
let original: typeof process.stdout.write;
beforeEach(() => {
  stdout = "";
  original = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    stdout += typeof value === "string" ? value : Buffer.from(value).toString();
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = original;
  process.exitCode = undefined;
});

function client(capabilities = ["manage_roles"]): AuthenticatedAdminClient {
  return {
    whoami: { sessionUserId: "user-1", capabilities },
    api: { admin: { accessControl: {
      getCatalogue: async () => catalogue,
      getEffectiveAccess: async () => effective,
    } } },
  } as unknown as AuthenticatedAdminClient;
}

test("catalogue returns canonical built-in/custom facts", async () => {
  await yargs(["access", "catalogue", "--format", "json"])
    .exitProcess(false)
    .command(createAccessModule({ authenticate: async () => client() }))
    .strict()
    .parseAsync();
  expect(JSON.parse(stdout)).toMatchObject({
    ok: true,
    data: {
      capabilities: [
        { slug: "invoke_other_agents" },
        { slug: "use_personal_provider_credentials" },
        { slug: "use_server_provider_credentials" },
      ],
      roles: [{ slug: "community", isSystem: true }],
      groups: [{ type: "communities" }],
    },
  });
});

test("effective defaults to the verified caller and preserves provenance", async () => {
  await yargs(["access", "effective", "--format", "json"])
    .exitProcess(false)
    .command(createAccessModule({ authenticate: async () => client() }))
    .strict()
    .parseAsync();
  expect(JSON.parse(stdout)).toMatchObject({
    data: { user: { id: "user-1" }, capabilities: [{ provenance: [{ roleSlug: "admin" }] }] },
  });
});

test("client-side authority gate blocks catalogue I/O", async () => {
  let catalogueCalls = 0;
  const denied = client([]);
  (denied.api.admin.accessControl as { getCatalogue: () => Promise<AccessControlCatalogue> }).getCatalogue = async () => {
    catalogueCalls += 1;
    return catalogue;
  };
  await yargs(["access", "catalogue", "--format", "json"])
    .exitProcess(false)
    .command(createAccessModule({ authenticate: async () => denied }))
    .strict()
    .parseAsync();
  expect(catalogueCalls).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "capability_denied" } });
});

test("change plan is write-free and apply requires explicit confirmation", async () => {
  const operation = { kind: "group.rename" as const, groupId: "group-1", label: "Operators" };
  let applyCalls = 0;
  const admin = client();
  (admin.api.admin.accessControl as unknown as {
    previewChange(input: AccessControlMutationOperation): Promise<unknown>;
    applyChange(input: AccessControlMutationOperation, fingerprint: string): Promise<unknown>;
  }).previewChange = async () => ({
    ok: true,
    operation,
    checks: [{ code: "authorized", passed: true }],
    failures: [],
    auditPreview: { kind: "rbac_group_renamed", actorId: null },
    fingerprint: "a".repeat(64),
  });
  (admin.api.admin.accessControl as unknown as {
    applyChange(input: AccessControlMutationOperation, fingerprint: string): Promise<unknown>;
  }).applyChange = async () => {
    applyCalls += 1;
    return { applied: true, auditRecorded: true, fingerprint: "a".repeat(64) };
  };
  await yargs(["access", "change", "plan", "--file", "/safe/change.json", "--format", "json"])
    .exitProcess(false)
    .command(createAccessModule({
      authenticate: async () => admin,
      readOperation: async () => operation,
    }))
    .strict()
    .parseAsync();
  expect(JSON.parse(stdout)).toMatchObject({ data: { ok: true, fingerprint: "a".repeat(64) } });
  expect(applyCalls).toBe(0);

  stdout = "";
  await yargs(["access", "change", "apply", "--file", "/safe/change.json", "--fingerprint", "a".repeat(64), "--format", "json"])
    .exitProcess(false)
    .command(createAccessModule({
      authenticate: async () => admin,
      readOperation: async () => operation,
    }))
    .strict()
    .parseAsync();
  expect(applyCalls).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "confirmation_required" } });
});
