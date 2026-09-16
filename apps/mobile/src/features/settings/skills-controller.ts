import type {
  SaveSkillRequest,
  SkillDetail,
  SkillListItem,
  SkillToolOption,
  SkillsListResponse,
} from "@nautilo/api-client/browser";

import {
  createSettingsDataState,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsClearMutationResult,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "./settings-data-state";

/** The same lifecycle distinctions used by the desktop Skills surface. */
export type MobileSkillKind = "yours" | "official-untouched" | "official-customized";

/**
 * A phone can manage the server-owned Skills catalogue, but it is not an MCP
 * host. Keep local-MCP setup out of the mobile projection rather than changing
 * the canonical server/desktop catalogue or its execution contract.
 */
const MOBILE_UNSUPPORTED_SKILL_TOOL = "manage_local_mcp";
export const MOBILE_MCP_SKILL_MESSAGE = "Skills that manage local MCP servers are available on desktop only.";

export function isMobileVisibleSkill(skill: Pick<SkillListItem, "requiresTools">): boolean {
  return !skill.requiresTools.includes(MOBILE_UNSUPPORTED_SKILL_TOOL);
}

export function mobileSkillRequirementsMessage(input: Pick<SaveSkillRequest, "requiresTools">): string | null {
  return isMobileVisibleSkill(input) ? null : MOBILE_MCP_SKILL_MESSAGE;
}

export function mobileSkillToolOptions(options: readonly SkillToolOption[]): SkillToolOption[] {
  return options.filter((option) => option.name !== MOBILE_UNSUPPORTED_SKILL_TOOL);
}

export function mobileSkillsProjection(data: SkillsListResponse): Pick<SkillsListResponse, "skills" | "summary"> {
  const skills = data.skills.filter(isMobileVisibleSkill);
  const enabled = skills.filter((skill) => skill.enabled).length;
  return {
    skills,
    summary: { total: skills.length, enabled, disabled: skills.length - enabled },
  };
}

export function mobileSkillKind(skill: Pick<SkillListItem, "official" | "forked">): MobileSkillKind {
  if (!skill.official) return "yours";
  return skill.forked ? "official-customized" : "official-untouched";
}

export function canToggleMobileSkill(skill: Pick<SkillListItem, "official" | "forked">): boolean {
  return mobileSkillKind(skill) !== "official-untouched";
}

export function canConfigureMobileSkill(skill: Pick<SkillListItem, "official" | "forked">): boolean {
  return mobileSkillKind(skill) !== "official-untouched";
}

export function canResetMobileSkill(skill: Pick<SkillListItem, "official" | "forked">): boolean {
  return mobileSkillKind(skill) === "official-customized";
}

export function canDeleteMobileSkill(skill: Pick<SkillListItem, "official">): boolean {
  return !skill.official;
}

export function formatMobileSkillTitle(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function skillSettingsErrorMessage(error: unknown): string {
  const status = error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
  if (status === 401) return "Your session has expired. Sign in again before managing Skills.";
  if (status === 403) return "This server does not allow you to manage Skills for this Agent.";
  if (status === 404) return "This Skill is no longer available. Return to the Skills list and refresh it.";
  return error instanceof Error && error.message
    ? error.message
    : "Could not update Skills. Your server settings were not changed.";
}

function hasHttpStatus(error: unknown, expected: number): boolean {
  return error !== null && typeof error === "object" && "status" in error
    && (error as { status?: unknown }).status === expected;
}

/** The typed shared-client boundary; mobile does not reconstruct its own DTOs. */
export interface SkillsApi {
  listSkills(): Promise<SkillsListResponse>;
  getSkill(name: string): Promise<SkillDetail>;
  setSkillEnabled(name: string, enabled: boolean): Promise<SkillDetail>;
  customizeSkill(name: string): Promise<SkillDetail>;
  saveSkill(input: SaveSkillRequest): Promise<SkillDetail>;
  resetSkill(name: string): Promise<{ ok: true }>;
  deleteSkill(name: string): Promise<{ ok: true }>;
}

export interface SkillsListController {
  readonly data: SettingsDataStateController<SkillsListResponse, null>;
  setScope(scope: SettingsDataScope | null): void;
  load(): Promise<SettingsLoadResult<SkillsListResponse>>;
  retry(): Promise<SettingsLoadResult<SkillsListResponse>>;
  setEnabled(name: string, enabled: boolean): Promise<SettingsMutationResult<SkillsListResponse>>;
}

export interface SkillDetailController {
  readonly data: SettingsDataStateController<SkillDetail, null>;
  setScope(scope: SettingsDataScope | null): void;
  load(name: string): Promise<SettingsLoadResult<SkillDetail>>;
  retry(name: string): Promise<SettingsLoadResult<SkillDetail>>;
  customize(): Promise<SettingsMutationResult<SkillDetail>>;
  create(input: SaveSkillRequest): Promise<SettingsMutationResult<SkillDetail>>;
  save(input: SaveSkillRequest): Promise<SettingsMutationResult<SkillDetail>>;
  reset(): Promise<SettingsMutationResult<SkillDetail>>;
  delete(): Promise<SettingsClearMutationResult>;
}

export function createSkillsListController(
  apiForScope: (scope: SettingsDataScope) => SkillsApi,
): SkillsListController {
  const data = createSettingsDataState<SkillsListResponse, null>();
  const load = (scope: SettingsDataScope): Promise<SkillsListResponse> => apiForScope(scope).listSkills();

  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load: () => data.load(load),
    retry: () => data.retryLoad(load),
    setEnabled(name, enabled) {
      const row = data.getState().data?.skills.find((skill) => skill.name === name);
      // A pristine official skill has no database row, so PATCH would be
      // false authority. It must first be customized by the server.
      if (
        !row ||
        !isMobileVisibleSkill(row) ||
        !canToggleMobileSkill(row) ||
        row.enabled === enabled ||
        data.getState().loading ||
        data.getState().mutating
      ) {
        return Promise.resolve({ status: "ignored" });
      }
      return data.mutate(
        async (scope) => { await apiForScope(scope).setSkillEnabled(row.name, enabled); },
        load,
      );
    },
  };
}

export function createSkillDetailController(
  apiForScope: (scope: SettingsDataScope) => SkillsApi,
): SkillDetailController {
  const data = createSettingsDataState<SkillDetail, null>();
  // `SettingsDataState` intentionally retains the previous data while a newer
  // read is in flight. Track the requested route identity separately so an old
  // visible detail can never be saved after navigation has moved to another
  // Skill.
  let requestedName: string | null = null;
  const load = (name: string) => (scope: SettingsDataScope): Promise<SkillDetail> =>
    apiForScope(scope).getSkill(name);

  return {
    data,
    setScope: (scope) => {
      if (!scope) requestedName = null;
      data.setScope(scope);
    },
    load: (name) => {
      requestedName = name;
      return data.load(load(name));
    },
    retry: (name) => {
      requestedName = name;
      return data.retryLoad(load(name));
    },
    customize() {
      const skill = data.getState().data;
      if (
        !skill ||
        skill.name !== requestedName ||
        !isMobileVisibleSkill(skill) ||
        mobileSkillKind(skill) !== "official-untouched" ||
        data.getState().loading ||
        data.getState().mutating
      ) {
        return Promise.resolve({ status: "ignored" });
      }
      const name = skill.name;
      return data.mutate(
        async (scope) => {
          try {
            await apiForScope(scope).customizeSkill(name);
          } catch (error) {
            // Another trusted client may have created the server copy between
            // this detail GET and Customize. The intended end state exists;
            // reload it rather than falsely leaving this screen read-only.
            if (!hasHttpStatus(error, 409)) throw error;
          }
        },
        load(name),
      );
    },
    create(input) {
      const name = input.name.trim();
      if (!name || mobileSkillRequirementsMessage(input) || data.getState().loading || data.getState().mutating) {
        return Promise.resolve({ status: "ignored" });
      }
      requestedName = name;
      return data.mutate(
        async (scope) => { await apiForScope(scope).saveSkill({ ...input, name }); },
        load(name),
      );
    },
    save(input) {
      const skill = data.getState().data;
      if (
        !skill ||
        skill.name !== requestedName ||
        !isMobileVisibleSkill(skill) ||
        !canConfigureMobileSkill(skill) ||
        mobileSkillRequirementsMessage(input) ||
        input.name !== skill.name ||
        data.getState().loading ||
        data.getState().mutating
      ) {
        return Promise.resolve({ status: "ignored" });
      }
      const name = skill.name;
      return data.mutate(
        async (scope) => { await apiForScope(scope).saveSkill(input); },
        load(name),
      );
    },
    reset() {
      const skill = data.getState().data;
      if (
        !skill ||
        skill.name !== requestedName ||
        !isMobileVisibleSkill(skill) ||
        !canResetMobileSkill(skill) ||
        data.getState().loading ||
        data.getState().mutating
      ) {
        return Promise.resolve({ status: "ignored" });
      }
      const name = skill.name;
      return data.mutate(
        async (scope) => { await apiForScope(scope).resetSkill(name); },
        load(name),
      );
    },
    delete() {
      const skill = data.getState().data;
      if (
        !skill ||
        skill.name !== requestedName ||
        !isMobileVisibleSkill(skill) ||
        !canDeleteMobileSkill(skill) ||
        data.getState().loading ||
        data.getState().mutating
      ) {
        return Promise.resolve({ status: "ignored" });
      }
      const name = skill.name;
      return data.mutateAndClear(async (scope) => { await apiForScope(scope).deleteSkill(name); });
    },
  };
}
