import type { CommandModule } from "yargs";
import Table from "cli-table3";
import {
  ApiError,
  NautiloApiClient,
  type CreateInviteInput,
  type InviteSummary,
  type InvitableRoom,
} from "@nautilo/api-client";
import {
  CliSessionExpiredError,
  CliSessionMissingError,
  requireSessionForActiveProfile,
} from "../lib/cli-session.ts";
import { readLine } from "../lib/prompts.ts";
import { apiClientOptionsFor, resolveServerForCommand } from "../lib/profile-aware-server.ts";

const ROLE_CHOICES = [
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
  "guest",
] as const;

const ASCII_BORDERS = process.env["NAUTILO_ASCII_TABLES"] === "1";

function makeTable(head: string[]): Table.Table {
  if (ASCII_BORDERS) {
    return new Table({
      head,
      chars: {
        top: "-",
        "top-mid": "+",
        "top-left": "+",
        "top-right": "+",
        bottom: "-",
        "bottom-mid": "+",
        "bottom-left": "+",
        "bottom-right": "+",
        left: "|",
        "left-mid": "+",
        mid: "-",
        "mid-mid": "+",
        right: "|",
        "right-mid": "+",
        middle: "|",
      },
      style: { head: [], border: [] },
    });
  }
  return new Table({ head, style: { head: [], border: [] } });
}

type RoleChoice = (typeof ROLE_CHOICES)[number];

export function parseDurationToMs(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const match = /^(\d+)\s*([smhd])$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = match[2];
  switch (unit) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return null;
  }
}

function truncateUuid(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function formatRoomColumn(inv: InviteSummary): string {
  if (inv.targetRoomLabel != null) return inv.targetRoomLabel;
  if (inv.targetRoomId != null) return truncateUuid(inv.targetRoomId);
  return "-";
}

function formatExpiresColumn(iso: string | null): string {
  if (iso === null) {
    return "never";
  }
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}).*$/.exec(iso);
  return m ? `${m[1]}Z` : iso;
}

async function promptRole(): Promise<RoleChoice> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const line = (
      await readLine(
        "Server Group role for the invitee [owner / admin / superuser / member / contributor / guest]: ",
      )
    )
      .trim()
      .toLowerCase();
    if ((ROLE_CHOICES as readonly string[]).includes(line)) {
      return line as RoleChoice;
    }
  }
  process.stderr.write("Invalid role.\n");
  process.exitCode = 2;
  throw new Error("invalid role");
}

async function promptRoomId(api: NautiloApiClient): Promise<string | undefined> {
  const rooms = await api.listInvitableRooms();
  if (rooms.length === 0) {
    return undefined;
  }
  const t = makeTable(["#", "label"]);
  rooms.forEach((r: InvitableRoom, i: number) => {
    t.push([String(i + 1), r.label]);
  });
  process.stdout.write(`${t.toString()}\n`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const line = (await readLine("Select room # (blank = none): ")).trim();
    if (line.length === 0) {
      return undefined;
    }
    const n = Number.parseInt(line, 10);
    if (Number.isFinite(n) && n >= 1 && n <= rooms.length) {
      return rooms[n - 1]!.roomId;
    }
  }
  process.stderr.write("Invalid selection.\n");
  process.exitCode = 2;
  throw new Error("invalid room selection");
}

async function promptMaxUses(): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const line = (await readLine("Max uses (blank = 1, 'unlimited' = no cap): ")).trim();
    if (line.length === 0) {
      return 1;
    }
    if (line.toLowerCase() === "unlimited") {
      return null;
    }
    const n = Number.parseInt(line, 10);
    if (Number.isFinite(n) && n >= 1) {
      return n;
    }
  }
  process.stderr.write("Invalid max uses.\n");
  process.exitCode = 2;
  throw new Error("invalid max uses");
}

async function promptExpiresAt(): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const line = (await readLine("Expires in (blank = never, e.g. 7d / 24h / 30m): ")).trim();
    if (line.length === 0) {
      return null;
    }
    const ms = parseDurationToMs(line);
    if (ms !== null) {
      return new Date(Date.now() + ms).toISOString();
    }
  }
  process.stderr.write("Invalid expiry duration.\n");
  process.exitCode = 2;
  throw new Error("invalid expires");
}

