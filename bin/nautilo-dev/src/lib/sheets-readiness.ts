import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fingerprintSource } from "../../../../packaging/wafflebase/artifacts.mjs";

const REQUIRED_ENGINE_FILES = [
  "browser.js",
  "browser.cjs",
  "node.js",
  "node.cjs",
  "src/index.d.ts",
  "src/node.d.ts",
] as const;

interface SheetsProvenance {
  readonly sourceSha256?: unknown;
  readonly recipeSha256?: unknown;
  readonly files?: unknown;
}

export type SheetsReadinessReason =
  | "current"
  | "missing-provenance"
  | "invalid-provenance"
  | "stale-source"
  | "stale-recipe"
  | "incomplete-artifact"
  | "corrupt-artifact";

export interface SheetsReadiness {
  readonly ready: boolean;
  readonly reason: SheetsReadinessReason;
  readonly detail: string;
}

export interface InspectSheetsReadinessOptions {
  readonly repoRoot: string;
  readonly engineDir?: string;
  readonly recipePath?: string;
  readonly fingerprint?: (repoRoot: string) => Promise<string>;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Validate the generated Sheets engine against both of its canonical inputs:
 * the owned source closure and the artifact assembly recipe. The file hashes
 * make a partially written or locally modified engine fail closed as well.
 */
export async function inspectSheetsReadiness(
  options: InspectSheetsReadinessOptions,
): Promise<SheetsReadiness> {
  const engineDir = options.engineDir
    ?? join(options.repoRoot, "packages/first-party-apps/spreadsheet/engine");
  const recipePath = options.recipePath
    ?? join(options.repoRoot, "packaging/wafflebase/artifacts.mjs");
  const provenancePath = join(engineDir, "provenance.json");
  const provenanceBytes = await readBytes(provenancePath);
  if (provenanceBytes === null) {
    return {
      ready: false,
      reason: "missing-provenance",
      detail: `missing ${provenancePath}`,
    };
  }

  let provenance: SheetsProvenance;
  try {
    provenance = JSON.parse(new TextDecoder().decode(provenanceBytes)) as SheetsProvenance;
  } catch {
    return {
      ready: false,
      reason: "invalid-provenance",
      detail: `${provenancePath} is not valid JSON`,
    };
  }

  if (
    typeof provenance.sourceSha256 !== "string"
    || typeof provenance.recipeSha256 !== "string"
    || provenance.files === null
    || typeof provenance.files !== "object"
    || Array.isArray(provenance.files)
  ) {
    return {
      ready: false,
      reason: "invalid-provenance",
      detail: `${provenancePath} is missing source, recipe, or file-hash provenance`,
    };
  }

  const files = provenance.files as Record<string, unknown>;
  for (const relativePath of Object.keys(files)) {
    if (isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      return {
        ready: false,
        reason: "invalid-provenance",
        detail: `${provenancePath} contains an unsafe artifact path`,
      };
    }
  }
  for (const required of REQUIRED_ENGINE_FILES) {
    if (typeof files[required] !== "string") {
      return {
        ready: false,
        reason: "incomplete-artifact",
        detail: `provenance does not cover required engine file ${required}`,
      };
    }
  }

  const currentSource = await (options.fingerprint ?? fingerprintSource)(options.repoRoot);
  if (provenance.sourceSha256 !== currentSource) {
    return {
      ready: false,
      reason: "stale-source",
      detail: "owned office source changed since the Sheets engine was prepared",
    };
  }

  const recipeBytes = await readBytes(recipePath);
  if (recipeBytes === null) {
    return {
      ready: false,
      reason: "stale-recipe",
      detail: `artifact recipe is missing: ${recipePath}`,
    };
  }
  if (provenance.recipeSha256 !== sha256(recipeBytes)) {
    return {
      ready: false,
      reason: "stale-recipe",
      detail: "the Sheets artifact recipe changed since the engine was prepared",
    };
  }

  for (const [relativePath, expectedHash] of Object.entries(files)) {
    if (typeof expectedHash !== "string" || relativePath.length === 0) {
      return {
        ready: false,
        reason: "invalid-provenance",
        detail: `${provenancePath} contains an invalid file-hash entry`,
      };
    }
    const artifactPath = join(engineDir, relativePath);
    const bytes = await readBytes(artifactPath);
    if (bytes === null) {
      return {
        ready: false,
        reason: "incomplete-artifact",
        detail: `generated engine file is missing: ${relativePath}`,
      };
    }
    const info = await stat(artifactPath);
    if (!info.isFile() || bytes.byteLength === 0) {
      return {
        ready: false,
        reason: "incomplete-artifact",
        detail: `generated engine file is incomplete: ${relativePath}`,
      };
    }
    if (sha256(bytes) !== expectedHash) {
      return {
        ready: false,
        reason: "corrupt-artifact",
        detail: `generated engine file hash does not match provenance: ${relativePath}`,
      };
    }
  }

  return { ready: true, reason: "current", detail: "Sheets engine provenance is current" };
}
