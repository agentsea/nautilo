export type ForegroundExecutionConfig = Readonly<{
  name: string;
  defaultModel: string | null;
  soulFile: string | null;
}>;

export type ForegroundSkillBody = Readonly<{
  id: string;
  name: string;
  description: string;
  body: string;
  requiresTools: readonly string[];
}>;

export type ForegroundAuthoredContext = Readonly<{
  profile: ForegroundExecutionConfig | null;
  soulFile: string;
  skills: readonly ForegroundSkillBody[];
}>;

export async function loadForegroundAuthoredContext(input: Readonly<{
  agentId: string;
  ownerId: string;
  isGuest: boolean;
}>, deps: Readonly<{
  getExecutionConfigByAgentId(agentId: string): Promise<ForegroundExecutionConfig | null>;
  resolveEnabledBodies(
    agentId: string,
    ownerId: string,
    options: { isGuest: boolean },
  ): Promise<readonly ForegroundSkillBody[]>;
}>): Promise<ForegroundAuthoredContext> {
  if (input.isGuest) {
    return Object.freeze({
      profile: null,
      soulFile: "",
      skills: Object.freeze([]),
    });
  }
  const profile = input.agentId
    ? await deps.getExecutionConfigByAgentId(input.agentId).catch(() => null)
    : null;
  const skills = input.agentId && input.ownerId
    ? await deps.resolveEnabledBodies(
      input.agentId,
      input.ownerId,
      { isGuest: false },
    ).catch(() => [])
    : [];
  return Object.freeze({
    profile,
    soulFile: profile?.soulFile ?? "",
    skills,
  });
}
