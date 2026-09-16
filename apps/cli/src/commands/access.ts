import { readFile } from "node:fs/promises";
import type {
  AccessControlCatalogue,
  AccessControlMutationOperation,
  EffectiveAccessResponse,
} from "@nautilo/api-client";
import type { CommandModule } from "yargs";
import {
  createAuthenticatedAdminClient,
  type AuthenticatedAdminClient,
} from "../lib/authenticated-admin-client.ts";
import {
  writeServerAdminError,
  writeServerAdminSuccess,
  type ServerAdminFormat,
} from "../lib/server-admin-output.ts";

type BaseArgs = { server?: string; format: ServerAdminFormat };
type EffectiveArgs = BaseArgs & { userId?: string };
type ChangePlanArgs = BaseArgs & { file: string };
type ChangeApplyArgs = ChangePlanArgs & { fingerprint: string; yes: boolean };

export interface AccessCommandDependencies {
  authenticate(input: { serverFlag?: string }): Promise<AuthenticatedAdminClient>;
  readOperation(path: string): Promise<AccessControlMutationOperation>;
}

const DEFAULT_DEPENDENCIES: AccessCommandDependencies = {
  authenticate: (input) => createAuthenticatedAdminClient(input),
  readOperation: async (path) => JSON.parse(await readFile(path, "utf8")) as AccessControlMutationOperation,
};

function authInput(server: string | undefined): { serverFlag?: string } {
  return server === undefined ? {} : { serverFlag: server };
}

function requireRbacRead(client: AuthenticatedAdminClient): void {
  if (!client.whoami.capabilities.some((capability) =>
    capability === "manage_members"
    || capability === "manage_groups"
    || capability === "manage_roles"
  )) throw new Error("capability_denied");
}

function safe(value: string | null): string {
  return [...(value ?? "-")].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? "�" : character;
  }).join("").slice(0, 200);
}

function catalogueHuman(catalogue: AccessControlCatalogue): string[] {
  return [
    `capabilities: ${catalogue.capabilities.length}`,
    ...catalogue.capabilities.map((item) =>
      `- ${safe(item.slug)} [${safe(item.category)}]: ${safe(item.description)}`),
    `roles: ${catalogue.roles.length}`,
    ...catalogue.roles.map((role) =>
      `- ${safe(role.slug)} (${role.isSystem ? "built-in" : "custom"}) capabilities=${role.capabilitySlugs.length} groups=${role.groupCount}`),
    `groups: ${catalogue.groups.length}`,
    ...catalogue.groups.map((group) =>
      `- ${safe(group.type)} (${group.isSystem ? "built-in" : "custom"}) roles=${group.roleSlugs.join(",") || "-"} members=${group.memberCount}`),
  ];
}

function effectiveHuman(result: EffectiveAccessResponse): string[] {
  return [
    `user:        ${safe(result.user.handle ?? result.user.displayName)} (${safe(result.user.id)})`,
    `highestRole: ${safe(result.highestRole)}`,
    `groups:      ${result.groups.length}`,
    ...result.groups.map((group) =>
      `- ${safe(group.label)} (${group.isSystem ? "built-in" : "custom"}) roles=${group.roleSlugs.join(",") || "-"}`),
    `capabilities: ${result.capabilities.filter((capability) => capability.granted).length}`,
    ...result.capabilities.filter((capability) => capability.granted).map((capability) =>
      `- ${safe(capability.slug)} via ${capability.provenance.map((path) => `${safe(path.groupLabel)}→${safe(path.roleSlug)}`).join(", ")}`),
  ];
}

function stableError(error: unknown): { code: string; message: string } {
  if (error instanceof Error && error.message === "capability_denied") {
    return { code: "capability_denied", message: "The signed-in Human is not permitted to inspect RBAC administration state." };
  }
  return { code: "access_unavailable", message: "Access-control state could not be read safely from the selected server." };
}

