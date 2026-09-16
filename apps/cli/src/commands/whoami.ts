import type { CommandModule } from "yargs";
import { listCliSessions, pickHighestRoleSlug } from "@nautilo/api-client";
import {
  AuthenticatedAdminClientError,
  createAuthenticatedAdminClient,
} from "../lib/authenticated-admin-client.ts";
import {
  writeServerAdminError,
  writeServerAdminSuccess,
  type ServerAdminFormat,
} from "../lib/server-admin-output.ts";

function formatOf(argv: Record<string, unknown>): ServerAdminFormat {
  return argv["format"] === "json" ? "json" : "human";
}

function errorFor(error: unknown): { code: string; message: string } {
  if (error instanceof AuthenticatedAdminClientError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "identity_unavailable",
    message: "The CLI identity could not be read safely. Run nautilo login or inspect the local session store.",
  };
}

export const whoamiModule: CommandModule = {
  command: "whoami",
  describe: "Print the verified signed-in Human identity.",
  builder: (yargs) =>
    yargs
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .option("all", {
        type: "boolean",
        default: false,
        describe: "List cached profile sessions locally; does not contact a server.",
      })
      .check((argv) => {
        // yargs' declarative `conflicts()` treats a defaulted false boolean as
        // present, which rejects every ordinary profile-scoped whoami. Only
        // the affirmative local enumeration mode conflicts with a profile.
        if (argv["all"] === true && typeof argv["profile"] === "string") {
          throw new Error("whoami --all cannot be combined with --profile");
        }
        return true;
      }),
  handler: async (argv) => {
    const format = formatOf(argv as Record<string, unknown>);
    try {
      if (argv["all"] === true) {
        const sessions = await listCliSessions();
        const rows = sessions.map(({ profileName, payload }) => ({
          profile: profileName,
          instanceId: payload.instanceId,
          handle: payload.handle,
          displayName: payload.displayName,
          ...(payload.actorRole ? { actorRole: payload.actorRole } : {}),
          expiresAt: payload.expiresAt,
          ...(payload.targetBinding ? { target: payload.targetBinding } : {}),
        }));
        writeServerAdminSuccess(
          format,
          { sessions: rows },
          rows.length === 0
            ? ["No cached profile sessions."]
            : rows.map((row) => `${row.profile}  ${row.handle}  (role: ${row.actorRole ?? "?"})  expires ${new Date(row.expiresAt).toISOString()}`),
        );
        process.exitCode = 0;
        return;
      }

      const client = await createAuthenticatedAdminClient({
        serverFlag: argv["server"] as string | undefined,
      });
      const groups = [...client.whoami.groups]
        .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
        .map((group) => ({ id: group.id, type: group.type, label: group.label, roleSlug: group.roleSlug }));
      const capabilities = [...client.whoami.capabilities].sort((a, b) => a.localeCompare(b));
      const highestRole = client.whoami.highestRole ?? pickHighestRoleSlug(groups);
      const data = {
        ...(client.profileName ? { profile: client.profileName } : {}),
        instanceId: client.whoami.instanceId,
        server: client.transport.baseUrl,
        // These are verified identity fields, not cache-repaired display
        // fields. A null from the fresh server response must remain visible.
        handle: client.whoami.handle,
        displayName: client.whoami.displayName,
        externalId: client.whoami.externalId,
        highestRole,
        groups,
        capabilities,
        mustChangePassword: client.whoami.mustChangePassword,
        expiresAt: client.identity.expiresAt,
      };
      writeServerAdminSuccess(
        format,
        data,
        [
          `handle:       ${data.handle}`,
          `displayName:  ${data.displayName}`,
          `groups:       ${groups.map((g) => `${g.label} (${g.roleSlug})`).join(", ") || "(none)"}`,
          `highestRole:  ${highestRole}`,
          `capabilities: ${capabilities.join(", ") || "(none)"}`,
          `instance:     ${data.instanceId}`,
          `server:       ${data.server}`,
          `expires:      ${new Date(data.expiresAt).toISOString()}`,
        ],
      );
      process.exitCode = 0;
    } catch (error) {
      const stable = errorFor(error);
      writeServerAdminError(format, stable.code, stable.message);
      process.exitCode = 2;
    }
  },
};
