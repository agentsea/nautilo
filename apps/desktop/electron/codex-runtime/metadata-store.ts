import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexRuntimeDetails } from "./contracts.ts";

const MAX_SNAPSHOT_BYTES = 64 * 1024;
const STATES = new Set(["ready", "limited", "unavailable", "incompatible"]);
const CODES = new Set([
  "CODEX_RUNTIME_NOT_FOUND",
  "CODEX_RUNTIME_NOT_EXECUTABLE",
  "CODEX_RUNTIME_WRONG_ARCHITECTURE",
  "CODEX_RUNTIME_UNHEALTHY",
  "CODEX_RUNTIME_TIMEOUT",
  "CODEX_RUNTIME_CANCELLED",
  "CODEX_RUNTIME_IDENTITY_CHANGED",
  "CODEX_RUNTIME_SCHEMA_INVALID",
  "CODEX_RUNTIME_INCOMPATIBLE",
  "CODEX_RUNTIME_STANDALONE_UNSUPPORTED",
  "CODEX_RUNTIME_VERSION_INVALID",
  "CODEX_RUNTIME_OUTPUT_LIMIT",
  "CODEX_RUNTIME_PATH_INVALID",
  "CODEX_RUNTIME_EXECUTABLE_LIMIT",
  "CODEX_RUNTIME_PLATFORM_UNSUPPORTED",
  "CODEX_RUNTIME_ARTIFACT_INVALID",
  "CODEX_RUNTIME_SIGNATURE_INVALID",
  "CODEX_RUNTIME_INSTALL_FAILED",
]);
const SOURCES = new Set(["configured", "path", "conventional", "managed"]);
const KINDS = new Set(["full_cli", "standalone"]);
const COMPATIBILITY = new Set([
  "certified",
  "compatible_uncertified",
  "limited",
  "incompatible",
]);
const FEATURE_NAMES = [
  "stableConversation",
  "explicitSteer",
  "codexApprovals",
  "requestUserInput",
  "collaborationMode",
] as const;
const SNAPSHOT_FIELDS = new Set([
  "schemaVersion",
  "checkedAt",
  "state",
  "code",
  "source",
  "kind",
  "version",
  "compatibility",
  "features",
  "compatibilityDiagnostics",
  "executableFingerprint",
  "launcherFingerprint",
  "schemaFingerprint",
  "stableSchemaFingerprint",
]);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export interface CodexRuntimeSnapshot {
  readonly schemaVersion: 1;
  readonly checkedAt: number;
  readonly state: CodexRuntimeDetails["state"];
  readonly code?: CodexRuntimeDetails["code"];
  readonly source?: CodexRuntimeDetails["source"];
  readonly kind?: CodexRuntimeDetails["kind"];
  readonly version?: string;
  readonly compatibility?: CodexRuntimeDetails["compatibility"];
  readonly features?: CodexRuntimeDetails["features"];
  readonly compatibilityDiagnostics?: CodexRuntimeDetails["compatibilityDiagnostics"];
  readonly executableFingerprint?: string;
  readonly launcherFingerprint?: string;
  readonly schemaFingerprint?: string;
  readonly stableSchemaFingerprint?: string;
}
function snapshot(details: CodexRuntimeDetails): CodexRuntimeSnapshot {
  const {
    state,
    code,
    source,
    kind,
    version,
    compatibility,
    features,
    compatibilityDiagnostics,
    executableFingerprint,
    launcherFingerprint,
    schemaFingerprint,
    stableSchemaFingerprint,
    checkedAt,
  } = details;
  return {
    schemaVersion: 1,
    checkedAt,
    state,
    ...(code ? { code } : {}),
    ...(source ? { source } : {}),
    ...(kind ? { kind } : {}),
    ...(version ? { version } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(features ? { features } : {}),
    ...(compatibilityDiagnostics ? { compatibilityDiagnostics } : {}),
    ...(executableFingerprint ? { executableFingerprint } : {}),
    ...(launcherFingerprint ? { launcherFingerprint } : {}),
    ...(schemaFingerprint ? { schemaFingerprint } : {}),
    ...(stableSchemaFingerprint ? { stableSchemaFingerprint } : {}),
  };
}

function optionalMember(
  record: Readonly<Record<string, unknown>>,
  name: string,
  allowed: ReadonlySet<string>,
): boolean {
  const value = record[name];
  return (
    value === undefined || (typeof value === "string" && allowed.has(value))
  );
}

function validFeatures(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === FEATURE_NAMES.length &&
    FEATURE_NAMES.every((name) => typeof record[name] === "boolean")
  );
}

