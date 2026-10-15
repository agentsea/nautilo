import type { NautiloApiClient } from "@nautilo/api-client/browser";
import { createSettingsDataState, sameSettingsDataScope, type SettingsDataScope } from "./settings-data-state";

type AccountApi = Pick<NautiloApiClient, "listChatGPTAccounts" | "listChatGPTModels" | "selectChatGPTAccount" | "disconnectChatGPTAccount">;
type Accounts = Awaited<ReturnType<AccountApi["listChatGPTAccounts"]>>;
export type ChatGPTAccount = Accounts["accounts"][number];
export interface ChatGPTAccountsData extends Accounts {
  models: Record<string, { id: string; name: string }[] | null>;
}

export function createChatGPTAccountsController(apiForScope: (scope: SettingsDataScope) => AccountApi) {
  const data = createSettingsDataState<ChatGPTAccountsData, never>();
  const load = async (scope: SettingsDataScope): Promise<ChatGPTAccountsData> => {
    const api = apiForScope(scope);
    const accounts = await api.listChatGPTAccounts();
    if (!sameSettingsDataScope(data.getState().scope, scope)) return { ...accounts, models: {} };
    const entries = await Promise.all(accounts.accounts.map(async account => {
      if (!accounts.enabled || account.state !== "connected" || account.requiresReplacement) return [account.id, []] as const;
      try { return [account.id, (await api.listChatGPTModels(account.id)).models] as const; }
      catch { return [account.id, null] as const; }
    }));
    const models: ChatGPTAccountsData["models"] = {};
    for (const [id, values] of entries) models[id] = values === null ? null : [...values];
    return { ...accounts, models };
  };
  const ready = () => {
    const current = data.getState();
    return !current.loading && !current.loadError && !current.mutating ? current.data : null;
  };
  const currentAccount = (account: ChatGPTAccount) => ready()?.accounts.find(item => item.id === account.id && item.revision === account.revision);
  return {
    data,
    setScope: (scope: SettingsDataScope | null) => data.setScope(scope),
    load: () => data.load(load),
    select: (account: ChatGPTAccount | null) => {
      const current = account ? currentAccount(account) : null;
      if (!ready()?.enabled || (account && (!current || current.state !== "connected" || current.requiresReplacement))) return Promise.resolve({ status: "ignored" } as const);
      return data.mutate(async scope => { await apiForScope(scope).selectChatGPTAccount(account?.id ?? null); }, load);
    },
    disconnect: async (account: ChatGPTAccount) => {
      if (!currentAccount(account)) return { status: "ignored" } as const;
      let remoteRevocationConfirmed = false;
      const result = await data.mutate(async scope => {
        remoteRevocationConfirmed = (await apiForScope(scope).disconnectChatGPTAccount(account.id, account.revision)).remoteRevocationConfirmed;
      }, load);
      return result.status === "applied" ? { ...result, remoteRevocationConfirmed } : result;
    },
  };
}
