# Changelog

All notable changes to `@nautilo/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.33] - 2026-09-15

### Fixed

- Signed server and Railway release metadata share a 60-second request deadline.
  Slow responses can complete without bypassing signature verification; stalled
  requests still abort safely and can be retried.

## [0.1.32] - 2026-09-15

### Fixed

- Railway template adoption automatically attaches the latest signed stable
  Nautilo runtime to the held setup service. The template no longer embeds a
  Nautilo runtime image that can become unavailable between releases.
- Interrupted Railway deployments retain and reverify their original signed
  release, so a later stable release does not prevent ordinary resume.

This source version requires a separate signed release and verified publication.

## [0.1.31] - 2026-09-15

### Fixed

- Artifact relocation reads original backup archives through the Node subprocess
  API, so the npm/Node entrypoint works as well as the signed Bun executable.

- Server release resolution and explicit deploy/upgrade admission support the
  fresh v2 runtime namespace while preserving signed immutable legacy releases
  during the package transition.
- Local Compose profiles preserve explicit durable/disposable retention through
  CLI edits. Removing a durable profile requires explicit confirmation.
- Upgrade and backup capture retain the exact requested immutable image
  reference when Docker stores the same image under multiple repositories.

This source version requires a separate signed release and verified publication.
Published CLI 0.1.30 remains unchanged.

## [0.1.30] - 2026-09-15

### Added

- `artifacts-relocate plan|apply|rollback` repairs physical file references after
  moving an existing instance's artifact storage. It verifies every file against
  an original full backup, preserves document-history metadata, and applies an
  exact, atomic metadata plan. Rollback requires the original files to exist
  again at their original root.

This source version requires a separate signed release and verified publication
before the stable CLI channel advances.

## [0.1.29] - 2026-09-14

### Fixed

- Upgrade and full-bundle restore reconcile restricted Memory coordinator grants
  against the installed database schema, so older schemas can be repaired before
  migrations without granting access to immutable or unrelated columns.

This source version requires a separate signed release and verified publication
before the stable CLI channel advances.

## [0.1.28] - 2026-09-14

### Fixed

- Remote deploy and restore synchronization now leaves deployment files owned
  by the authenticated SSH operator instead of copying numeric ownership from
  the local staging workstation.

This source version requires a separate signed release and verified publication
before the stable CLI channel advances.

## [0.1.27] - 2026-09-14

### Fixed

- Restore and automatic rollback send database credential reconciliation SQL
  through private process input. Command logs, process arguments and operator
  failure diagnostics no longer contain that SQL.

This source version requires a separate signed release and verified publication
before the stable CLI channel advances.

## [0.1.26] - 2026-09-12

### Fixed

- Local Compose maintenance and upgrade checks use container-loopback Docker
  authority after owner binding, so they do not depend on a retired bootstrap
  bearer. Cancellation still follows the operator's request.

### Changed

- Stenographer status includes protection and authorization-wait information,
  with explicit unavailable status on older servers.
- Prepare the standalone release version for private release infrastructure.
  Publication remains a separate verified operation; this source change does
  not advance the public stable channel.

## [0.1.25] - 2026-09-10

### Fixed

- Compose deployment no longer selects protected owner configuration merely
  because a default TOML file exists. Select automation explicitly with
  `--owner-mode config` or `--owner-config`; browser claim remains the manual
  path.
- Remove the unsupported `admin.forcePasswordChangeOnFirstSignIn` option from
  deployment/setup configuration and templates. Config-mode owner setup uses
  a permanent password. Remove the obsolete field from existing TOML files;
  legacy setup migration rejects `true` and drops `false`. Member temporary
  password and first-use recovery commands are unchanged.

### Changed

- `settings models show --format json` includes embedding and image/music/video
  model settings and catalogues from the shared API contract. Missing values
  on older Servers receive null, false, or empty-array defaults; strict JSON
  consumers should accept these additional fields. Human output and model-set
  flags are unchanged.
- Hosting provider capability evaluation now recognizes Venice embeddings.
- Update the TOML parser to `smol-toml` 1.8.0 and incorporate the current
  shared API-client and dependency changes. Shared product APIs do not add
  new commands to the standalone administrator allowlist.

This is a signed standalone macOS ARM64/x64 CLI release. It does not publish
npm packages or advance Server, hosting, Desktop, or Mobile release channels.

## Earlier changes

### Added

- Administrator command surface for setup, authentication, status, profiles,
  deployments, diagnostics, backup/restore, and release lifecycle operations.
- Setup template schema (`SetupTemplateV1`) with optional Phase 12 `genie` block and dev-only `gen-setup-template` in `nautilo-dev`.
