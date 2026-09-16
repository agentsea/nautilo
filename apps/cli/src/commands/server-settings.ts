import type {
  ServerContextConfig,
  ServerModelConfig,
  ServerProfile,
  StenographerAdminStatus,
  StenographerProtectionStatus,
  ReflectionAdminStatus,
} from "@nautilo/api-client";
import { ApiError } from "@nautilo/api-client";
import type { CommandModule } from "yargs";
import { createAuthenticatedAdminClient, type AuthenticatedAdminClient } from "../lib/authenticated-admin-client.ts";
import { writeServerAdminError, writeServerAdminSuccess, type ServerAdminFormat } from "../lib/server-admin-output.ts";

type BaseArgs = { server?: string; format: ServerAdminFormat };
type ModelsArgs = BaseArgs & { action?: "show" | "set"; defaultChatModel?: string; conductorModel?: string; stenographerModel?: string; reflectionModel?: string; fallback?: string[]; yes: boolean };
type ContextArgs = BaseArgs & { action?: "show" | "set"; recentConversationLimit?: number; minimumFullTurns?: number; maxRoomContextPercent?: number; stenographerPriorConversationLimit?: number; yes: boolean };
type ProfileArgs = BaseArgs & { action?: "show" | "set"; name?: string; description?: string; clearDescription: boolean; visibility?: "public" | "members"; yes: boolean };

export interface ServerSettingsDependencies {
  authenticate(input: { serverFlag?: string }): Promise<AuthenticatedAdminClient>;
}

const DEFAULT_DEPENDENCIES: ServerSettingsDependencies = {
  authenticate: (input) => createAuthenticatedAdminClient(input),
};

function authInput(server: string | undefined): { serverFlag?: string } {
  return server === undefined ? {} : { serverFlag: server };
}

function safe(value: string | null | undefined): string {
  return [...(value ?? "-")].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? "�" : character;
  }).join("").slice(0, 300);
}

function requireCapability(client: AuthenticatedAdminClient, capability: string): void {
  if (!client.whoami.capabilities.includes(capability)) throw new ApiError(403, "forbidden");
}

function stableError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError && error.status === 403) return { code: "capability_denied", message: "The signed-in Human is not permitted to manage server settings." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { code: "policy_rejected", message: "The server rejected the proposed policy values." };
  return { code: "server_settings_unavailable", message: "Server settings could not be completed safely." };
}

function modelsHuman(value: ServerModelConfig): string[] {
  return [
    `defaultChat:  ${safe(value.defaultChatModel)}`,
    `conductor:    ${safe(value.conductorModel || "inherit default")}`,
    `stenographer: ${safe(value.stenographerModel || "inherit default")}`,
    `reflection:   ${safe(value.reflectionModel || "inherit Stenographer")}`,
    `fallbacks:    ${value.fallbackChain.map(safe).join(", ") || "none"}`,
  ];
}

function contextHuman(value: ServerContextConfig): string[] {
  return [
    `recent conversations:       ${value.recentConversationLimit}`,
    `minimum full turns:         ${value.minimumFullTurns}`,
    `maximum room context:       ${value.maxRoomContextPercent}%`,
    `Stenographer prior context: ${value.stenographerPriorConversationLimit}`,
    `passive recall:             ${value.passiveRecallEnabled ? "on" : "off"}`,
    `Reflection Sleep:           ${value.reflectionSleepEnabled ? "on" : "off"}`,
  ];
}

function profileHuman(value: ServerProfile): string[] {
  return [
    `name:        ${safe(value.name)}`,
    `description: ${safe(value.description)}`,
    `visibility:  ${safe(value.descriptionVisibility)}`,
    `icon:        ${safe(value.icon.kind)} (${safe("id" in value.icon ? value.icon.id : value.icon.blobId)})`,
  ];
}

function stenographerHuman(value: StenographerAdminStatus): string[] {
  return [
    `health:       ${safe(value.health)}`,
    `generatedAt:  ${safe(value.generatedAt)}`,
    `eligible:     ${value.current.eligibleRooms}`,
    `caught up:    ${value.current.caughtUpRooms}`,
    `due:          ${value.current.dueRooms}`,
    `recent errors:${value.last24h.extractionBatchesWithErrors}`,
    ...(value.health === "healthy" ? [] : ["Recovery: inspect provider readiness and recent typed failure codes; no repair was attempted."]),
  ];
}

