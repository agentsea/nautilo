import checkedManifest from "../../vendor/codex-runtime.manifest.json";
import type {
  CodexRuntimePlatformKey,
  CodexRuntimeReleaseDescriptor,
  CodexRuntimeReleaseManifest,
} from "./contracts.ts";

const HEX = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PLATFORM: Readonly<Record<CodexRuntimePlatformKey, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

/** Rejects unreviewed release data before it can reach an acquisition path. */
export function validateCodexRuntimeReleaseManifest(
  value: unknown,
): CodexRuntimeReleaseManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const cohort = input["cohort"];
  const version = input["codexVersion"];
  const tag = input["releaseTag"];
  const artifactsValue = input["artifacts"];
  if (
    !exactKeys(input, ["schemaVersion", "cohort", "codexVersion", "releaseTag", "sourceRepo", "artifacts"]) ||
    input["schemaVersion"] !== 1 ||
    (cohort !== "certified" && cohort !== "candidate") ||
    typeof version !== "string" ||
    !VERSION.test(version) ||
    tag !== `rust-v${version}` ||
    input["sourceRepo"] !== "openai/codex" ||
    !artifactsValue ||
    typeof artifactsValue !== "object" ||
    Array.isArray(artifactsValue)
  )
    return null;
  const artifacts = artifactsValue as Record<string, unknown>;
  const keys = Object.keys(artifacts).sort();
  if (keys.join(",") !== "darwin-arm64,darwin-x64") return null;
  const checked: Partial<Record<CodexRuntimePlatformKey, CodexRuntimeReleaseDescriptor>> = {};
  for (const platform of keys as CodexRuntimePlatformKey[]) {
    const item = artifacts[platform];
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const descriptor = item as Record<string, unknown>;
    const archiveName = descriptor["archiveName"];
    const url = descriptor["url"];
    const archiveBytes = descriptor["archiveBytes"];
    const archiveDigest = descriptor["sha256"];
    const entrypointDigest = descriptor["entrypointSha256"];
    const expectedArchive = `codex-app-server-package-${PLATFORM[platform]}.tar.gz`;
    if (
      !exactKeys(descriptor, ["platform", "version", "releaseTag", "url", "archiveName", "archiveBytes", "sha256", "entrypointSha256", "package", "signature"]) ||
      descriptor["platform"] !== platform ||
      descriptor["version"] !== version ||
      descriptor["releaseTag"] !== tag ||
      typeof archiveName !== "string" ||
      archiveName !== expectedArchive ||
      typeof url !== "string" ||
      url !== `https://github.com/openai/codex/releases/download/${tag}/${archiveName}` ||
      typeof archiveBytes !== "number" ||
      !Number.isSafeInteger(archiveBytes) ||
      archiveBytes <= 0 ||
      typeof archiveDigest !== "string" ||
      !HEX.test(archiveDigest) ||
      typeof entrypointDigest !== "string" ||
      !HEX.test(entrypointDigest)
    )
      return null;
    const packageValue = descriptor["package"];
    if (!packageValue || typeof packageValue !== "object" || Array.isArray(packageValue)) return null;
    const packageInfo = packageValue as Record<string, unknown>;
    const requiredMembers = packageInfo["requiredMembers"];
    const executableMembers = packageInfo["executableMembers"];
    // The checked v1 package layout gained this required executable in the
    // reviewed 0.146.0 release. Keep this finite release-layout boundary
    // explicit and fail closed: a new package layout must extend this
    // whitelist and its matching acquisition test before it can be admitted.
    const includesCodeModeHost = version.localeCompare("0.146.0", undefined, { numeric: true }) >= 0;
    const expectedMembers = [
      "codex-package.json",
      "bin/codex-app-server",
      ...(includesCodeModeHost ? ["bin/codex-code-mode-host"] : []),
      "codex-path/rg",
      "codex-resources/zsh/bin/zsh",
    ];
    if (
      !exactKeys(packageInfo, ["layoutVersion", "version", "target", "variant", "entrypoint", "pathDir", "resourcesDir", "requiredMembers", "executableMembers"]) ||
      packageInfo["layoutVersion"] !== 1 ||
      packageInfo["version"] !== version ||
      packageInfo["target"] !== PLATFORM[platform] ||
      packageInfo["variant"] !== "codex-app-server" ||
      packageInfo["entrypoint"] !== "bin/codex-app-server" ||
      packageInfo["pathDir"] !== "codex-path" ||
      packageInfo["resourcesDir"] !== "codex-resources" ||
      !requiredMembers || typeof requiredMembers !== "object" || Array.isArray(requiredMembers) ||
      !exactKeys(requiredMembers as Record<string, unknown>, expectedMembers) ||
      !expectedMembers.every((member) => {
        const expected = (requiredMembers as Record<string, unknown>)[member];
        return Boolean(expected) && typeof expected === "object" && !Array.isArray(expected) &&
          exactKeys(expected as Record<string, unknown>, ["bytes", "sha256"]) &&
          Number.isSafeInteger((expected as Record<string, unknown>)["bytes"]) &&
          Number((expected as Record<string, unknown>)["bytes"]) > 0 &&
          typeof (expected as Record<string, unknown>)["sha256"] === "string" &&
          HEX.test((expected as Record<string, unknown>)["sha256"] as string);
      }) ||
      !Array.isArray(executableMembers) ||
      !executableMembers.every((member): member is string => typeof member === "string") ||
      executableMembers.length !== (includesCodeModeHost ? 4 : 3) ||
      ["bin/codex-app-server", ...(includesCodeModeHost ? ["bin/codex-code-mode-host"] : []), "codex-path/rg", "codex-resources/zsh/bin/zsh"].some((member) => !executableMembers.includes(member))
    )
      return null;
    const signature = descriptor["signature"];
    if (!signature || typeof signature !== "object" || Array.isArray(signature)) return null;
    const sig = signature as Record<string, unknown>;
    const publisher = sig["publisherSubject"];
    if (
      !exactKeys(sig, ["kind", "teamId", "publisherSubject"]) ||
      sig["kind"] !== "macos-codesign" ||
      sig["teamId"] !== "2DC432GLL2" ||
      typeof publisher !== "string" ||
      publisher !== "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)"
    )
      return null;
    checked[platform] = Object.freeze({
      platform,
      version,
      releaseTag: tag,
      url,
      archiveName,
      archiveBytes,
      sha256: archiveDigest,
      entrypointSha256: entrypointDigest,
      package: Object.freeze({
        layoutVersion: 1,
        version,
        target: PLATFORM[platform],
        variant: "codex-app-server",
        entrypoint: "bin/codex-app-server",
        pathDir: "codex-path",
        resourcesDir: "codex-resources",
        requiredMembers: Object.freeze(Object.fromEntries(expectedMembers.map((member) => {
          const expected = (requiredMembers as Record<string, { bytes: number; sha256: string }>)[member]!;
          return [member, Object.freeze({ bytes: expected.bytes, sha256: expected.sha256 })];
        }))),
        executableMembers: Object.freeze([...executableMembers]),
      }),
      signature: Object.freeze({ kind: "macos-codesign", teamId: "2DC432GLL2", publisherSubject: publisher }),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    cohort,
    codexVersion: version,
    releaseTag: tag,
    sourceRepo: "openai/codex",
    artifacts: Object.freeze(checked as Record<CodexRuntimePlatformKey, CodexRuntimeReleaseDescriptor>),
  });
}

export const REVIEWED_CODEX_RUNTIME_MANIFEST = validateCodexRuntimeReleaseManifest(
  checkedManifest,
);

if (!REVIEWED_CODEX_RUNTIME_MANIFEST)
  throw new Error("invalid_checked_codex_runtime_manifest");
