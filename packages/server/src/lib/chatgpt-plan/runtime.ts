import { isCloudMode } from "@nautilo/config";
import {
  getChatGPTRuntimeIdentity, getChatGPTRegistration, getSelectedChatGPTRegistration,
  insertChatGPTRegistration, withLockedChatGPTRegistration, type ChatGPTRegistrationRecord,
} from "@nautilo/db";
import { DEFAULT_PROVIDER_TIMEOUT_MS, resolveCatalogModel } from "@nautilo/agent";
import { readPersonalProviderCustody } from "../personal-provider-custody";
import { getServerDirectDb } from "../server-direct-db";
import { ChatGPTOAuth, ChatGPTPlanError, CHATGPT_RESOURCE } from "./oauth";
import { ChatGPTSessionStore } from "./session-store";

export const chatGPTSessionStore = new ChatGPTSessionStore({
  runtimeIdentity: () => getChatGPTRuntimeIdentity(getServerDirectDb()),
  custody: readPersonalProviderCustody,
  insert: row => insertChatGPTRegistration(getServerDirectDb(), row),
  lock: (userId, id, action) => withLockedChatGPTRegistration(getServerDirectDb(), userId, id, action),
  oauth: new ChatGPTOAuth(),
});

export interface ChatGPTFundingRegistration {
  id: string;
  revision: number;
  available: boolean;
  modelIds?: readonly string[];
}
export async function chatGPTFundingRegistration(userId: string, id?: string): Promise<ChatGPTFundingRegistration | null> {
  const db = getServerDirectDb();
  const row = id ? await getChatGPTRegistration(db, userId, id) : await getSelectedChatGPTRegistration(db, userId);
  if (!row) return null;
  return { id: row.id, revision: row.authorityRevision,
    available: !isCloudMode() && row.state === "connected" && row.serverInstanceId === await getChatGPTRuntimeIdentity(db) };
}

export async function listChatGPTModels(row: ChatGPTRegistrationRecord, signal: AbortSignal): Promise<{ id: string; name: string }[]> {
  if (isCloudMode()) throw new ChatGPTPlanError("credential_unavailable");
  const token = await chatGPTSessionStore.accessToken(row.userId, row.id, row.authorityRevision, signal);
  let body: unknown;
  try {
    const response = await fetch(`${CHATGPT_RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal });
    if (!response.ok) throw new Error();
    body = await response.json();
  } catch { throw new ChatGPTPlanError("provider_unavailable"); }
  if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) {
    throw new ChatGPTPlanError("provider_unavailable");
  }
  return body.models.flatMap((model: unknown) => {
    if (!model || typeof model !== "object" || !("slug" in model) || typeof model.slug !== "string"
      || !("visibility" in model) || model.visibility !== "list"
      || !("display_name" in model) || typeof model.display_name !== "string") return [];
    const id = `openai:${model.slug}`;
    const catalog = resolveCatalogModel(id, { env: {} });
    return catalog.workload === "chat" && catalog.output.includes("text")
      && ["selectable", "missing_credentials"].includes(catalog.availability)
      ? [{ id, name: model.display_name }] : [];
  });
}

export async function chatGPTFundingModels(userId: string, id: string): Promise<readonly string[]> {
  const row = await getChatGPTRegistration(getServerDirectDb(), userId, id);
  if (!row) throw new ChatGPTPlanError("credential_unavailable");
  return (await listChatGPTModels(row, AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT_MS))).map(model => model.id);
}
