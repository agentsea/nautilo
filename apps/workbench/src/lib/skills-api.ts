import { apiClient } from "./api";
import { workbenchFetch } from "./admission-fetch";

export interface SkillListItem {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  requiresTools: string[];
  tokenEstimate: number;
  updatedAt: string;
  official: boolean;
  forked: boolean;
  version?: number;
}

export interface SkillDetail extends SkillListItem {
  body: string;
}

export interface SkillToolOption {
  name: string;
  label: string;
  description: string;
  category: string;
}

export interface SkillsListResponse {
  skills: SkillListItem[];
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

export async function fetchSkills(): Promise<SkillsListResponse> {
  const res = await workbenchFetch("/api/skills", { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to load skills");
  return (await res.json()) as SkillsListResponse;
}

export async function fetchSkillToolOptions(): Promise<SkillToolOption[]> {
  const res = await workbenchFetch("/api/skills/tool-options", { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to load available capabilities");
  const json = (await res.json()) as { tools: SkillToolOption[] };
  return json.tools;
}

export async function fetchSkill(name: string): Promise<SkillDetail> {
  const res = await workbenchFetch(`/api/skills/${encodeURIComponent(name)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to load skill");
  const json = (await res.json()) as { skill: SkillDetail };
  return json.skill;
}

export async function saveSkill(input: {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  requiresTools: string[];
}): Promise<SkillDetail> {
  const res = await workbenchFetch("/api/skills", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res, "Failed to save skill");
  const json = (await res.json()) as { skill: SkillDetail };
  return json.skill;
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<SkillDetail> {
  const res = await workbenchFetch(`/api/skills/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) await parseError(res, "Failed to update skill");
  const json = (await res.json()) as { skill: SkillDetail };
  return json.skill;
}

export async function deleteSkill(name: string): Promise<void> {
  const res = await workbenchFetch(`/api/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to delete skill");
}

export async function customizeSkill(name: string): Promise<SkillDetail> {
  const res = await workbenchFetch(`/api/skills/${encodeURIComponent(name)}/customize`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to customize skill");
  const json = (await res.json()) as { skill: SkillDetail };
  return json.skill;
}

export async function resetSkill(name: string): Promise<void> {
  const res = await workbenchFetch(`/api/skills/${encodeURIComponent(name)}/reset`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to reset skill");
}
