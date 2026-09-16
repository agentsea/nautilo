import { isDefaultInstanceAlias, validateNautiloInstanceIdValue } from "./instance-id";

/**
 * When `argv` contains `--instance <id>`, sets `targetEnv.NAUTILO_INSTANCE_ID`
 * to `<id>` (CLI wins over any pre-exported value). Validates the same rules
 * as runtime `NAUTILO_INSTANCE_ID`.
 *
 * Scans the full argv (use `process.argv` so Electron and other wrappers
 * still pick up flags after the executable path).
 */
export function applyInstanceArgFromArgv(
  argv: string[],
  targetEnv: NodeJS.ProcessEnv,
): void {
  let seen: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a !== "--instance") continue;
    if (seen !== null) {
      throw new Error("[nautilo] --instance may only be provided once");
    }
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) {
      throw new Error("[nautilo] --instance requires a non-empty id");
    }
    const raw = v.trim();
    if (raw === "") {
      throw new Error("[nautilo] --instance requires a non-empty id");
    }
    // Normalize "default" / "(default)" aliases to the empty string BEFORE
    // validation, matching `bin/nautilo-dev/src/lib/instance-id.ts`. Without
    // this, `--instance default` would pass validation and resolve to
    // `~/.nautilo-default/` instead of the unnamed default root.
    if (isDefaultInstanceAlias(raw)) {
      seen = "";
      targetEnv["NAUTILO_INSTANCE_ID"] = "";
      continue;
    }
    const err = validateNautiloInstanceIdValue(raw);
    if (err !== null) {
      throw new Error(`[nautilo] invalid --instance: ${err}`);
    }
    seen = raw;
    targetEnv["NAUTILO_INSTANCE_ID"] = raw;
  }
}

/**
 * Removes the first `--instance <id>` pair from argv (after
 * {@link applyInstanceArgFromArgv} has been applied). Use so subcommand
 * parsing does not treat `--instance` as the command name.
 */
export function stripInstancePairFromArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--instance") {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}
