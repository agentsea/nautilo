/**
 * Build-time entrypoint used by the server Dockerfile. It deliberately writes
 * only public desired-state metadata; `instance.env` is never read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serializeAuthContract } from "./auth";

const outputPath = resolve(
  process.env["NAUTILO_AUTH_CONTRACT_OUTPUT"] ?? "/out/auth-contract.json",
);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, serializeAuthContract(), "utf8");
