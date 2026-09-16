import { basename } from "node:path";

const DEFAULT_INSTANCE_ALIASES = new Set(["default", "(default)"]);

function normalizeInstanceOverride(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (DEFAULT_INSTANCE_ALIASES.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

/**
 * Resolve the dev instance id using the Stack 19 per-worktree waterfall:
 * explicit option, CLI flag, env var, then cwd basename.
 */
export function resolveDevInstanceId(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { instance?: string | undefined },
): string {
  const fromOpts = normalizeInstanceOverride(opts?.instance);
  if (fromOpts !== undefined) return fromOpts;

  const fromArgv = normalizeInstanceOverride(flagValue(argv, "--instance"));
  if (fromArgv !== undefined) return fromArgv;

  const fromEnv = normalizeInstanceOverride(env["NAUTILO_INSTANCE_ID"]);
  if (fromEnv !== undefined) return fromEnv;

  // Empty-string env is the explicit "use default" signal that
  // `applyInstanceArgFromArgv` writes for `--instance default`. The pair
  // is stripped from argv before this resolver runs, so without this
  // check we fall through to the basename rule and pick up the worktree
  // name (which can fail length validation, e.g. 35-char worktrees).
  if (Object.prototype.hasOwnProperty.call(env, "NAUTILO_INSTANCE_ID")) {
    const raw = env["NAUTILO_INSTANCE_ID"];
    if (typeof raw === "string" && raw.trim() === "") return "";
  }

  const base = basename(cwd);
  if (base === "nautilo") return "";
  if (base.startsWith("nautilo-")) return base.slice("nautilo-".length);
  return base;
}
