import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

const repoRoot = join(import.meta.dir, "../../..");
const upstreamPath = join(repoRoot, "native/apply-patch/UPSTREAM.toml");
const licensePath = join(repoRoot, "native/apply-patch/LICENSE");
const noticePath = join(repoRoot, "native/apply-patch/NOTICE");
const cargoLockPath = join(repoRoot, "native/apply-patch/Cargo.lock");
const buildScriptPath = join(repoRoot, "native/apply-patch/build.rs");
const runtimeLibraryPath = join(repoRoot, "native/apply-patch/src/lib.rs");
const protocolPath = join(repoRoot, "native/apply-patch/src/protocol.rs");
const rootNoticesPath = join(repoRoot, "THIRD_PARTY_NOTICES.md");

const PINNED_REVISION = "3389fa554e953d07a12a34f5681aae46f17958f8";
const EXPECTED_HASHES = {
  license_sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
  notice_sha256: "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
  parser_full_sha256: "9a3bc092dd27b4e040bc01b6b4e0b066ef78580db93b31924e47613bd8442e11",
  parser_selected_segment_sha256: "434f409d2c4415ada839fbd045091eb0532c4a72c00310594a94672d45e03481",
  seek_sequence_full_sha256: "65d8e699fc3b12a8c631c49d7bdd8e55c124c235695c7a0db02853bcdcd3715c",
  seek_sequence_selected_segment_sha256: "92469c9e421be2c1a827c6cd4b8876a2a69db4ab36dbe101802df71772743038",
  lib_full_sha256: "0831a445ccfb5846477ea6878e0b797e2fc85852d1e2f5335e0607df3821435d",
  lib_normalization_segment_sha256: "9e1dadd7056c131b4e7b599077b88f0bbb59a8f1b6f6d48f1ab4e03d526c1805",
  lib_compute_replacements_segment_sha256: "65f53f0c34b871762688ce443533fd60f0ac54222488e42d3f5ec06a9c06344b",
  lib_apply_replacements_segment_sha256: "14df55cf27fbd058ebc54b0dafdf416ada1e8d61bf513936fedd6f48088b5ef9",
  scenarios_git_tree: "5ce1d30cb1ebbce5c7d001b56b8f8fdb78a2fba6",
  scenarios_git_archive_sha256: "26d465b5e65864e488fa40decc8fc86b54c62104fe59bccc680b6ca99faecf4a",
} as const;

const EXPECTED_SCENARIOS = [
  "001_add_file",
  "002_multiple_operations",
  "003_multiple_chunks",
  "004_move_to_new_directory",
  "005_rejects_empty_patch",
  "006_rejects_missing_context",
  "007_rejects_missing_file_delete",
  "008_rejects_empty_update_hunk",
  "009_requires_existing_file_for_update",
  "010_move_overwrites_existing_destination",
  "011_add_overwrites_existing_file",
  "012_delete_directory_fails",
  "013_rejects_invalid_hunk_header",
  "014_update_file_appends_trailing_newline",
  "015_failure_after_partial_success_leaves_changes",
  "016_pure_addition_update_chunk",
  "017_whitespace_padded_hunk_header",
  "018_whitespace_padded_patch_markers",
  "019_unicode_simple",
  "020_delete_file_success",
  "020_whitespace_padded_patch_marker_lines",
  "021_update_file_deletion_only",
  "022_update_file_end_of_file_marker",
] as const;

const EXPECTED_EXTRACTED_SOURCES = [
  ["codex-rs/apply-patch/src/parser.rs", "b3b2337c392e16efb95aeae48b8855573ccbb498", "1-465", "native/apply-patch/src/parser.rs"],
  ["codex-rs/apply-patch/src/seek_sequence.rs", "3555963120ec54191c2e0ad2513ca431639e89d2", "1-110", "native/apply-patch/src/seek_sequence.rs"],
  ["codex-rs/apply-patch/src/lib.rs", "29d42e1c072b95690750d85c6f32f326507bcf38", "667-681", "native/apply-patch/src/engine.rs"],
  ["codex-rs/apply-patch/src/lib.rs", "29d42e1c072b95690750d85c6f32f326507bcf38", "691-778", "native/apply-patch/src/engine.rs"],
  ["codex-rs/apply-patch/src/lib.rs", "29d42e1c072b95690750d85c6f32f326507bcf38", "783-806", "native/apply-patch/src/engine.rs"],
] as const;

