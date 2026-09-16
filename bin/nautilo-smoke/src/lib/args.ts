/**
 * Minimal argv parser. No dependencies.
 *
 * Supports:
 *   --flag              → { flag: true }
 *   --key=value         → { key: "value" }
 *   --key value         → { key: "value" }
 *   positional          → collected in `_`
 *
 * Usage:
 *   const args = parseArgs(process.argv.slice(3)); // skip node, script, command
 *   const platform = getString(args, "platform", "both");
 */

export interface ParsedArgs {
  readonly _: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        i++;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i += 2;
        } else {
          flags[body] = true;
          i++;
        }
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { _: positional, flags };
}

export function getString(
  args: ParsedArgs,
  key: string,
  fallback: string,
): string {
  const v = args.flags[key];
  if (typeof v === "string") return v;
  return fallback;
}
