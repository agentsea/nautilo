import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import Fastify, { type FastifyInstance } from "fastify";
import type { CapabilityFundingSession } from "@nautilo/agent";
import type { PersonalCapabilityPreferences } from "@nautilo/types";
import {
  personalCapabilityPreferenceRoutes,
  type PersonalCapabilityPreferenceRouteDeps,
} from "../../src/routes/personal-capability-preferences";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const MODEL = "openrouter:model-a";
const EXTENDED_URL = "/api/account/capability-preferences?include=imageUnderstanding";
const LEGACY_URL = "/api/account/capability-preferences";
const apps: FastifyInstance[] = [];

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function harness(input: {
  missingCredentials?: boolean;
  failCollaboratorsAfterWrite?: boolean;
  imageSources?: readonly ("server" | "personal")[];
  imageModels?: Partial<Record<"server" | "personal", string>>;
} = {}) {
  const rows = new Map<string, PersonalCapabilityPreferences>();
  const writes: Array<{ humanId: string; expectedRevision: number; overrides: unknown }> = [];
  let openedSessions = 0;
  const openedWorkloads: string[] = [];
  const imagePayers: string[] = [];
  let committed = false;
  const db = {} as ReturnType<NonNullable<PersonalCapabilityPreferenceRouteDeps["getDb"]>>;
  const deps: PersonalCapabilityPreferenceRouteDeps = {
    getDb: () => db,
    getPreferences: async (_db, humanId) => {
      if (input.failCollaboratorsAfterWrite && committed) throw new Error("post-commit preference read");
      return rows.get(humanId) ?? { revision: 0, overrides: {} };
    },
    replacePreferences: async (_db, request) => {
      writes.push(request);
      const current = rows.get(request.humanId) ?? { revision: 0, overrides: {} };
      if (current.revision !== request.expectedRevision) {
        return { status: "conflict", currentRevision: current.revision };
      }
      const preferences = { revision: current.revision + 1, overrides: request.overrides };
      rows.set(request.humanId, preferences);
      committed = true;
      return { status: "updated", preferences };
    },
    listModels: () => {
      if (input.failCollaboratorsAfterWrite && committed) throw new Error("post-commit catalogue read");
      return [{ modelId: MODEL, displayName: "Model A", provider: "openrouter" }];
    },
    openSession: async (humanId) => {
      if (input.failCollaboratorsAfterWrite && committed) throw new Error("post-commit funding read");
      openedSessions += 1;
      return {
        fundingPreference: "personal_first",
        session: {
          humanUserId: humanId,
          resolveModel: async () => {
            if (input.missingCredentials) throw Object.assign(new Error("secret-free"), { code: "personal_credential_missing" });
            return { modelId: MODEL, preferenceRevision: rows.get(humanId)?.revision ?? 0 };
          },
          openModel: async (_modelId, workload) => {
            openedWorkloads.push(workload);
            if (input.missingCredentials) throw Object.assign(new Error("secret-free"), { code: "personal_credential_missing" });
            return { binding: { kind: "server", providerRoute: "openrouter" }, fundingSession: {} as never };
          },
          projectImageUnderstandingFunding: async (configuredId, kind) => {
            imagePayers.push(kind);
            if (input.missingCredentials || (input.imageSources && !input.imageSources.includes(kind))) {
              throw Object.assign(new Error("secret-free"), { code: "personal_credential_missing" });
            }
            return {
              modelId: configuredId ?? input.imageModels?.[kind] ?? MODEL,
              binding: kind === "server" ? { kind, providerRoute: "openrouter" }
                : { kind, providerRoute: "openrouter", credentialId: "test-key", credentialRevision: 1 },
            };
          },
          projectMediaFunding: async () => {
            if (input.missingCredentials) throw Object.assign(new Error("secret-free"), { code: "personal_credential_missing" });
            return { kind: "server", providerRoute: "openrouter" };
          },
          openService: async () => { throw new Error("not used"); },
        } as CapabilityFundingSession,
      };
    },
  };
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const user = request.headers["x-test-user"];
    request.sessionUserId = typeof user === "string" ? user : null;
  });
  personalCapabilityPreferenceRoutes(app, deps);
  apps.push(app);
  await app.ready();
  return { app, rows, writes, openedWorkloads, imagePayers, openedSessionCount: () => openedSessions };
}