function stenographerProtectionHuman(
  value: StenographerProtectionStatus | null,
): string[] {
  if (value === null) return ["protection:   protection status unavailable"];
  return [
    `waiting device:${value.queue.current.waitingForDevice}`,
    `waiting auth:  ${value.authorityWait.extractionRooms} extraction, ${value.authorityWait.compactionRooms} compaction`,
    `encrypted 24h: ${value.queue.last24h.protectedCompleted}`,
    `repaired 24h:  ${value.queue.last24h.outputRepairCompleted}`,
    `missing:       ${value.plaintextFallback.missingProtection.extractionBatches} extraction, ${value.plaintextFallback.missingProtection.compactionRollups} compaction`,
  ];
}

function reflectionHuman(value: ReflectionAdminStatus): string[] {
  return [
    `health:       ${safe(value.health)}`,
    `scheduler:    ${safe(value.scheduler.state)}`,
    `pause reason: ${safe(value.scheduler.pauseReason)}`,
    `next poll:    ${safe(value.scheduler.nextEligiblePollAt)}`,
    `generatedAt:  ${safe(value.generatedAt)}`,
    `records:      ${value.current.totalRecords}`,
    `backlog:      ${value.current.backlog}`,
    `processing:   ${value.current.claimed}`,
    `deferred:     ${value.current.deferred}`,
    `quarantined:  ${value.current.quarantined}`,
    `recoverable:  ${value.current.recoveryEligible}`,
    `nextRecovery:${safe(value.nextRecoveryAt)}`,
    `completed 24h:${value.last24h.completedWork}`,
    `parents 24h:  ${value.last24h.syntheticParentsCreated}`,
    `last complete:${safe(value.lastCompletedAt)}`,
    ...(value.health === "healthy"
      ? []
      : ["Recovery: inspect provider readiness and current typed failure codes; no repair was attempted."]),
  ];
}

