import { afterEach, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createServerAdminCli,
  runServerAdminCli,
  SERVER_ADMIN_COMMAND_ALLOWLIST,
  SERVER_ADMIN_VERSION,
} from "../../src/server-admin-index.ts";
import { setActiveProfileResolver } from "../../src/lib/cli-session.ts";
import { setCliProfileFlagOverride } from "../../src/lib/profile-aware-server.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT_PATH = resolve(THIS_DIR, "../../src/server-admin-index.ts");

afterEach(() => {
  setActiveProfileResolver(null);
  setCliProfileFlagOverride(undefined);
  process.exitCode = 0;
});

describe("standalone server-admin entrypoint", () => {
  test("renders every standalone help surface without internal labels or secret example flags", async () => {
    const helpSurfaces: ReadonlyArray<readonly string[]> = [
      [],
      ["profile"], ["profile", "add"], ["profile", "list"], ["profile", "use"],
      ["profile", "current"], ["profile", "remove"], ["profile", "set"],
      ["login"], ["logout"], ["whoami"], ["change-password"], ["members"], ["members", "invite"],
      ["members", "invite", "list"], ["members", "invite", "revoke"],
      ["members", "provision"],
      ["members", "rollout"], ["members", "rollout", "plan"],
      ["members", "rollout", "apply"], ["members", "rollout", "status"],
      ["members", "rollout", "resume"],
      ["access"], ["access", "catalogue"], ["access", "effective"],
      ["access", "change"], ["access", "change", "plan"], ["access", "change", "apply"],
      ["security"], ["security", "posture"], ["security", "audit"],
      ["security", "approvals"], ["security", "approvals", "list"],
      ["security", "approvals", "revoke"],
      ["settings"], ["settings", "models"], ["settings", "context"],
      ["settings", "stenographer"], ["settings", "profile"],
      ["integrations"], ["integrations", "providers"], ["integrations", "connections"],
      ["integrations", "connections", "list"], ["integrations", "connections", "audit"],
      ["integrations", "connections", "set"], ["integrations", "connections", "remove"],
      ["integrations", "mcp"], ["integrations", "mcp", "list"],
      ["integrations", "mcp", "tools"], ["integrations", "google"],
      ["members", "list"], ["members", "show"], ["members", "disable"],
      ["members", "enable"],
      ["members", "reset-password"], ["members", "remove"],
      ["status"], ["self-update"], ["deploy"], ["claim", "resume"], ["adopt"],
      ["bootstrap", "legacy"], ["restart"], ["logs"], ["upgrade"], ["release", "plan"],
      ["backup"], ["restore"], ["destroy"], ["migrate-artifacts-to-volume"],
      ["migrate-media-to-volume"], ["host"], ["host", "adopt"], ["host", "plan"], ["host", "deploy"],
      ["host", "resume"], ["host", "inspect"], ["host", "destroy"],
    ];
    const internalLabel = /(?:\bM\d{3}\b|\bD\d{3}\b|\bISSUE-D\d+\b|\bPhase-\d+\b)/;
    const secretExampleFlag = /--(?:password|pin|[\w-]*token|api-key)\b/i;
    const originalStdoutWrite = process.stdout.write;
    const leakedStdout: unknown[] = [];

    process.stdout.write = ((...args: Parameters<typeof originalStdoutWrite>) => {
      leakedStdout.push(args[0]);
      return true;
    }) as typeof process.stdout.write;
    try {
      for (const command of helpSurfaces) {
        const help = await createServerAdminCli({ argv: command }).getHelp();
        expect(help.length, command.join(" ")).toBeGreaterThan(0);
        expect(help, command.join(" ")).toContain("nautilo");
        expect(help, command.join(" ")).not.toMatch(internalLabel);
        expect(help, command.join(" ")).not.toMatch(secretExampleFlag);
      }
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
    expect(leakedStdout).toEqual([]);
  });

  test("has the coherent Compose and hosting operator allowlist", () => {
    expect(SERVER_ADMIN_COMMAND_ALLOWLIST).toEqual([
      "profile add|use|current|list|remove|set",
      "login",
      "logout",
      "whoami",
      "change-password",
      "members invite|provision|rollout plan|apply|status|resume|list|show|disable|enable|reset-password|remove",
      "access catalogue|effective|change plan|apply",
      "security posture|audit|approvals list|revoke",
      "settings models|context|stenographer|profile",
      "integrations providers|connections list|audit|set|remove|mcp list|tools|check|enable|disable|tool|google status|configure|remove",
      "status",
      "self-update",
      "deploy",
      "claim resume",
      "adopt",
      "bootstrap legacy",
      "restart",
      "logs",
      "upgrade",
      "release plan",
      "backup",
      "restore",
      "destroy",
      "migrate-artifacts-to-volume",
      "artifacts-relocate",
      "migrate-media-to-volume",
      "host adopt|plan|deploy|upgrade|resume|inspect|destroy",
    ]);
  });

  test("nested integration help exposes every registered operator command", async () => {
    const connections = await createServerAdminCli({ argv: ["integrations", "connections"] }).getHelp();
    expect(connections).toContain("connections list");
    expect(connections).toContain("connections audit");
    expect(connections).toContain("connections set");
    expect(connections).toContain("connections remove");

    const mcp = await createServerAdminCli({ argv: ["integrations", "mcp"] }).getHelp();
    expect(mcp).toContain("mcp list");
    expect(mcp).toContain("mcp tools");
    expect(mcp).toContain("mcp check");
    expect(mcp).toContain("mcp enable");
    expect(mcp).toContain("mcp disable");
    expect(mcp).toContain("mcp tool");

    const google = await createServerAdminCli({ argv: ["integrations", "google"] }).getHelp();
    expect(google).toContain("google status");
    expect(google).toContain("google configure");
    expect(google).toContain("google remove");
  });

  test("prints help for no arguments through the injected output seam", async () => {
    const stdout: string[] = [];
    const exitCodes: number[] = [];

    await runServerAdminCli({
      argv: [],
      writeStdout: (value) => stdout.push(value),
      setExitCode: (code) => exitCodes.push(code),
    });

    const help = stdout.join("");
    expect(help).toContain("Server administration for Nautilo Compose and hosting drivers.");
    expect(help).toContain("Start here:");
    expect(help).toContain("Railway (hosted)");
    expect(help).toContain("Docker Compose");
    expect(help).toContain("https://nautilo.ai/docs/operator/quickstart");
    expect(help).toMatch(/exact resume\s+command/);
    expect(help).toContain("host");
    expect(help).toContain("profile");
    expect(help).toContain("login");
    expect(help).toContain("logout");
    expect(help).toContain("whoami");
    expect(help).toContain("upgrade");
    expect(exitCodes).toEqual([0]);
  });

  test("renders the server-admin version without executing an operator command", () => {
    const parser = createServerAdminCli({ argv: [] });
    const rendered: string[] = [];

    parser.showVersion((value) => rendered.push(value));

    expect(rendered).toEqual([SERVER_ADMIN_VERSION]);
    expect(SERVER_ADMIN_VERSION).toMatch(/^nautilo \S+ \(api \S+\)$/);
  });

  test("offers only reviewed signed additions through root completion", async () => {
    const rawCompletion: unknown = await createServerAdminCli({ argv: [] }).getCompletion([]);
    const completion = Array.isArray(rawCompletion)
      ? rawCompletion
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.split(":", 1)[0]!)
      : [];
    const commandNames = completion.map((value) => value.split(":", 1)[0]);
    expect(commandNames).toContain("login");
    expect(commandNames).toContain("logout");
    expect(commandNames).toContain("whoami");
    expect(commandNames).toContain("members");
    expect(commandNames).not.toContain("auth");
    expect(commandNames).toContain("change-password");
    expect(commandNames).not.toContain("invite");
    expect(commandNames).not.toContain("agent");
    expect(commandNames).not.toContain("setup");
  });

  test("parser failures use a fixed redacted envelope and never echo argv", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: number[] = [];
    await runServerAdminCli({
      argv: ["unknown-command-TOKEN=never-echo", "--format", "json"],
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (code) => exits.push(code),
    });
    expect(stderr).toEqual([]);
    expect(exits).toEqual([2]);
    expect(stdout).toHaveLength(1);
    const rendered = stdout[0];
    if (rendered === undefined) throw new Error("missing parser error envelope");
    expect(JSON.parse(rendered)).toEqual({
      schema: "nautilo.server-admin.v1",
      ok: false,
      error: {
        code: "invalid_command",
        message: "The command could not be processed safely. Run nautilo --help.",
      },
    });
    expect(stdout.join("")).not.toContain("unknown-command");
  });

  test("an affirmative --all/profile conflict emits one document and never enters the handler", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: number[] = [];

    await runServerAdminCli({
      argv: ["whoami", "--all", "--profile", "alpha", "--format", "json"],
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (code) => exits.push(code),
    });

    expect(stderr).toEqual([]);
    expect(exits).toEqual([2]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "null")).toEqual({
      schema: "nautilo.server-admin.v1",
      ok: false,
      error: {
        code: "invalid_command",
        message: "The command could not be processed safely. Run nautilo --help.",
      },
    });
  });

  test("does not import client UI runtime modules", async () => {
    const source = await Bun.file(ENTRYPOINT_PATH).text();
    expect(source).not.toContain('"tui"');
    expect(source).not.toContain('"setup"');
    expect(source).not.toContain('"agent"');
    expect(source).not.toContain('"invite"');
    expect(source).not.toContain('"auth"');
  });
});
