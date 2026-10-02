import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveNautiloRootDir } from "@nautilo/config";
import { getAllKeyDefinitions, maskValue } from "@nautilo/config-guard";
import {
  PERSONAL_PROVIDER_IDS,
  createPersonalProviderCredentialIdentity,
  deletePersonalProviderCredential,
  getPersonalProviderCredential,
  getServerProviderPolicy,
  insertPersonalProviderCredential,
  listPersonalProviderCredentials,
  replacePersonalProviderCredential,
  setPersonalProviderCredentialValidation,
  type PersonalProviderCredentialRecord,
  type PersonalProviderId,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import {
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
  PersonalProviderCustodyError,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import { getUserCapabilities } from "@nautilo/trust";
import { PERSONAL_CHAT_PROVIDER_IDS } from "../lib/model-funding";
import { readPersonalProviderCustody } from "../lib/personal-provider-custody";
import { validatePersonalProviderCredential } from "../lib/personal-provider-validation";
import { writeSecurityAuditEvent, type PersonalProviderCredentialAuditEvent } from "../lib/security-audit-log";
import { getServerDirectDb } from "../lib/server-direct-db";

type ErrorCode =
  | "authentication_required" | "personal_credentials_forbidden" | "personal_credentials_disabled"
  | "personal_credentials_unavailable" | "credential_custody_unavailable"
  | "credential_reenrollment_required" | "invalid_provider" | "invalid_credential_request"
  | "credential_conflict" | "credential_not_found";

const personalChatProviderIds = new Set<string>(PERSONAL_CHAT_PROVIDER_IDS);
const retainedServerGatewayProviderIds = new Set(["nautilo-gateway", "gateway"]);
const personalProviderCatalog = getAllKeyDefinitions()
  .filter((definition) => !retainedServerGatewayProviderIds.has(definition.id))
  .map((definition) => ({
    id: definition.id,
    name: definition.name,
    purpose: definition.purpose,
    ...(definition.signupUrl ? { signupUrl: definition.signupUrl } : {}),
    ...(definition.formatHint ? { formatHint: definition.formatHint } : {}),
    personalCapabilities: personalChatProviderIds.has(definition.id) ? ["chat"] : [],
  }));
const canonicalPersonalProviderIds = new Set(personalProviderCatalog.map(({ id }) => id));

function failure(
  error: ErrorCode,
  committed = false,
  retryable = false,
  repair: string | null = null,
) {
  return { error, committed, retryable, repair };
}

function parseProvider(request: FastifyRequest): PersonalProviderId | null {
  const params = request.params as { provider?: unknown } | undefined;
  const value = params?.provider;
  return typeof value === "string" && (PERSONAL_PROVIDER_IDS as readonly string[]).includes(value)
    ? value as PersonalProviderId
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : null;
}

function parseWrite(body: unknown): { apiKey: string; expectedRevision?: number } | null {
  if (!isObject(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "apiKey" && key !== "expectedRevision")) return null;
  if (typeof body["apiKey"] !== "string" || body["apiKey"].trim().length === 0) return null;
  if (body["expectedRevision"] === undefined) return keys.length === 1 ? { apiKey: body["apiKey"] } : null;
  const expectedRevision = parseRevision(body["expectedRevision"]);
  return expectedRevision === null ? null : { apiKey: body["apiKey"], expectedRevision };
}

function parseRevisionBody(body: unknown): number | null {
  if (!isObject(body) || Object.keys(body).length !== 1) return null;
  return parseRevision(body["expectedRevision"]);
}

type CredentialAccess =
  | { readonly state: "ready"; readonly apiKey: string; readonly masked: string }
  | { readonly state: "reenroll"; readonly apiKey: null; readonly masked: null };

function maskPersonalCredential(value: string): string {
  // maskValue intentionally exposes a useful prefix. A value no longer than
  // that prefix would therefore be disclosed in full, so tiny credentials get
  // a fully masked projection instead.
  const masked = maskValue(value);
  return masked.startsWith(value) ? "********" : masked;
}

function credentialAccess(
  record: PersonalProviderCredentialRecord,
  custody: PersonalProviderCustody,
): CredentialAccess {
  if (record.envelope.keyId === custody.resetFromKeyId) {
    return { state: "reenroll", apiKey: null, masked: null };
  }
  if (record.envelope.keyId !== custody.keyId) throw new PersonalProviderCustodyError("custody_key_mismatch");
  // A matching key ID alone does not prove that the key bytes can read this row.
  const apiKey = decryptPersonalProviderCredential(custody, record.envelope, record);
  return { state: "ready", apiKey, masked: maskPersonalCredential(apiKey) };
}

function metadata(record: PersonalProviderCredentialRecord, access: CredentialAccess) {
  return {
    provider: record.provider,
    id: record.id,
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    validationStatus: access.state === "reenroll" ? "unverified" as const : record.validationStatus,
    validatedAt: access.state === "reenroll" ? null : record.validatedAt?.toISOString() ?? null,
    requiresReplacement: access.state === "reenroll",
    masked: access.masked,
  };
}

function unavailableAfter(error: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, repair: string) {
  return error instanceof PersonalProviderCustodyError
    ? reply.code(503).send(failure("credential_custody_unavailable", false, false, "contact_operator"))
    : reply.code(503).send(failure("personal_credentials_unavailable", false, true, repair));
}

function audit(request: FastifyRequest, event: Omit<PersonalProviderCredentialAuditEvent, "ts" | "ip" | "userAgent">): void {
  try {
    writeSecurityAuditEvent(join(resolveNautiloRootDir(), "logs", "security-audit.log"), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
  } catch {
    warn("[personal-provider-credentials] audit write failed");
  }
}

export interface PersonalProviderCredentialRouteDeps {
  getDb?: typeof getServerDirectDb;
  getPolicy?: typeof getServerProviderPolicy;
  getCapabilities?: typeof getUserCapabilities;
  readCustody?: typeof readPersonalProviderCustody;
  getCredential?: typeof getPersonalProviderCredential;
  listCredentials?: typeof listPersonalProviderCredentials;
  insertCredential?: typeof insertPersonalProviderCredential;
  replaceCredential?: typeof replacePersonalProviderCredential;
  deleteCredential?: typeof deletePersonalProviderCredential;
  setValidation?: typeof setPersonalProviderCredentialValidation;
  validate?: typeof validatePersonalProviderCredential;
  auditEvent?: typeof audit;
}

export function personalProviderCredentialRoutes(app: FastifyInstance, overrides: PersonalProviderCredentialRouteDeps = {}): void {
  const deps = {
    getDb: overrides.getDb ?? getServerDirectDb,
    getPolicy: overrides.getPolicy ?? getServerProviderPolicy,
    getCapabilities: overrides.getCapabilities ?? getUserCapabilities,
    readCustody: overrides.readCustody ?? readPersonalProviderCustody,
    getCredential: overrides.getCredential ?? getPersonalProviderCredential,
    listCredentials: overrides.listCredentials ?? listPersonalProviderCredentials,
    insertCredential: overrides.insertCredential ?? insertPersonalProviderCredential,
    replaceCredential: overrides.replaceCredential ?? replacePersonalProviderCredential,
    deleteCredential: overrides.deleteCredential ?? deletePersonalProviderCredential,
    setValidation: overrides.setValidation ?? setPersonalProviderCredentialValidation,
    validate: overrides.validate ?? validatePersonalProviderCredential,
    auditEvent: overrides.auditEvent ?? audit,
  };

  function emitAudit(request: FastifyRequest, event: Omit<PersonalProviderCredentialAuditEvent, "ts" | "ip" | "userAgent">): void {
    try {
      deps.auditEvent(request, event);
    } catch {
      warn("[personal-provider-credentials] audit write failed");
    }
  }

  async function admit(request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    const userId = request.sessionUserId;
    if (!userId) {
      reply.code(401).send(failure("authentication_required"));
      return null;
    }
    let policy;
    try {
      policy = await deps.getPolicy(deps.getDb());
    } catch {
      reply.code(503).send(failure("personal_credentials_unavailable", false, true, "retry"));
      return null;
    }
    if (!policy.allowPersonalProviderKeys) {
      reply.code(404).send(failure("personal_credentials_disabled"));
      return null;
    }
    try {
      const capabilities = await deps.getCapabilities(userId);
      if (!capabilities.includes("use_personal_provider_credentials")) {
        reply.code(403).send(failure("personal_credentials_forbidden"));
        return null;
      }
    } catch {
      reply.code(503).send(failure("personal_credentials_unavailable", false, true, "retry"));
      return null;
    }
    return userId;
  }

  async function readCustody(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    try {
      return await deps.readCustody();
    } catch {
      reply.code(503).send(failure("credential_custody_unavailable", false, true, "contact_operator"));
      return null;
    }
  }

  app.get("/api/account/provider-credentials", { logLevel: "silent" }, async (request, reply) => {
    const userId = await admit(request, reply);
    if (!userId) return;
    const custody = await readCustody(reply);
    if (!custody) return;
    try {
      const records = await deps.listCredentials(deps.getDb(), userId);
      return reply.send({
        credentials: records.map((record) => metadata(record, credentialAccess(record, custody))),
        providers: personalProviderCatalog,
      });
    } catch (error) {
      return unavailableAfter(error, reply, "retry");
    }
  });

  app.put("/api/account/provider-credentials/:provider", { logLevel: "silent" }, async (request, reply) => {
    const userId = await admit(request, reply);
    if (!userId) return;
    const provider = parseProvider(request);
    const body = parseWrite(request.body);
    if (!provider || !body) return reply.code(422).send(failure(provider ? "invalid_credential_request" : "invalid_provider"));
    const custody = await readCustody(reply);
    if (!custody) return;
    try {
      const db = deps.getDb();
      const current = await deps.getCredential(db, userId, provider);
      if (current) {
        if (body.expectedRevision === undefined || body.expectedRevision !== current.revision) {
          return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
        }
        credentialAccess(current, custody); // Reset provenance may permit re-enrollment without the lost key.
        const envelope = encryptPersonalProviderCredential(custody, body.apiKey, {
          userId, provider, id: current.id, revision: current.revision + 1,
        });
        const result = await deps.replaceCredential(db, {
          userId, provider, id: current.id, expectedRevision: current.revision, envelope,
        });
        if (result.status !== "replaced") {
          return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
        }
        emitAudit(request, { kind: "personal_provider_credential_changed", actorId: userId, provider, credentialId: result.credential.id, revision: result.credential.revision, action: "replaced" });
        return reply.send({ credential: metadata(result.credential, credentialAccess(result.credential, custody)), committed: true });
      }
      if (body.expectedRevision !== undefined) {
        return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
      }
      if (!canonicalPersonalProviderIds.has(provider)) {
        return reply.code(422).send(failure("invalid_provider"));
      }
      const identity = createPersonalProviderCredentialIdentity();
      const envelope = encryptPersonalProviderCredential(custody, body.apiKey, { userId, provider, ...identity });
      const result = await deps.insertCredential(db, { identity, userId, provider, envelope });
      if (result.status !== "created") {
        return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
      }
      emitAudit(request, { kind: "personal_provider_credential_changed", actorId: userId, provider, credentialId: result.credential.id, revision: result.credential.revision, action: "created" });
      return reply.send({ credential: metadata(result.credential, credentialAccess(result.credential, custody)), committed: true });
    } catch (error) {
      return unavailableAfter(error, reply, "reread_metadata");
    }
  });

  app.post("/api/account/provider-credentials/:provider/validate", { logLevel: "silent" }, async (request, reply) => {
    const userId = await admit(request, reply);
    if (!userId) return;
    const provider = parseProvider(request);
    const expectedRevision = parseRevisionBody(request.body);
    if (!provider || expectedRevision === null) return reply.code(422).send(failure(provider ? "invalid_credential_request" : "invalid_provider"));
    const custody = await readCustody(reply);
    if (!custody) return;
    try {
      const db = deps.getDb();
      const record = await deps.getCredential(db, userId, provider);
      if (!record) return reply.code(404).send(failure("credential_not_found"));
      if (record.revision !== expectedRevision) return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
      const access = credentialAccess(record, custody);
      if (access.state === "reenroll") {
        return reply.code(409).send(failure("credential_reenrollment_required", false, false, "replace_credential"));
      }
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      request.raw.once("aborted", abort);
      const observation = await (async () => {
        try {
          return await deps.validate(provider, access.apiKey, cancellation.signal);
        } finally {
          request.raw.off("aborted", abort);
        }
      })();
      // A switch or capability revocation during a network call cannot publish status.
      if (!await admit(request, reply)) return;
      const result = await deps.setValidation(db, {
        userId, provider, id: record.id, expectedRevision,
        status: observation.status, validatedAt: new Date(),
      });
      if (result.status !== "updated") {
        return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
      }
      emitAudit(request, { kind: "personal_provider_credential_changed", actorId: userId, provider, credentialId: record.id, revision: expectedRevision, action: "validated", validationStatus: observation.status });
      return reply.send({ credential: metadata(result.credential, access), committed: false });
    } catch (error) {
      return unavailableAfter(error, reply, "retry_validation");
    }
  });

  app.delete("/api/account/provider-credentials/:provider", { logLevel: "silent" }, async (request, reply) => {
    const userId = await admit(request, reply);
    if (!userId) return;
    const provider = parseProvider(request);
    const expectedRevision = parseRevisionBody(request.body);
    if (!provider || expectedRevision === null) return reply.code(422).send(failure(provider ? "invalid_credential_request" : "invalid_provider"));
    const custody = await readCustody(reply);
    if (!custody) return;
    try {
      const db = deps.getDb();
      const record = await deps.getCredential(db, userId, provider);
      if (!record) return reply.send({ deleted: true, committed: true });
      if (record.revision !== expectedRevision) return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
      credentialAccess(record, custody);
      const result = await deps.deleteCredential(db, { userId, provider, id: record.id, expectedRevision });
      if (result.status === "conflict") return reply.code(409).send(failure("credential_conflict", false, false, "reread_metadata"));
      if (result.status === "deleted") {
        emitAudit(request, { kind: "personal_provider_credential_changed", actorId: userId, provider, credentialId: record.id, revision: expectedRevision, action: "deleted" });
      }
      return reply.send({ deleted: true, committed: true });
    } catch (error) {
      return unavailableAfter(error, reply, "reread_metadata");
    }
  });
}
