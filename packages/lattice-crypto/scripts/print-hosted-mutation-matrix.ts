import { existsSync } from "node:fs";
import { parseMutationManifest } from "./mutation-governance.ts";
import { createHostedMutationMatrix } from "./mutation-hosted.ts";

const manifestValue: unknown = await Bun.file(
  new URL("mutation-scopes.json", import.meta.url),
).json();
const manifest = parseMutationManifest(manifestValue, {
  fileExists: (path) =>
    existsSync(new URL(`../${path}`, import.meta.url)),
});

const matrix = createHostedMutationMatrix(manifest);
process.stdout.write(`${JSON.stringify({ scope: matrix.scope })}\n`);
