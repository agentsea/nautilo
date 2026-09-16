import { apiClient } from "./api";
import { workbenchFetch } from "./admission-fetch";

export interface CommandListItem {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  tokenEstimate: number;
  updatedAt: string;
  official: boolean;
  forked: boolean;
  version?: number;
}

export interface CommandDetail extends CommandListItem {
  body: string;
}

export interface CommandsListResponse {
  commands: CommandListItem[];
  summary: { total: number; enabled: number; disabled: number };
}

function authHeaders(): HeadersInit {
  const token = apiClient.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseError(res: Response, fallback: string): Promise<never> {
  let detail = fallback;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) detail = json.error;
  } catch {
    /* ignore */
  }
  throw new Error(detail);
}

export async function fetchCommands(): Promise<CommandsListResponse> {
  const res = await workbenchFetch("/api/commands", { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to load commands");
  return (await res.json()) as CommandsListResponse;
}

export async function fetchCommand(name: string): Promise<CommandDetail> {
  const res = await workbenchFetch(`/api/commands/${encodeURIComponent(name)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to load command");
  const json = (await res.json()) as { command: CommandDetail };
  return json.command;
}

export async function putCommand(input: {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}): Promise<CommandDetail> {
  const res = await workbenchFetch("/api/commands", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res, "Failed to save command");
  const json = (await res.json()) as { command: CommandDetail };
  return json.command;
}

export async function setCommandEnabled(name: string, enabled: boolean): Promise<CommandDetail> {
  const res = await workbenchFetch(`/api/commands/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) await parseError(res, "Failed to update command");
  const json = (await res.json()) as { command: CommandDetail };
  return json.command;
}

export async function deleteCommand(name: string): Promise<void> {
  const res = await workbenchFetch(`/api/commands/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to delete command");
}

export async function customizeCommand(name: string): Promise<CommandDetail> {
  const res = await workbenchFetch(`/api/commands/${encodeURIComponent(name)}/customize`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to customize command");
  const json = (await res.json()) as { command: CommandDetail };
  return json.command;
}

export async function resetCommand(name: string): Promise<void> {
  const res = await workbenchFetch(`/api/commands/${encodeURIComponent(name)}/reset`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to reset command");
}