export function createAccessModule(
  overrides: Partial<AccessCommandDependencies> = {},
): CommandModule {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return {
    command: "access",
    describe: "Inspect canonical Nautilo Groups, roles, capabilities, and effective access.",
    builder: (yargs) => yargs
      .command({
        command: "catalogue",
        describe: "List the canonical RBAC catalogue with built-in/custom distinctions.",
        builder: (child) => child.option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as BaseArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server));
            requireRbacRead(client);
            const result = await client.api.admin.accessControl.getCatalogue();
            writeServerAdminSuccess(argv.format, result, catalogueHuman(result));
            process.exitCode = 0;
          } catch (error) {
            const stable = stableError(error);
            writeServerAdminError(argv.format, stable.code, stable.message);
            process.exitCode = 2;
          }
        },
      })
      .command({
        command: "change",
        describe: "Preview or apply one canonical RBAC operation from a secret-free JSON file.",
        builder: (child) => child
          .command({
            command: "plan",
            describe: "Return authoritative checks, consequences, and a state fingerprint without writes.",
            builder: (plan) => plan
              .option("file", { type: "string", demandOption: true })
              .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: async (raw) => {
              const argv = raw as unknown as ChangePlanArgs;
              try {
                const operation = await deps.readOperation(argv.file);
                const client = await deps.authenticate(authInput(argv.server));
                requireRbacRead(client);
                const preview = await client.api.admin.accessControl.previewChange(operation);
                writeServerAdminSuccess(argv.format, preview, [
                  `operation:   ${safe(operation.kind)}`,
                  `executable:  ${String(preview.ok)}`,
                  `fingerprint: ${safe(preview.fingerprint)}`,
                  ...preview.checks.map((check) => `- ${check.passed ? "pass" : "fail"}: ${safe(check.code)}`),
                  "No changes were made.",
                ]);
                process.exitCode = preview.ok ? 0 : 2;
              } catch (error) {
                const stable = stableError(error);
                writeServerAdminError(argv.format, error instanceof SyntaxError ? "invalid_operation" : stable.code, stable.message);
                process.exitCode = 2;
              }
            },
          })
          .command({
            command: "apply",
            describe: "Apply the exact reviewed operation and fresh server fingerprint.",
            builder: (apply) => apply
              .option("file", { type: "string", demandOption: true })
              .option("fingerprint", { type: "string", demandOption: true })
              .option("yes", { type: "boolean", default: false })
              .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: async (raw) => {
              const argv = raw as unknown as ChangeApplyArgs;
              if (!argv.yes) {
                writeServerAdminError(argv.format, "confirmation_required", "RBAC apply requires --yes with the exact reviewed fingerprint.");
                process.exitCode = 2;
                return;
              }
              try {
                const operation = await deps.readOperation(argv.file);
                const client = await deps.authenticate(authInput(argv.server));
                requireRbacRead(client);
                const result = await client.api.admin.accessControl.applyChange(operation, argv.fingerprint);
                writeServerAdminSuccess(argv.format, result, [
                  `operation: ${safe(operation.kind)}`,
                  `applied:   ${String(result.applied)}`,
                  `audit:     ${String(result.auditRecorded ?? "unknown")}`,
                ]);
                process.exitCode = result.applied ? 0 : 2;
              } catch (error) {
                const stable = stableError(error);
                writeServerAdminError(argv.format, error instanceof SyntaxError ? "invalid_operation" : stable.code, stable.message);
                process.exitCode = 2;
              }
            },
          })
          .demandCommand(1, 1)
          .strict(),
        handler: () => {},
      })
      .command({
        command: "effective [user-id]",
        describe: "Show server-computed effective access and Group→Role provenance.",
        builder: (child) => child
          .positional("user-id", { type: "string" })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as EffectiveArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server));
            requireRbacRead(client);
            const userId = argv.userId ?? client.whoami.sessionUserId;
            if (!userId) throw new Error("invalid_identity");
            const result = await client.api.admin.accessControl.getEffectiveAccess(userId);
            writeServerAdminSuccess(argv.format, result, effectiveHuman(result));
            process.exitCode = 0;
          } catch (error) {
            const stable = stableError(error);
            writeServerAdminError(argv.format, stable.code, stable.message);
            process.exitCode = 2;
          }
        },
      })
      .demandCommand(1, 1)
      .strict(),
    handler: () => {},
  };
}

export const accessModule = createAccessModule();