function parse(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, unknown>;
}


// Frozen wire contract from independently shipped clients before image preferences.
const legacyRoles = [
  "webSearchSynthesis", "deepResearchSupervisor", "deepResearchResearcher",
  "deepResearchSummarization", "deepResearchCompression", "deepResearchFinalReport",
  "decision", "imageGeneration", "videoGeneration", "musicGeneration", "speech",
  "memoryReview", "memoryReflection", "memorySummarization",
] as const;
const legacyReadiness = z.object({
  status: z.enum(["ready", "missing-credentials", "unavailable"]),
  reason: z.string().nullable(), fundingSource: z.enum(["personal", "server"]).nullable(),
  providerRoute: z.string().trim().min(1).nullable(),
}).strict();
const legacyResponse = z.object({
  revision: z.number().int().nonnegative(),
  overrides: z.object(Object.fromEntries(legacyRoles.map((role) => [role, z.string().trim().min(1).max(512).optional()]))).strict(),
  fundingPreference: z.enum(["personal_first", "server_first"]),
  capabilities: z.array(z.object({
    role: z.enum(legacyRoles), label: z.string().trim().min(1), description: z.string().trim().min(1),
    selection: z.object({ source: z.enum(["inherited", "personal"]), modelId: z.string().trim().min(1).max(512).nullable(), displayName: z.string().trim().min(1) }).strict(),
    readiness: legacyReadiness,
    options: z.array(z.object({ modelId: z.string().trim().min(1).max(512), displayName: z.string().trim().min(1), provider: z.string().trim().min(1), readiness: legacyReadiness }).strict()),
  }).strict()),
}).strict();

