import type {
  CodexFeatureGates,
  CompatibilityResult,
} from "@nautilo/codex-app-server";
import type { Readable, Writable } from "node:stream";

export type CodexRuntimeCode =
  | "CODEX_RUNTIME_NOT_FOUND"
  | "CODEX_RUNTIME_NOT_EXECUTABLE"
  | "CODEX_RUNTIME_WRONG_ARCHITECTURE"
  | "CODEX_RUNTIME_UNHEALTHY"
  | "CODEX_RUNTIME_TIMEOUT"
  | "CODEX_RUNTIME_CANCELLED"
  | "CODEX_RUNTIME_IDENTITY_CHANGED"
  | "CODEX_RUNTIME_SCHEMA_INVALID"
  | "CODEX_RUNTIME_INCOMPATIBLE"
  | "CODEX_RUNTIME_STANDALONE_UNSUPPORTED"
  | "CODEX_RUNTIME_VERSION_INVALID"
  | "CODEX_RUNTIME_OUTPUT_LIMIT"
  | "CODEX_RUNTIME_PATH_INVALID"
  | "CODEX_RUNTIME_EXECUTABLE_LIMIT"
  | "CODEX_RUNTIME_PLATFORM_UNSUPPORTED"
  | "CODEX_RUNTIME_ARTIFACT_INVALID"
  | "CODEX_RUNTIME_SIGNATURE_INVALID"
  | "CODEX_RUNTIME_INSTALL_FAILED";
export type CodexRuntimeState =
  "ready" | "limited" | "unavailable" | "incompatible";
export type CodexRuntimeKind = "full_cli" | "standalone";
export interface CodexRuntimeDetails {
  readonly state: CodexRuntimeState;
  readonly code?: CodexRuntimeCode;
  readonly source?:
    | "configured"
    | "path"
    | "conventional"
    | "managed";
  readonly kind?: CodexRuntimeKind;
  readonly version?: string;
  readonly checkedAt: number;
  readonly compatibility?: CompatibilityResult["state"];
  readonly features?: CodexFeatureGates;
  /** Bounded structural diagnostics only; schema paths stay host-local. */
  readonly compatibilityDiagnostics?: readonly {
    readonly feature: CompatibilityResult["reasons"][number]["feature"];
    readonly reason: CompatibilityResult["reasons"][number]["code"];
  }[];
  readonly executableFingerprint?: string;
  /** Script launchers are never certified by their wrapper bytes. */
  readonly launcherFingerprint?: string;
  readonly schemaFingerprint?: string;
  readonly stableSchemaFingerprint?: string;
  readonly handle?: string;
}
export type CodexRuntimeInstallPhase =
  | "absent"
  | "resolving"
  | "downloading"
  | "verifying"
  | "staging"
  | "activating"
  | "ready"
  | "rollback"
  | "cancelled"
  | "failed";
export interface CodexRuntimeInstallState {
  readonly phase: CodexRuntimeInstallPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly canCancel: boolean;
  readonly code?: CodexRuntimeCode;
}
export type CodexRuntimePlatformKey = "darwin-arm64" | "darwin-x64";
export interface CodexRuntimeReleaseDescriptor {
  readonly platform: CodexRuntimePlatformKey;
  readonly version: string;
  readonly releaseTag: string;
  readonly url: string;
  readonly archiveName: string;
  readonly archiveBytes: number;
  readonly sha256: string;
  /** Hash of the direct app-server entrypoint after package extraction. */
  readonly entrypointSha256: string;
  readonly package: {
    readonly layoutVersion: 1;
    readonly version: string;
    readonly target: string;
    readonly variant: "codex-app-server";
    readonly entrypoint: "bin/codex-app-server";
    readonly pathDir: "codex-path";
    readonly resourcesDir: "codex-resources";
    /** The complete package file tree, pinned by relative name, byte length, and SHA-256. */
    readonly requiredMembers: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
    readonly executableMembers: readonly string[];
  };
  readonly signature: {
    readonly kind: "macos-codesign";
    readonly teamId: string;
    readonly publisherSubject: string;
  };
}
export interface CodexRuntimeReleaseManifest {
  readonly schemaVersion: 1;
  readonly cohort: "certified" | "candidate";
  readonly codexVersion: string;
  readonly releaseTag: string;
  readonly sourceRepo: "openai/codex";
  readonly artifacts: Readonly<Record<CodexRuntimePlatformKey, CodexRuntimeReleaseDescriptor>>;
}
export interface ResolveManagedCodexRuntimeOptions {
  /** An exact review-pinned catalog version; omitted means the shipped default. */
  readonly version?: string;
  readonly signal?: AbortSignal;
  readonly onState?: (state: CodexRuntimeInstallState) => void;
}
export interface ResolveExternalCodexRuntimeOptions {
  readonly configuredPath?: string;
  readonly signal?: AbortSignal;
}
export interface RuntimeFileIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly executable: boolean;
  readonly regular: boolean;
  readonly header: Uint8Array;
}
export interface RuntimeProcessResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}
export interface RuntimeProcess {
  readonly stdout: Readable;
  readonly stdin: Writable;
  readonly result: Promise<RuntimeProcessResult>;
  terminate(graceMs: number): Promise<void>;
}
export interface CodexRuntimeHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly pathEntries: readonly string[];
  readonly conventionalPaths: readonly string[];
  /** Explicit allowlist of environment values inherited by probe children. */
  readonly probeEnv: Readonly<Record<string, string>>;
  resolve(candidate: string): Promise<RuntimeFileIdentity | null>;
  /**
   * Resolve the native executable selected by the official @openai/codex
   * npm/Bun launcher. Arbitrary scripts are not admitted through this seam.
   */
  resolveOfficialLauncherTarget?(
    launcher: RuntimeFileIdentity,
  ): Promise<RuntimeFileIdentity | null>;
  executableChunks(identity: RuntimeFileIdentity): AsyncIterable<Uint8Array>;
  run(
    identity: RuntimeFileIdentity,
    argv: readonly string[],
    options: {
      readonly timeoutMs: number;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly maxOutputBytes: number;
    },
  ): Promise<RuntimeProcess>;
  createPrivateProbeRoot(): Promise<string>;
  listSchemaFiles(
    root: string,
  ): Promise<
    readonly { readonly relativePath: string; readonly bytes: Uint8Array }[]
  >;
  removePrivateProbeRoot(root: string): Promise<void>;
  now(): number;
  randomHandle(): string;
}