export function createServerSettingsModule(overrides: Partial<ServerSettingsDependencies> = {}): CommandModule {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return {
    command: "settings",
    describe: "Inspect and change bounded server policy and public identity.",
    builder: (root) => root
      .command({
        command: "models [action]",
        describe: "Show or change server-wide model policy.",
        builder: (child) => child
          .positional("action", { choices: ["show", "set"] as const, default: "show" })
          .option("default-chat-model", { type: "string" })
          .option("conductor-model", { type: "string" })
          .option("stenographer-model", { type: "string" })
          .option("reflection-model", { type: "string" })
          .option("fallback", { type: "array", string: true })
          .option("yes", { type: "boolean", default: false })
          .option("format", { choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as ModelsArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server));
            requireCapability(client, argv.action === "set" ? "manage_server_settings" : "read_server_settings");
            const current = await client.api.admin.serverModels.get();
            if ((argv.action ?? "show") === "show") {
              writeServerAdminSuccess(argv.format, { current, source: "server", complete: true }, modelsHuman(current));
            } else {
              if (!argv.yes) throw new Error("confirmation_required");
              const proposed = {
                ...(argv.defaultChatModel === undefined ? {} : { defaultChatModel: argv.defaultChatModel }),
                ...(argv.conductorModel === undefined ? {} : { conductorModel: argv.conductorModel }),
                ...(argv.stenographerModel === undefined ? {} : { stenographerModel: argv.stenographerModel }),
                ...(argv.reflectionModel === undefined ? {} : { reflectionModel: argv.reflectionModel }),
                ...(argv.fallback === undefined ? {} : { fallbackChain: argv.fallback }),
              };
              const applied = await client.api.admin.serverModels.set(proposed);
              const verified = await client.api.admin.serverModels.get();
              writeServerAdminSuccess(argv.format, { previous: current, proposed, applied, current: verified, stateChanged: JSON.stringify(current) !== JSON.stringify(verified) }, modelsHuman(verified));
            }
            process.exitCode = 0;
          } catch (error) {
            const stable = error instanceof Error && error.message === "confirmation_required"
              ? { code: "confirmation_required", message: "Server policy mutation requires --yes after reviewing current values." }
              : stableError(error);
            writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2;
          }
        },
      })
      .command({
        command: "context [action]",
        describe: "Show or change bounded Room context policy.",
        builder: (child) => child
          .positional("action", { choices: ["show", "set"] as const, default: "show" })
          .option("recent-conversation-limit", { type: "number" })
          .option("minimum-full-turns", { type: "number" })
          .option("max-room-context-percent", { type: "number" })
          .option("stenographer-prior-conversation-limit", { type: "number" })
          .option("yes", { type: "boolean", default: false })
          .option("format", { choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as ContextArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server));
            requireCapability(client, argv.action === "set" ? "manage_server_settings" : "read_server_settings");
            const current = await client.api.admin.serverContext.get();
            if ((argv.action ?? "show") === "show") writeServerAdminSuccess(argv.format, { current, source: "server", complete: true }, contextHuman(current));
            else {
              if (!argv.yes) throw new Error("confirmation_required");
              const proposed: ServerContextConfig = {
                recentConversationLimit: argv.recentConversationLimit ?? current.recentConversationLimit,
                minimumFullTurns: argv.minimumFullTurns ?? current.minimumFullTurns,
                maxRoomContextPercent: argv.maxRoomContextPercent ?? current.maxRoomContextPercent,
                stenographerPriorConversationLimit: argv.stenographerPriorConversationLimit ?? current.stenographerPriorConversationLimit,
                passiveRecallEnabled: current.passiveRecallEnabled,
                reflectionSleepEnabled: current.reflectionSleepEnabled,
                memoryReviewEnabled: current.memoryReviewEnabled,
              };
              const applied = await client.api.admin.serverContext.set(proposed);
              const verified = await client.api.admin.serverContext.get();
              writeServerAdminSuccess(argv.format, { previous: current, proposed, applied, current: verified, stateChanged: JSON.stringify(current) !== JSON.stringify(verified) }, contextHuman(verified));
            }
            process.exitCode = 0;
          } catch (error) {
            const stable = error instanceof Error && error.message === "confirmation_required"
              ? { code: "confirmation_required", message: "Server policy mutation requires --yes after reviewing current values." }
              : stableError(error);
            writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2;
          }
        },
      })
      .command({
        command: "stenographer",
        describe: "Show content-free Stenographer health and recovery guidance.",
        builder: (child) => child.option("format", { choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as BaseArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server)); requireCapability(client, "read_server_settings");
            const status = await client.api.admin.stenographerStatus.get();
            let protectionStatus: StenographerProtectionStatus | null = null;
            let protectionStatusUnavailable = false;
            try {
              protectionStatus = await client.api.admin.stenographerStatus.getProtection();
            } catch (error) {
              if (!(error instanceof ApiError && (error.status === 404 || error.status === 503))) {
                throw error;
              }
              protectionStatusUnavailable = true;
            }
            writeServerAdminSuccess(
              argv.format,
              {
                status,
                protectionStatus,
                protectionStatusUnavailable,
                completeness: "bounded",
                recentFailureLimit: 5,
              },
              [...stenographerHuman(status), ...stenographerProtectionHuman(protectionStatus)],
            );
            process.exitCode = 0;
          } catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
        },
      })
      .command({
        command: "reflection",
        describe: "Show content-free Reflection/Sleep health and recovery guidance.",
        builder: (child) => child.option("format", { choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as BaseArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server)); requireCapability(client, "read_server_settings");
            const status = await client.api.admin.reflectionStatus.get();
            writeServerAdminSuccess(argv.format, { status, completeness: "bounded", currentFailureLimit: 5 }, reflectionHuman(status)); process.exitCode = 0;
          } catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
        },
      })
      .command({
        command: "profile [action]",
        describe: "Show or change the selected server's public identity.",
        builder: (child) => child
          .positional("action", { choices: ["show", "set"] as const, default: "show" })
          .option("name", { type: "string" })
          .option("description", { type: "string" })
          .option("clear-description", { type: "boolean", default: false, conflicts: "description" })
          .option("visibility", { choices: ["public", "members"] as const })
          .option("yes", { type: "boolean", default: false })
          .option("format", { choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as ProfileArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server));
            requireCapability(client, argv.action === "set" ? "manage_server_settings" : "read_server_settings");
            const current = await client.api.getServerProfile();
            if (!current) throw new Error("unsupported_server");
            if ((argv.action ?? "show") === "show") writeServerAdminSuccess(argv.format, { current, selectedServer: client.transport.baseUrl }, profileHuman(current));
            else {
              if (!argv.yes) throw new Error("confirmation_required");
              const proposed = {
                ...(argv.name === undefined ? {} : { name: argv.name }),
                ...(argv.description === undefined && !argv.clearDescription ? {} : { description: argv.clearDescription ? null : argv.description }),
                ...(argv.visibility === undefined ? {} : { descriptionVisibility: argv.visibility }),
              };
              const applied = await client.api.updateServerProfile(proposed);
              const verified = await client.api.getServerProfile();
              if (!verified) throw new Error("unsupported_server");
              writeServerAdminSuccess(argv.format, { previous: current, proposed, applied, current: verified, selectedServer: client.transport.baseUrl, stateChanged: JSON.stringify(current) !== JSON.stringify(verified) }, profileHuman(verified));
            }
            process.exitCode = 0;
          } catch (error) {
            const stable = error instanceof Error && error.message === "confirmation_required"
              ? { code: "confirmation_required", message: "Server identity mutation requires --yes after reviewing current values." }
              : stableError(error);
            writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2;
          }
        },
      })
      .demandCommand(1, 1).strict(),
    handler: () => {},
  };
}

export const serverSettingsModule = createServerSettingsModule();