const EXPECTED_CARGO_DEPENDENCIES = [
  ["itoa", "1.0.18", "MIT OR Apache-2.0", "8f42a60cbdf9a97f5d2305f08a87dc4e09308d1276d28c869c684d7777685682"],
  ["memchr", "2.8.3", "Unlicense OR MIT", "cf8baf1c55e62ffcace7a9f06f4bd9cd3f0c4beb022d3b367256b91b87513d98"],
  ["proc-macro2", "1.0.107", "MIT OR Apache-2.0", "985e7ec9bb745e6ce6535b544d84d6cd6f7ad8bd711c398938ae983b91a766d9"],
  ["quote", "1.0.47", "MIT OR Apache-2.0", "1fbf4db142a473a8d80c26bbf18454ed458bf8d26c8219c331daecfdbd079001"],
  ["serde", "1.0.229", "MIT OR Apache-2.0", "4148590afebada386688f18773da617792bf2ef03ffc1e4cbd2b1d45b023e0ba"],
  ["serde_core", "1.0.229", "MIT OR Apache-2.0", "67dca2c9c51e58a4791a4b1ed58308b39c64224d349a935ab5039aa360942a48"],
  ["serde_derive", "1.0.229", "MIT OR Apache-2.0", "e7a5d71263a5a7d47b41f6b3f06ba276f10cc18b0931f1799f710578e2309348"],
  ["serde_json", "1.0.151", "MIT OR Apache-2.0", "c841b55ecdae098c80dcae9cf767f6f8a0c2cdb3416bbef72181df4d0fe73f14"],
  ["syn", "3.0.3", "MIT OR Apache-2.0", "53e9bae58849f64dfa4f5d5ae372c8341f7305f82a3868709269343628b659a3"],
  ["unicode-ident", "1.0.24", "(MIT OR Apache-2.0) AND Unicode-3.0", "e6e4313cd5fcd3dad5cafa179702e2b244f760991f45397d14d4ebf38247da75"],
  ["zmij", "1.0.23", "MIT", "29666d0abbfad1e3dc4dcf6144730dd3a3ab225bbbdac83319345b1b44ccfc1b"],
] as const;

const EXPECTED_INTERNAL_PACKAGES = [
  "codex-api", "codex-app-server-protocol", "codex-apply-patch", "codex-async-utils", "codex-client", "codex-exec-server", "codex-execpolicy", "codex-experimental-api-macros", "codex-file-system", "codex-network-proxy", "codex-protocol", "codex-sandboxing", "codex-shell-command", "codex-utils-absolute-path", "codex-utils-cache", "codex-utils-home-dir", "codex-utils-image", "codex-utils-pty", "codex-utils-rustls-provider", "codex-utils-string",
] as const;

const EXPECTED_EXTERNAL_DEPENDENCIES = [
  "anyhow", "arc-swap", "async-channel", "async-trait", "axum", "base64", "bytes", "chardetng", "chrono", "clap", "dirs", "dunce", "encoding_rs", "eventsource-stream", "filedescriptor", "futures", "globset", "http", "icu_decimal", "icu_locale_core", "icu_provider", "image", "inventory", "landlock", "lazy_static", "libc", "log", "lru", "mime_guess", "multimap", "once_cell", "opentelemetry", "portable-pty", "proc-macro2", "prost", "quick-xml", "quote", "rama-core", "rama-http", "rama-http-backend", "rama-net", "rama-socks5", "rama-tcp", "rama-tls-rustls", "rama-unix", "rand", "regex", "regex-lite", "reqwest", "rmcp", "rustls", "rustls-native-certs", "rustls-pki-types", "schemars", "seccompiler", "serde", "serde_json", "serde_with", "sha1", "sha2", "shared_library", "shlex", "similar", "starlark", "strum", "strum_macros", "syn", "sys-locale", "thiserror", "time", "tokio", "tokio-tungstenite", "tokio-util", "toml", "tracing", "tracing-opentelemetry", "tree-sitter", "tree-sitter-bash", "ts-rs", "tungstenite", "url", "uuid", "which", "wildmatch", "winapi", "zstd",
] as const;