const createModule: CommandModule = {
  command: "create",
  describe: "Create a new server invite",
  builder: (yargs) =>
    yargs
      .option("role", {
        type: "string",
        choices: ROLE_CHOICES,
        describe: "Canonical server Group role slug for the invitee (required)",
      })
      .option("room", {
        type: "string",
        describe: "Optional target room UUID",
      })
      .option("max-uses", {
        type: "number",
        describe: "Maximum redemptions (omit for interactive default of 1)",
      })
      .option("expires-in", {
        type: "string",
        describe: "Expiry duration (e.g. 7d, 24h, 30m)",
      })
      .option("display-name", {
        type: "string",
        describe: "Optional display name for the invite",
      })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "Skip interactive wizard",
      })
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      }),
  handler: async (argv) => {
    try {
      const maxUsesFlag = argv["max-uses"] as number | undefined;
      if (maxUsesFlag !== undefined && maxUsesFlag !== null && maxUsesFlag < 1) {
        process.stderr.write("--max-uses must be >= 1\n");
        process.exitCode = 2;
        return;
      }

      const expiresInFlag = argv["expires-in"] as string | undefined;
      if (expiresInFlag !== undefined) {
        const ms = parseDurationToMs(expiresInFlag);
        if (ms === null) {
          process.stderr.write("Invalid --expires-in value (expected e.g. 7d, 24h, 30m).\n");
          process.exitCode = 2;
          return;
        }
      }

      const isInteractive = process.stdin.isTTY === true && argv["yes"] !== true;

      const session = await requireSessionForActiveProfile();
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
      api.setToken(session.accessToken);

      let role: RoleChoice | undefined;
      const roleFlag = argv["role"] as RoleChoice | undefined;
      if (roleFlag !== undefined) {
        role = roleFlag;
      } else if (isInteractive) {
        role = await promptRole();
      } else {
        process.stderr.write("missing --role\n");
        process.exitCode = 2;
        return;
      }

      let roomId: string | undefined;
      const roomFlag = argv["room"] as string | undefined;
      if (roomFlag !== undefined) {
        roomId = roomFlag.length > 0 ? roomFlag : undefined;
      } else if (isInteractive) {
        roomId = await promptRoomId(api);
      }

      let maxUses: number | null;
      if (maxUsesFlag !== undefined) {
        maxUses = maxUsesFlag;
      } else if (isInteractive) {
        maxUses = await promptMaxUses();
      } else {
        maxUses = 1;
      }

      let expiresAt: string | null;
      if (expiresInFlag !== undefined) {
        const ms = parseDurationToMs(expiresInFlag)!;
        expiresAt = new Date(Date.now() + ms).toISOString();
      } else if (isInteractive) {
        expiresAt = await promptExpiresAt();
      } else {
        expiresAt = null;
      }

      let displayName: string | null;
      const displayNameFlag = argv["display-name"] as string | undefined;
      if (displayNameFlag !== undefined) {
        displayName = displayNameFlag.length === 0 ? null : displayNameFlag;
      } else if (isInteractive) {
        const line = (await readLine("Optional display name (blank = none): ")).trim();
        displayName = line.length === 0 ? null : line;
      } else {
        displayName = null;
      }

      const input: CreateInviteInput = {
        kind: "server",
        targetGroupRoleSlug: role,
        ...(roomId !== undefined ? { targetRoomId: roomId } : {}),
        maxUses,
        ...(expiresAt !== null ? { expiresAt } : {}),
        ...(displayName !== null ? { displayName } : {}),
      };

      const result = await api.createInvite(input);

      if (argv["format"] === "json") {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const maxUsesLabel = result.maxUses === null ? "unlimited" : String(result.maxUses);
        const expiresLabel = result.expiresAt === null ? "never" : result.expiresAt;
        process.stdout.write("\nInvite created.\n\n");
        process.stdout.write(`  ${result.url}\n\n`);
        process.stdout.write(`id:         ${result.id}\n`);
        process.stdout.write(`kind:       ${result.kind}\n`);
        process.stdout.write(`maxUses:    ${maxUsesLabel}\n`);
        process.stdout.write(`expiresAt:  ${expiresLabel}\n`);
      }
      process.exitCode = 0;
    } catch (e) {
      if (process.exitCode === 2) {
        return;
      }
      if (e instanceof CliSessionMissingError || e instanceof CliSessionExpiredError) {
        process.stderr.write("Run `nautilo login` first.\n");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`${msg}\n`);
      }
      process.exitCode = 2;
    }
  },
};