function validCompatibilityDiagnostics(value: unknown): boolean {
  const features = new Set(["core", "steer", "approvals", "request_user_input", "collaboration_modes"]);
  const reasons = new Set(["missing_member", "missing_field", "changed_field_shape"]);
  return Array.isArray(value) && value.length > 0 && value.length <= 5 && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return Object.keys(record).length === 2 &&
      typeof record["feature"] === "string" && features.has(record["feature"]) &&
      typeof record["reason"] === "string" && reasons.has(record["reason"]);
  });
}

function parseSnapshot(value: unknown): CodexRuntimeSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !SNAPSHOT_FIELDS.has(key)) ||
    record["schemaVersion"] !== 1 ||
    !Number.isSafeInteger(record["checkedAt"]) ||
    (record["checkedAt"] as number) < 0 ||
    typeof record["state"] !== "string" ||
    !STATES.has(record["state"]) ||
    !optionalMember(record, "code", CODES) ||
    !optionalMember(record, "source", SOURCES) ||
    !optionalMember(record, "kind", KINDS) ||
    !optionalMember(record, "compatibility", COMPATIBILITY) ||
    (record["version"] !== undefined &&
      (typeof record["version"] !== "string" ||
        !VERSION.test(record["version"]))) ||
    (record["features"] !== undefined && !validFeatures(record["features"])) ||
    (record["compatibilityDiagnostics"] !== undefined &&
      !validCompatibilityDiagnostics(record["compatibilityDiagnostics"]))
  )
    return null;

  for (const name of [
    "executableFingerprint",
    "launcherFingerprint",
    "schemaFingerprint",
    "stableSchemaFingerprint",
  ]) {
    const fingerprint = record[name];
    if (
      fingerprint !== undefined &&
      (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint))
    )
      return null;
  }

  const state = record["state"];
  if (state === "unavailable") {
    if (
      typeof record["code"] !== "string" ||
      record["code"] === "CODEX_RUNTIME_INCOMPATIBLE"
    )
      return null;
  } else {
    const expectedCompatibility =
      state === "ready"
        ? new Set(["certified", "compatible_uncertified"])
        : new Set([state]);
    const hasOneRuntimeFingerprint =
      Number(record["executableFingerprint"] !== undefined) +
        Number(record["launcherFingerprint"] !== undefined) ===
      1;
    const managed = record["source"] === "managed";
    if (
      record["source"] === undefined ||
      record["kind"] !== (managed ? "standalone" : "full_cli") ||
      record["version"] === undefined ||
      !expectedCompatibility.has(record["compatibility"] as string) ||
      !validFeatures(record["features"]) ||
      (!managed && (record["schemaFingerprint"] === undefined || record["stableSchemaFingerprint"] === undefined)) ||
      (managed && (record["schemaFingerprint"] !== undefined || record["stableSchemaFingerprint"] !== undefined)) ||
      !hasOneRuntimeFingerprint ||
      (state === "incompatible"
        ? record["code"] !== "CODEX_RUNTIME_INCOMPATIBLE"
        : record["code"] !== undefined)
    )
      return null;
  }

  return Object.freeze(record as unknown as CodexRuntimeSnapshot);
}

export class CodexRuntimeMetadataStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async save(details: CodexRuntimeDetails): Promise<void> {
    const pending = this.writeTail.then(() => this.saveNow(details));
    this.writeTail = pending.catch(() => undefined);
    return pending;
  }

  private async saveNow(details: CodexRuntimeDetails): Promise<void> {
    const value = JSON.stringify(snapshot(details));
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async load(): Promise<CodexRuntimeSnapshot | null> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(this.file, "r");
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return null;
      return parseSnapshot(JSON.parse(await file.readFile("utf8")));
    } catch {
      return null;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
}
