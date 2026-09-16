#!/usr/bin/env bun
/**
 * Thin wrapper around the `vtracer` CLI (visioncortex/vtracer).
 * Install once: `cargo install vtracer` or download a release binary and put it on PATH.
 *
 * Usage:
 *   bun run dev/tools/png-to-svg/index.ts <input.png|jpg> <output.svg> [-- ...extra vtracer flags]
 *
 * Examples:
 *   bun run dev/tools/png-to-svg/index.ts logo.png logo.svg
 *   bun run dev/tools/png-to-svg/index.ts logo.png logo.svg -- --preset bw
 *   bun run dev/tools/png-to-svg/index.ts photo.png photo.svg -- --preset photo
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function usage(): void {
  console.log(`nautilo png-to-svg (vtracer wrapper)

Usage:
  bun run dev/tools/png-to-svg/index.ts <input> <output.svg> [-- <vtracer-args...>]

Requires \`vtracer\` on your PATH:
  cargo install vtracer
  # or: https://github.com/visioncortex/vtracer/releases

Common vtracer flags (after --):
  --preset bw|poster|photo
  --colormode color|bw
  --mode pixel|polygon|spline

See: https://github.com/visioncortex/vtracer/blob/master/cmdapp/README.md
`);
}

const raw = process.argv.slice(2);
if (raw.length === 0 || raw[0] === "-h" || raw[0] === "--help") {
  usage();
  process.exit(raw.length === 0 ? 1 : 0);
}

const sep = raw.indexOf("--");
const head = sep === -1 ? raw : raw.slice(0, sep);
const tail = sep === -1 ? [] : raw.slice(sep + 1);

if (head.length < 2) {
  usage();
  process.exit(1);
}

const [inputRel, outputRel] = head;
const input = resolve(inputRel);
const output = resolve(outputRel);

if (!existsSync(input)) {
  console.error(`Input not found: ${input}`);
  process.exit(1);
}

const args = ["--input", input, "--output", output, ...tail];
const r = spawnSync("vtracer", args, {
  stdio: "inherit",
  encoding: "utf-8",
});

if (r.error && "code" in r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
  console.error(
    `Could not find \`vtracer\` on PATH.\n\nInstall:\n  cargo install vtracer\n\nOr download a binary from:\n  https://github.com/visioncortex/vtracer/releases\n`,
  );
  process.exit(127);
}

process.exit(r.status ?? 1);