const listModule: CommandModule = {
  command: "list",
  describe: "List invites created by the signed-in user",
  builder: (yargs) =>
    yargs
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      }),
  handler: async (argv) => {
    try {
      const session = await requireSessionForActiveProfile();
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
      api.setToken(session.accessToken);

      const data = await api.listMyInvites();

      if (argv["format"] === "json") {
        process.stdout.write(`${JSON.stringify(data)}\n`);
      } else if (data.invites.length === 0) {
        process.stdout.write("No invites.\n");
      } else {
        const table = makeTable([
          "ID",
          "KIND",
          "ROLE",
          "USED",
          "CAP",
          "EXPIRES",
          "REVOKED",
          "ROOM",
          "LABEL",
        ]);
        for (const inv of data.invites) {
          const cap = inv.maxUses === null ? "∞" : String(inv.maxUses);
          const expires = formatExpiresColumn(inv.expiresAt);
          const revoked = inv.revokedAt === null ? "-" : "yes";
          const role = inv.targetRoleSlug ?? "-";
          const room = formatRoomColumn(inv);
          const label = inv.displayName ?? "-";
          table.push([
            inv.id,
            inv.kind,
            role,
            String(inv.usedCount),
            cap,
            expires,
            revoked,
            room,
            label,
          ]);
        }
        process.stdout.write(`${table.toString()}\n`);
      }
      process.exitCode = 0;
    } catch (e) {
      if (e instanceof CliSessionMissingError || e instanceof CliSessionExpiredError) {
        process.stderr.write("Run `nautilo login` first.\n");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`${msg}\n`);
      }
      process.exitCode = 2;
    }
  },
};

const revokeModule: CommandModule = {
  command: "revoke <id>",
  describe: "Revoke an invite by ID",
  builder: (yargs) =>
    yargs
      .positional("id", {
        type: "string",
        describe: "UUID of the invite to revoke",
      })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "Skip interactive confirmation",
      })
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      }),
  handler: async (argv) => {
    try {
      const id = String(argv["id"]);

      if (argv["yes"] !== true) {
        if (!process.stdin.isTTY) {
          process.stderr.write("Refusing to revoke non-interactively without --yes.\n");
          process.exitCode = 2;
          return;
        }
        process.stdout.write(`About to revoke invite ${id}. This is irreversible.\n`);
        const line = (await readLine("Continue? [y/N]: ")).trim().toLowerCase();
        const ok = line === "y" || line === "yes";
        if (!ok) {
          process.stderr.write("Aborted.\n");
          process.exitCode = 2;
          return;
        }
      }

      const session = await requireSessionForActiveProfile();
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
      api.setToken(session.accessToken);

      await api.revokeInvite(id);

      if (argv["format"] === "json") {
        process.stdout.write(`${JSON.stringify({ ok: true, id })}\n`);
      } else {
        process.stdout.write(`Revoked invite ${id}.\n`);
      }
      process.exitCode = 0;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        process.stderr.write("Invite not found.\n");
        process.exitCode = 2;
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        process.stderr.write("You don't have permission to revoke that invite.\n");
        process.exitCode = 2;
        return;
      }
      if (e instanceof CliSessionMissingError || e instanceof CliSessionExpiredError) {
        process.stderr.write("Run `nautilo login` first.\n");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`${msg}\n`);
      }
      process.exitCode = 2;
    }
  },
};

export const inviteModule: CommandModule = {
  command: "invite",
  describe: "Create, list, and revoke invites",
  builder: (yargs) =>
    yargs
      .command(createModule)
      .command(listModule)
      .command(revokeModule)
      .demandCommand(1, "Specify an invite subcommand (create / list / revoke)"),
  handler: () => {},
};