describe("personal capability preference routes", () => {
  test("requires authentication and scopes every read to the session Human", async () => {
    const source = await harness();
    source.rows.set(USER_A, { revision: 1, overrides: { decision: MODEL } });
    source.rows.set(USER_B, { revision: 4, overrides: {} });
    expect((await source.app.inject({ method: "GET", url: EXTENDED_URL })).statusCode).toBe(401);
    const response = await source.app.inject({ method: "GET", url: EXTENDED_URL, headers: { "x-test-user": USER_A } });
    expect(response.statusCode).toBe(200);
    expect(parse(response)).toMatchObject({ revision: 1, overrides: { decision: MODEL }, fundingPreference: "personal_first" });
    expect(JSON.stringify(parse(response))).not.toContain(USER_B);
  });

  test("keeps inherited defaults sparse and exposes effective readiness", async () => {
    const source = await harness({ missingCredentials: true });
    const response = await source.app.inject({ method: "GET", url: EXTENDED_URL, headers: { "x-test-user": USER_A } });
    const body = parse(response);
    expect(body["overrides"]).toEqual({});
    const capabilities = body["capabilities"] as Array<Record<string, unknown>>;
    expect(capabilities).toHaveLength(15);
    expect(capabilities[0]).toMatchObject({
      selection: { source: "inherited", modelId: null, displayName: "Automatic" },
      readiness: { status: "missing-credentials" },
    });
  });

  test("projects the admitted funding source and route", async () => {
    const source = await harness();
    const response = await source.app.inject({ method: "GET", url: EXTENDED_URL, headers: { "x-test-user": USER_A } });
    const capability = (parse(response)["capabilities"] as Array<Record<string, unknown>>)[0];
    expect(capability).toMatchObject({
      selection: { modelId: MODEL },
      readiness: { status: "ready", fundingSource: "server", providerRoute: "openrouter" },
      options: [expect.objectContaining({
        readiness: { status: "ready", reason: null, fundingSource: "server", providerRoute: "openrouter" },
      })],
    });
    expect(source.openedSessionCount()).toBe(1);
    expect(source.openedWorkloads).toContain("memory");
    expect(source.openedWorkloads).not.toContain("image_assistance");
    expect(new Set(source.imagePayers)).toEqual(new Set(["server", "personal"]));
    const capabilities = parse(response)["capabilities"] as Array<Record<string, unknown>>;
    expect(capabilities.filter((entry) => String(entry["role"]).startsWith("memory"))
      .map((entry) => [entry["role"], entry["label"]])).toEqual([
        ["memoryReview", "Memory review"],
        ["memoryReflection", "Memory reflection"],
        ["memorySummarization", "Memory summarization"],
      ]);
  });

  test("saves compatible choices without requiring ready credentials and resets by omission", async () => {
    const source = await harness({ missingCredentials: true });
    const saved = await source.app.inject({
      method: "PUT", url: EXTENDED_URL, headers: { "x-test-user": USER_A },
      payload: { expectedRevision: 0, overrides: { webSearchSynthesis: MODEL } },
    });
    expect(saved.statusCode).toBe(200);
    expect(parse(saved)).toMatchObject({ revision: 1, overrides: { webSearchSynthesis: MODEL } });
    const reset = await source.app.inject({
      method: "PUT", url: EXTENDED_URL, headers: { "x-test-user": USER_A },
      payload: { expectedRevision: 1, overrides: {} },
    });
    expect(reset.statusCode).toBe(200);
    expect(parse(reset)).toMatchObject({ revision: 2, overrides: {} });
  });

  test("finishes fallible projection collaborators before committing a successful PUT", async () => {
    const source = await harness({ failCollaboratorsAfterWrite: true });
    const response = await source.app.inject({
      method: "PUT", url: EXTENDED_URL, headers: { "x-test-user": USER_A },
      payload: { expectedRevision: 0, overrides: { decision: MODEL } },
    });

    expect(response.statusCode).toBe(200);
    expect(parse(response)).toMatchObject({
      revision: 1,
      overrides: { decision: MODEL },
      fundingPreference: "personal_first",
    });
    expect(source.rows.get(USER_A)).toEqual({ revision: 1, overrides: { decision: MODEL } });
    expect(source.writes).toHaveLength(1);
  });

  test("rejects unknown roles/models and reports CAS conflicts", async () => {
    const source = await harness();
    source.rows.set(USER_A, { revision: 2, overrides: {} });
    for (const overrides of [{ embeddings: MODEL }, { decision: "openai:not-signed" }]) {
      const response = await source.app.inject({
        method: "PUT", url: EXTENDED_URL, headers: { "x-test-user": USER_A },
        payload: { expectedRevision: 2, overrides },
      });
      expect(response.statusCode).toBe(422);
    }
    const conflict = await source.app.inject({
      method: "PUT", url: EXTENDED_URL, headers: { "x-test-user": USER_A },
      payload: { expectedRevision: 1, overrides: {} },
    });
    expect(conflict.statusCode).toBe(409);
    expect(parse(conflict)).toEqual({ error: "capability_preference_conflict", currentRevision: 2 });
  });

  test("serves the frozen legacy parser and preserves unadvertised choices on replacement", async () => {
    const source = await harness();
    const removed = "openrouter:removed-image-model";
    source.rows.set(USER_A, { revision: 3, overrides: { imageUnderstanding: removed, decision: MODEL } });
    const headers = { "x-test-user": USER_A };
    const response = await source.app.inject({ method: "GET", url: LEGACY_URL, headers });
    expect(response.statusCode).toBe(200);
    expect(legacyResponse.safeParse(parse(response)).success).toBe(true);
    expect(parse(response)["overrides"]).toEqual({ decision: MODEL });
    expect(source.imagePayers).toEqual([]);
    const saved = await source.app.inject({ method: "PUT", url: LEGACY_URL, headers,
      payload: { expectedRevision: 3, overrides: { webSearchSynthesis: MODEL } } });
    expect(saved.statusCode).toBe(200);
    expect(legacyResponse.safeParse(parse(saved)).success).toBe(true);
    expect(parse(saved)["overrides"]).toEqual({ webSearchSynthesis: MODEL });
    expect(source.rows.get(USER_A)).toEqual({ revision: 4,
      overrides: { webSearchSynthesis: MODEL, imageUnderstanding: removed } });
    const stale = await source.app.inject({ method: "PUT", url: LEGACY_URL, headers,
      payload: { expectedRevision: 3, overrides: {} } });
    expect(stale.statusCode).toBe(409);
    expect(source.rows.get(USER_A)?.overrides.imageUnderstanding).toBe(removed);
  });

  test("only opted-in clients can read, set, and reset the image role", async () => {
    const source = await harness();
    const headers = { "x-test-user": USER_A };
    const rejected = await source.app.inject({ method: "PUT", url: LEGACY_URL, headers,
      payload: { expectedRevision: 0, overrides: { imageUnderstanding: MODEL } } });
    expect(rejected.statusCode).toBe(422);
    const saved = await source.app.inject({ method: "PUT", url: EXTENDED_URL, headers,
      payload: { expectedRevision: 0, overrides: { imageUnderstanding: MODEL } } });
    expect(saved.statusCode).toBe(200);
    expect(parse(saved)["overrides"]).toEqual({ imageUnderstanding: MODEL });
    expect((parse(saved)["capabilities"] as Array<{ role: string }>).some((role) => role.role === "imageUnderstanding")).toBe(true);
    const reset = await source.app.inject({ method: "PUT", url: EXTENDED_URL, headers,
      payload: { expectedRevision: 1, overrides: {} } });
    expect(reset.statusCode).toBe(200);
    expect(source.rows.get(USER_A)?.overrides).toEqual({});
  });

  test.each(["server", "personal"] as const)("reports image readiness for %s-funded chats only", async (kind) => {
    const source = await harness({ imageSources: [kind] });
    const response = await source.app.inject({ method: "GET", url: EXTENDED_URL, headers: { "x-test-user": USER_A } });
    const image = (parse(response)["capabilities"] as Array<Record<string, unknown>>).find((role) => role["role"] === "imageUnderstanding")!;
    expect(image["readiness"]).toMatchObject({ status: "ready", fundingSource: kind });
    const readiness = image["readiness"] as { reason: string };
    expect(readiness.reason).toContain(`${kind === "server" ? "Server" : "Personal"}-funded chats: Model A is ready`);
    expect(readiness.reason).toContain("follows the chat's funding source and privacy requirements");
    expect(readiness.reason).toContain(kind === "server"
      ? "Personal-funded chats: Add a compatible personal provider key."
      : "Server-funded chats: Ask an administrator to configure compatible server provider credentials.");
    const options = image["options"] as Array<{ readiness: { fundingSource: string | null } }>;
    expect(options.map((option) => option.readiness.fundingSource)).toEqual([kind]);
  });

  test("does not present one Automatic image model as universal across payers", async () => {
    const source = await harness({ imageModels: { server: MODEL, personal: "openrouter:model-b" } });
    const response = await source.app.inject({ method: "GET", url: EXTENDED_URL, headers: { "x-test-user": USER_A } });
    const image = (parse(response)["capabilities"] as Array<Record<string, unknown>>).find((role) => role["role"] === "imageUnderstanding")!;
    expect(image["selection"]).toEqual({ source: "inherited", modelId: null, displayName: "Automatic — depends on chat funding" });
    expect(image["readiness"]).toMatchObject({ status: "ready", fundingSource: null, providerRoute: null });
    expect((image["readiness"] as { reason: string }).reason).toContain("Personal-funded chats: openrouter:model-b is ready");
  });

});
