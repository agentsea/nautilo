#!/usr/bin/env bun
/**
 * Compute lowercase sha256 hex for an OfficeCLI binary on disk.
 *
 * Operator helper when pinning a new release into manifest.json. Does not
 * download or mutate the vendor tree.
 *
 * Usage:
 *   bun dev/scripts/officecli/hash-file.ts /path/to/officecli
 */

import { readFileSync } from "node:fs";
import { sha256HexOfBytes } from "../../../packages/config/src/officecli/provisioning.ts";

const filePath = process.argv[2];
if (filePath === undefined || filePath.length === 0) {
  process.stderr.write("usage: bun dev/scripts/officecli/hash-file.ts <binary-path>\n");
  process.exit(1);
}

const bytes = readFileSync(filePath);
const digest = sha256HexOfBytes(bytes);
process.stdout.write(`${digest}  ${bytes.length} bytes  ${filePath}\n`);
