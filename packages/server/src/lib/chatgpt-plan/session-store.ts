import { randomUUID } from "node:crypto";
import type { ChatGPTRegistrationRecord } from "@nautilo/db";
import {
  encryptPersonalProviderCredential, decryptPersonalProviderCredential,
  type PersonalProviderCredentialContext, type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import {
  CHATGPT_ISSUER, ChatGPTPlanError, type ChatGPTOAuth,
  type ChatGPTRegistrationIdentity, type ChatGPTSession,
} from "./oauth";

type Mutation = Pick<ChatGPTRegistrationRecord, "state" | "envelope" | "identityEnvelope" | "authorityRevision" | "tokenGeneration">;
export interface ChatGPTSessionStoreDeps {
  runtimeIdentity: () => Promise<string>;
  custody: () => Promise<PersonalProviderCustody>;
  insert: (row: ChatGPTRegistrationRecord) => Promise<boolean>;
  lock: <T>(userId: string, id: string, action: (row: ChatGPTRegistrationRecord) => Promise<{ result: T; mutation?: Mutation }>) => Promise<T>;
  oauth: Pick<ChatGPTOAuth, "refresh" | "revoke">;
  now?: () => number;
}

export function chatGPTCredentialContext(row: Pick<ChatGPTRegistrationRecord, "id" | "userId" | "serverInstanceId" | "hostId" | "clientId" | "authorityRevision" | "tokenGeneration">, kind: "identity" | "tokens"): PersonalProviderCredentialContext {
  return { id: row.id, userId: row.userId, provider: "openai-chatgpt",
    revision: kind === "identity" ? row.authorityRevision : row.tokenGeneration,
    destination: JSON.stringify([row.serverInstanceId, row.hostId, row.clientId, kind]) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isText(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

function identity(value: unknown, row: ChatGPTRegistrationRecord): ChatGPTRegistrationIdentity {
  if (!isObject(value) || value["issuer"] !== CHATGPT_ISSUER || !isText(value["subject"])
    || value["clientId"] !== row.clientId || value["hostId"] !== row.hostId
    || (value["email"] !== undefined && !isText(value["email"]))) {
    throw new ChatGPTPlanError("credential_unavailable");
  }
  return { issuer: CHATGPT_ISSUER, subject: value["subject"], clientId: row.clientId, hostId: row.hostId,
    ...(typeof value["email"] === "string" ? { email: value["email"] } : {}) };
}

export function readChatGPTIdentity(custody: PersonalProviderCustody, row: ChatGPTRegistrationRecord): ChatGPTRegistrationIdentity {
  try {
    return identity(JSON.parse(decryptPersonalProviderCredential(custody, row.identityEnvelope, chatGPTCredentialContext(row, "identity"))), row);
  } catch { throw new ChatGPTPlanError("credential_unavailable"); }
}

function readSession(custody: PersonalProviderCustody, row: ChatGPTRegistrationRecord): ChatGPTSession {
  try {
    if (row.state !== "connected" || !row.envelope) throw new ChatGPTPlanError("reconnect_required");
    const data: unknown = JSON.parse(decryptPersonalProviderCredential(custody, row.envelope, chatGPTCredentialContext(row, "tokens")));
    const expected = readChatGPTIdentity(custody, row);
    if (!isObject(data)) throw new Error();
    const verified = identity(data["identity"], row);
    if (verified.subject !== expected.subject || !isText(data["accessToken"]) || !isText(data["refreshToken"])
      || !isText(data["idToken"]) || !Number.isSafeInteger(data["expiresAt"]) || !Number.isSafeInteger(data["receivedAt"])
      || !Array.isArray(data["scopes"]) || !data["scopes"].every(isText)
      || !["chatgpt.tokens.use.direct", "resource.invoke", "offline_access"].every(s => (data["scopes"] as string[]).includes(s))) throw new Error();
    return { identity: verified, accessToken: data["accessToken"], refreshToken: data["refreshToken"], idToken: data["idToken"],
      expiresAt: data["expiresAt"] as number, receivedAt: data["receivedAt"] as number, scopes: data["scopes"] };
  } catch (error) {
    if (error instanceof ChatGPTPlanError) throw error;
    throw new ChatGPTPlanError("credential_unavailable");
  }
}

/** All methods require an authenticated Human supplied by the trusted route/admission. */
export class ChatGPTSessionStore {
  constructor(private readonly deps: ChatGPTSessionStoreDeps) {}

  private async context(row: ChatGPTRegistrationRecord, userId: string) {
    if (row.userId !== userId || row.serverInstanceId !== await this.deps.runtimeIdentity()) {
      throw new ChatGPTPlanError("credential_unavailable");
    }
    return this.deps.custody();
  }

  private clear(custody: PersonalProviderCustody, row: ChatGPTRegistrationRecord, state: "disconnected" | "reconnect_required"): Mutation {
    const savedIdentity = readChatGPTIdentity(custody, row);
    const next = { ...row, authorityRevision: row.authorityRevision + 1, tokenGeneration: row.tokenGeneration + 1 };
    return { state, envelope: null, authorityRevision: next.authorityRevision, tokenGeneration: next.tokenGeneration,
      identityEnvelope: encryptPersonalProviderCredential(custody, JSON.stringify(savedIdentity), chatGPTCredentialContext(next, "identity")) };
  }

  async connect(userId: string, session: ChatGPTSession, signal: AbortSignal,
    reconnect?: { id: string; authorityRevision: number }): Promise<string> {
    const serverInstanceId = await this.deps.runtimeIdentity();
    if (session.identity.hostId !== `urn:uuid:${serverInstanceId}` || !userId) throw new ChatGPTPlanError("identity_invalid");
    const custody = await this.deps.custody();
    signal.throwIfAborted();
    if (reconnect) return this.deps.lock(userId, reconnect.id, async row => {
      await this.context(row, userId);
      if (row.authorityRevision !== reconnect.authorityRevision) throw new ChatGPTPlanError("credential_conflict");
      const previous = readChatGPTIdentity(custody, row);
      if (previous.subject !== session.identity.subject || previous.clientId !== session.identity.clientId) {
        throw new ChatGPTPlanError("identity_invalid");
      }
      const next = { ...row, authorityRevision: row.authorityRevision + 1, tokenGeneration: row.tokenGeneration + 1 };
      signal.throwIfAborted();
      return { result: row.id, mutation: {
        state: "connected", authorityRevision: next.authorityRevision, tokenGeneration: next.tokenGeneration,
        identityEnvelope: encryptPersonalProviderCredential(custody, JSON.stringify(session.identity), chatGPTCredentialContext(next, "identity")),
        envelope: encryptPersonalProviderCredential(custody, JSON.stringify(session), chatGPTCredentialContext(next, "tokens")),
      } };
    });
    const fields = {
      id: randomUUID(), userId, clientId: session.identity.clientId, serverInstanceId, hostId: session.identity.hostId,
      authorityRevision: 1, tokenGeneration: 1, selected: false, state: "connected" as const,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const row: ChatGPTRegistrationRecord = { ...fields,
      identityEnvelope: encryptPersonalProviderCredential(custody, JSON.stringify(session.identity), chatGPTCredentialContext(fields, "identity")),
      envelope: encryptPersonalProviderCredential(custody, JSON.stringify(session), chatGPTCredentialContext(fields, "tokens")),
    };
    signal.throwIfAborted();
    if (!await this.deps.insert(row)) throw new ChatGPTPlanError("credential_conflict");
    return row.id;
  }

  async accessToken(userId: string, id: string, authorityRevision: number, signal: AbortSignal): Promise<string> {
    const outcome = await this.deps.lock<{ accessToken: string | null }>(userId, id, async row => {
      const custody = await this.context(row, userId);
      if (row.authorityRevision !== authorityRevision) throw new ChatGPTPlanError("credential_conflict");
      const session = readSession(custody, row);
      signal.throwIfAborted();
      if (session.expiresAt > (this.deps.now ?? Date.now)()) return { result: { accessToken: session.accessToken } };
      try {
        const renewed = await this.deps.oauth.refresh(session, signal);
        const next = { ...row, tokenGeneration: row.tokenGeneration + 1 };
        // Once the provider rotates, persist its replacement even if the
        // initiating request cancelled. It belongs to the session, not a turn.
        return { result: { accessToken: renewed.accessToken }, mutation: {
          state: "connected" as const, authorityRevision: row.authorityRevision, tokenGeneration: next.tokenGeneration,
          identityEnvelope: row.identityEnvelope,
          envelope: encryptPersonalProviderCredential(custody, JSON.stringify(renewed), chatGPTCredentialContext(next, "tokens")),
        } };
      } catch {
        // Ambiguous rotation is not safe to replay with the old refresh token.
        // Persist the fence before surfacing the sanitized reconnect outcome.
        return { result: { accessToken: null }, mutation: this.clear(custody, row, "reconnect_required") };
      }
    });
    signal.throwIfAborted();
    if (!outcome.accessToken) throw new ChatGPTPlanError("reconnect_required");
    return outcome.accessToken;
  }

  async disconnect(userId: string, id: string, authorityRevision: number, signal: AbortSignal): Promise<{ remoteRevocationConfirmed: boolean }> {
    return this.deps.lock(userId, id, async row => {
      const custody = await this.context(row, userId);
      if (row.authorityRevision !== authorityRevision) throw new ChatGPTPlanError("credential_conflict");
      let confirmed = false;
      try { confirmed = await this.deps.oauth.revoke(readSession(custody, row), signal); } catch { /* Clear local authority even if remote revocation fails. */ }
      return { result: { remoteRevocationConfirmed: confirmed }, mutation: this.clear(custody, row, "disconnected") };
    });
  }
}
