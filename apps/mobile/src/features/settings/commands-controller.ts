import type {
  CommandDetail,
  CommandListItem,
  CommandsListResponse,
  PutCommandRequest,
} from "@nautilo/api-client/browser";

import { invalidateCommandCatalogue } from "@/features/commands/command-catalogue-events";
import {
  createSettingsDataState,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "./settings-data-state";

export type MobileCommandKind = "yours" | "official-untouched" | "official-customized";

export function mobileCommandKind(command: Pick<CommandListItem, "official" | "forked">): MobileCommandKind {
  if (!command.official) return "yours";
  return command.forked ? "official-customized" : "official-untouched";
}

export function canManageMobileCommand(command: Pick<CommandListItem, "official" | "forked">): boolean {
  return mobileCommandKind(command) !== "official-untouched";
}

export function formatMobileCommandTitle(name: string): string {
  return name.split(/[-_]+/).filter(Boolean).map(
    (part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
  ).join(" ");
}

export function commandSettingsErrorMessage(error: unknown): string {
  const status = error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status : null;
  if (status === 401) return "Your session has expired. Sign in again before managing Commands.";
  if (status === 403) return "This server does not allow you to manage Commands for this Agent.";
  if (status === 404) return "This Command is no longer available. Refresh the server catalogue.";
  return error instanceof Error && error.message ? error.message : "Could not update Commands.";
}

function isConflict(error: unknown): boolean {
  return error !== null && typeof error === "object" && "status" in error
    && (error as { status?: unknown }).status === 409;
}

/** Typed shared-client boundary; the server remains authority for every mutation. */
export interface CommandsApi {
  getCommands(): Promise<CommandsListResponse>;
  getCommand(name: string): Promise<CommandDetail>;
  putCommand(input: PutCommandRequest): Promise<CommandDetail>;
  setCommandEnabled(name: string, enabled: boolean): Promise<CommandDetail>;
  customizeCommand(name: string): Promise<CommandDetail>;
  resetCommand(name: string): Promise<void>;
  deleteCommand(name: string): Promise<void>;
}

export interface CommandsListController {
  readonly data: SettingsDataStateController<CommandsListResponse, null>;
  setScope(scope: SettingsDataScope | null): void;
  load(): Promise<SettingsLoadResult<CommandsListResponse>>;
  retry(): Promise<SettingsLoadResult<CommandsListResponse>>;
  create(input: PutCommandRequest): Promise<SettingsMutationResult<CommandsListResponse>>;
  setEnabled(name: string, enabled: boolean): Promise<SettingsMutationResult<CommandsListResponse>>;
}

export interface CommandDetailController {
  readonly data: SettingsDataStateController<CommandDetail, null>;
  setScope(scope: SettingsDataScope | null): void;
  load(name: string): Promise<SettingsLoadResult<CommandDetail>>;
  retry(name: string): Promise<SettingsLoadResult<CommandDetail>>;
  save(input: PutCommandRequest): Promise<SettingsMutationResult<CommandDetail>>;
  customize(): Promise<SettingsMutationResult<CommandDetail>>;
  reset(): Promise<SettingsMutationResult<CommandDetail>>;
  remove(): Promise<SettingsMutationResult<CommandDetail>>;
}

export function createCommandsListController(
  apiForScope: (scope: SettingsDataScope) => CommandsApi,
): CommandsListController {
  const data = createSettingsDataState<CommandsListResponse, null>();
  const load = (scope: SettingsDataScope) => apiForScope(scope).getCommands();
  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load: () => data.load(load),
    retry: () => data.retryLoad(load),
    create(input) {
      if (data.getState().loading || data.getState().mutating) return Promise.resolve({ status: "ignored" });
      return data.mutate(async (scope) => {
        await apiForScope(scope).putCommand(input);
        invalidateCommandCatalogue();
      }, load);
    },
    setEnabled(name, enabled) {
      const row = data.getState().data?.commands.find((command) => command.name === name);
      if (!row || !canManageMobileCommand(row) || row.enabled === enabled || data.getState().loading || data.getState().mutating) {
        return Promise.resolve({ status: "ignored" });
      }
      return data.mutate(async (scope) => {
        await apiForScope(scope).setCommandEnabled(row.name, enabled);
        invalidateCommandCatalogue();
      }, load);
    },
  };
}

export function createCommandDetailController(
  apiForScope: (scope: SettingsDataScope) => CommandsApi,
): CommandDetailController {
  const data = createSettingsDataState<CommandDetail, null>();
  let requestedName: string | null = null;
  const load = (name: string) => (scope: SettingsDataScope) => apiForScope(scope).getCommand(name);
  const mutable = (): CommandDetail | null => {
    const command = data.getState().data;
    return command && command.name === requestedName && canManageMobileCommand(command)
      && !data.getState().loading && !data.getState().mutating ? command : null;
  };
  return {
    data,
    setScope(scope) {
      if (!scope) requestedName = null;
      data.setScope(scope);
    },
    load(name) { requestedName = name; return data.load(load(name)); },
    retry(name) { requestedName = name; return data.retryLoad(load(name)); },
    save(input) {
      const command = mutable();
      if (!command || input.name !== command.name) return Promise.resolve({ status: "ignored" });
      return data.mutate(async (scope) => {
        await apiForScope(scope).putCommand(input);
        invalidateCommandCatalogue();
      }, load(command.name));
    },
    customize() {
      const command = data.getState().data;
      if (!command || command.name !== requestedName || mobileCommandKind(command) !== "official-untouched" || data.getState().loading || data.getState().mutating) return Promise.resolve({ status: "ignored" });
      const name = command.name;
      return data.mutate(async (scope) => {
        try { await apiForScope(scope).customizeCommand(name); }
        catch (error) { if (!isConflict(error)) throw error; }
        invalidateCommandCatalogue();
      }, load(name));
    },
    reset() {
      const command = data.getState().data;
      if (!command || command.name !== requestedName || mobileCommandKind(command) !== "official-customized" || data.getState().loading || data.getState().mutating) return Promise.resolve({ status: "ignored" });
      const name = command.name;
      return data.mutate(async (scope) => {
        await apiForScope(scope).resetCommand(name);
        invalidateCommandCatalogue();
      }, load(name));
    },
    remove() {
      const command = data.getState().data;
      if (!command || command.name !== requestedName || mobileCommandKind(command) !== "yours" || data.getState().loading || data.getState().mutating) return Promise.resolve({ status: "ignored" });
      const name = command.name;
      return data.mutate(async (scope) => {
        await apiForScope(scope).deleteCommand(name);
        invalidateCommandCatalogue();
      // A personal command has no detail to reload after deletion. The list
      // and composer have already been invalidated; the route returns to list
      // on this applied result instead of turning a successful delete into a
      // false 404 failure.
      }, () => Promise.resolve(command));
    },
  };
}