type Scenario = { id: string; classification: string };
type ExtractedSource = { upstream_path: string; upstream_blob: string; source_lines: string; destination: string; symbols: string[] };
type Provenance = {
  upstream: { revision: string; standalone_entrypoint: string; license: string };
  hashes: Record<string, string>;
  extracted_sources: ExtractedSource[];
  portable_scenario_source: { archive_sha256_method: string };
  portable_scenarios: Scenario[];
  standalone_rejection: { measured_internal_codex_crates: number; measured_direct_external_dependency_names: number; measurement_method: string; upstream_standalone_blob: string; upstream_standalone_sha256: string; forbidden_upstream_paths: string[]; forbidden_upstream_dependencies: string[]; internal_packages: string[]; external_dependencies: string[] };
  artifact_dependencies: { name: string; version: string; license: string; scope: string }[];
  cargo_dependencies: { name: string; version: string; license: string; checksum: string }[];
  toolchain: { rust_toolchain: string; edition: string };
  nautilo_extraction: { provenance_handshake: string; provenance_handshake_guarantee: string; extraction_revision_method: string };
  protocol: { name: string; output: string };
  update_policy: { ordinary_builds_immutable: boolean; required_review: string[] };
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadProvenance(): Provenance {
  return parseToml(readFileSync(upstreamPath, "utf8")) as unknown as Provenance;
}

describe("D448 apply-patch provenance boundary", () => {
  test("pins the reviewed Codex revision, all required hashes, and Apache obligations", () => {
    const provenance = loadProvenance();

    expect(provenance.upstream.revision).toBe(PINNED_REVISION);
    expect(provenance.upstream.standalone_entrypoint).toBe(
      "codex-rs/apply-patch/src/standalone_executable.rs",
    );
    expect(provenance.upstream.license).toBe("Apache-2.0");
    expect(provenance.hashes).toMatchObject(EXPECTED_HASHES);
    expect(sha256(licensePath)).toBe(EXPECTED_HASHES.license_sha256);
    expect(sha256(noticePath)).toBe(EXPECTED_HASHES.notice_sha256);
    expect(sha256(cargoLockPath)).toBe("4d1e7759fb6b28b8333dc1cb7cb3eae08b0863dae7dbec5bb6cdc41a3aaf2576");

    const notices = readFileSync(rootNoticesPath, "utf8");
    expect(notices).toContain("OpenAI Codex apply-patch extraction");
    expect(notices).toContain(PINNED_REVISION);
    expect(notices).toContain("Apache-2.0");
    expect(notices).toContain("Nautilo modification notices");
  });

  test("contains only the reviewed extraction, not Codex's execution stack", () => {
    const provenance = loadProvenance();

    expect(provenance.extracted_sources.map((source) => [
      source.upstream_path,
      source.upstream_blob,
      source.source_lines,
      source.destination,
    ])).toEqual(EXPECTED_EXTRACTED_SOURCES);
    expect(provenance.extracted_sources[2]?.symbols).toEqual([
      "newline normalization after replacement planning",
    ]);
    expect(provenance.extracted_sources[3]?.symbols).toEqual([
      "compute_replacements",
    ]);
    expect(provenance.extracted_sources[4]?.symbols).toEqual([
      "apply_replacements",
    ]);
    expect(provenance.standalone_rejection.measured_internal_codex_crates).toBe(20);
    expect(provenance.standalone_rejection.measured_direct_external_dependency_names).toBe(86);
    expect(provenance.standalone_rejection.measurement_method).toBe(
      "Declared non-dev build/target dependency traversal from codex-apply-patch; this is not a feature-resolved compiled graph.",
    );
    expect(provenance.standalone_rejection.upstream_standalone_blob).toBe(
      "45ca0d0619c0b39030ed634690dde9f69c228a1c",
    );
    expect(provenance.standalone_rejection.upstream_standalone_sha256).toBe(
      "f5d23525dbe3795f512e1c0f168fb154f6cae1515be1e391d5a948f9df4e6f52",
    );
    expect(provenance.standalone_rejection.forbidden_upstream_paths).toEqual(
      expect.arrayContaining([
        "codex-rs/apply-patch/src/standalone_executable.rs",
        "codex-rs/exec-server",
        "codex-rs/protocol",
        "codex-rs/sandboxing",
        "codex-rs/utils/pty",
      ]),
    );
    expect(provenance.standalone_rejection.forbidden_upstream_dependencies).toEqual(
      expect.arrayContaining(["codex-exec-server", "tokio", "tree-sitter", "tree-sitter-bash"]),
    );
    expect(provenance.standalone_rejection.internal_packages).toEqual(
      EXPECTED_INTERNAL_PACKAGES,
    );
    expect(provenance.standalone_rejection.external_dependencies).toEqual(
      EXPECTED_EXTERNAL_DEPENDENCIES,
    );
    expect(new Set(provenance.standalone_rejection.internal_packages).size).toBe(20);
    expect(new Set(provenance.standalone_rejection.external_dependencies).size).toBe(86);
    expect(provenance.standalone_rejection.internal_packages).toEqual(
      expect.arrayContaining(["codex-exec-server", "codex-sandboxing", "codex-utils-pty"]),
    );
    expect(provenance.standalone_rejection.external_dependencies).toEqual(
      expect.arrayContaining(["tokio", "tree-sitter", "tree-sitter-bash", "tokio-tungstenite"]),
    );
  });

  test("classifies every portable upstream fixture directory exactly once", () => {
    const provenance = loadProvenance();
    const scenarios = provenance.portable_scenarios;

    expect(provenance.portable_scenario_source.archive_sha256_method).toBe(
      "git archive --format=tar 3389fa554e953d07a12a34f5681aae46f17958f8 codex-rs/apply-patch/tests/fixtures/scenarios | shasum -a 256",
    );
    expect(scenarios).toHaveLength(23);
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual([...EXPECTED_SCENARIOS].sort());
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(EXPECTED_SCENARIOS.length);
    expect(
      scenarios.find((scenario) => scenario.id === "015_failure_after_partial_success_leaves_changes"),
    ).toEqual({ id: "015_failure_after_partial_success_leaves_changes", classification: "rejected_boundary" });
  });

  test("locks the narrow runtime's toolchain, protocol, dependency license, and update policy", () => {
    const provenance = loadProvenance();

    expect(provenance.artifact_dependencies).toEqual([
      {
        name: "OpenAI Codex apply-patch extracted source",
        version: PINNED_REVISION,
        license: "Apache-2.0",
        scope: "vendored source and portable fixture provenance; the locked independent Cargo closure is recorded separately in cargo_dependencies",
        notice_file: "native/apply-patch/NOTICE",
      },
    ]);
    expect(provenance.cargo_dependencies.map((dependency) => [
      dependency.name,
      dependency.version,
      dependency.license,
      dependency.checksum,
    ])).toEqual(EXPECTED_CARGO_DEPENDENCIES);
    expect(provenance.toolchain).toMatchObject({ rust_toolchain: "1.95.0", edition: "2024" });
    expect(provenance.protocol.name).toBe("nautilo.apply_patch/v1");
    expect(provenance.protocol.output).toContain("0.1.2 lower-level engine JSON report");
    expect(provenance.protocol.output).toContain("Phase 1.3 and 3.1/3.2");
    expect(provenance.update_policy.ordinary_builds_immutable).toBe(true);
    expect(provenance.update_policy.required_review).toEqual(
      expect.arrayContaining([
        "LICENSE and NOTICE hashes",
        "dependency-license inventory",
        "build guard and version provenance handshake",
      ]),
    );
  });

  test("keeps the build guard and version handshake tied to the reviewed provenance", () => {
    const provenance = loadProvenance();
    const buildScript = readFileSync(buildScriptPath, "utf8");
    const runtimeLibrary = readFileSync(runtimeLibraryPath, "utf8");
    const protocol = readFileSync(protocolPath, "utf8");

    expect(provenance.nautilo_extraction.provenance_handshake).toBe(
      "nautilo.apply_patch.provenance/v1",
    );
    expect(provenance.nautilo_extraction.provenance_handshake_guarantee).toContain(
      "validates this manifest's reviewed revision and byte-exact LICENSE/NOTICE hashes",
    );
    expect(provenance.nautilo_extraction.extraction_revision_method).toContain(
      "nautilo.apply_patch.extraction-revision/v1",
    );
    expect(provenance.nautilo_extraction.extraction_revision_method).toContain(
      "u64 big-endian path-byte length",
    );
    expect(buildScript).toContain(`REVIEWED_UPSTREAM_REVISION: &str = "${PINNED_REVISION}"`);
    expect(buildScript).toContain(EXPECTED_HASHES.license_sha256);
    expect(buildScript).toContain(EXPECTED_HASHES.notice_sha256);
    expect(buildScript).toContain("unreviewed upstream revision");
    expect(buildScript).toContain("required {name} missing");
    expect(runtimeLibrary).toContain('env!("NAUTILO_APPLY_PATCH_UPSTREAM_REVISION")');
    expect(runtimeLibrary).toContain('env!("NAUTILO_APPLY_PATCH_LICENSE_SHA256")');
    expect(runtimeLibrary).toContain('env!("NAUTILO_APPLY_PATCH_NOTICE_SHA256")');
    expect(runtimeLibrary).toContain('env!("NAUTILO_APPLY_PATCH_EXTRACTION_REVISION")');
    expect(buildScript).toContain("EXTRACTION_REVISION_FORMAT");
    expect(buildScript).toContain("cargo:rerun-if-changed={input}");
    expect(protocol).toContain('"provenance"');
    expect(protocol).toContain('"license_sha256"');
    expect(protocol).toContain('"notice_sha256"');
    expect(protocol).toContain('"nautilo_extraction_revision"');
  });
});
