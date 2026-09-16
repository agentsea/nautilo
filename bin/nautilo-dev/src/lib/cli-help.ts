/**
 * Tiny shared help-rendering helper for `bin/nautilo-dev` subcommands.
 *
 * Each subcommand declares ONE `HelpSpec` next to its impl; `--help` /
 * `-h` short-circuits to `formatHelp(spec)`. Flags + examples live in
 * the same structured object as the parsing logic that consumes them,
 * so a new flag means one edit (the spec gets a row) — there is no
 * separate prose paragraph to forget to update.
 *
 * Intentionally minimal: no fancy colour, no terminal-width wrap, no
 * dependency. Just enough structure to keep three subcommands
 * consistent and self-documenting. The central USAGE banner in
 * `index.ts` still owns the one-line cross-command index.
 */

export interface HelpFlag {
  /** e.g. `--instance <name>` or `--electron` */
  flag: string;
  /** One-line description. Keep <= ~80 chars. */
  description: string;
}

export interface HelpExample {
  /** Full shell invocation, e.g. `bun run dev-stack --electron`. */
  cmd: string;
  /** Optional context — what this example does. */
  desc?: string;
}

export interface HelpSpec {
  /** Bare command name, e.g. `dev-stack`. */
  name: string;
  /** One-sentence description for the top of `--help`. */
  summary: string;
  /** Usage line under the summary, e.g. `dev-stack [--instance <name>] [--electron]`. */
  usage: string;
  /** Flag table. Order is preserved. */
  flags: readonly HelpFlag[];
  /** Examples shown after the flag table. */
  examples: readonly HelpExample[];
  /** Optional extra paragraphs at the bottom (e.g. references to issue numbers, env vars). */
  notes?: readonly string[];
}

/** Detect `--help` or `-h` anywhere in args. Order-insensitive. */
export function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Render a `HelpSpec` to a multi-line string ready for `console.log`. */
export function formatHelp(spec: HelpSpec): string {
  const lines: string[] = [];
  lines.push(`${spec.name} — ${spec.summary}`);
  lines.push("");
  lines.push(`Usage: ${spec.usage}`);

  if (spec.flags.length > 0) {
    const flagColW = Math.max(8, ...spec.flags.map((f) => f.flag.length));
    lines.push("");
    lines.push("Flags:");
    for (const f of spec.flags) {
      lines.push(`  ${padRight(f.flag, flagColW)}  ${f.description}`);
    }
  }

  if (spec.examples.length > 0) {
    lines.push("");
    lines.push("Examples:");
    for (const ex of spec.examples) {
      lines.push(`  ${ex.cmd}`);
      if (ex.desc) lines.push(`    ${ex.desc}`);
    }
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push("");
    for (const note of spec.notes) {
      lines.push(note);
    }
  }

  return lines.join("\n");
}
