# Releasing Nautilo

Nautilo has independent Desktop, server, administrator CLI, Mobile, and
Computer Use Host release channels. A merge, successful build, GitHub Release,
public-channel promotion, and running installation are different states.
Record the exact source commit and artifact identity at each handoff.

This guide describes the checked-in release contracts as of 2026-09-13. The
linked workflows and manifests define executable behavior; it is not a list
of currently deployed versions. See [GitHub Releases](https://github.com/agentsea/nautilo-public/releases),
[`CHANGELOG.md`](CHANGELOG.md), and the [Mobile ledger](apps/mobile/releases/ledger.json)
for dated records.

## Choose the channel

| Deliverable | Source/version authority | Build and publication entry point |
| --- | --- | --- |
| Desktop macOS application | Exact commit and `desktop-vX.Y.Z` GitHub Release tag; version stamped during the build | Maintainer infrastructure outside this source tree; [contributor packaging](apps/desktop/PACKAGING.md) |
| Server and served Workbench/Mobile Web | Exact source SHA and canonical multi-architecture image digest | Private maintainer release operation; [contributor image build](packaging/docker/Dockerfile) |
| Standalone administrator CLI | `apps/cli/package.json`, generated `apps/cli/src/version.ts`, and matching `cli-vX.Y.Z` | Private maintainer release operation |
| iOS and Android applications | Shared semantic version, exact source commit, EAS build IDs, and separate native counters | Maintainer infrastructure outside this source tree; [release records](apps/mobile/releases/README.md) and [contributor profiles](apps/mobile/eas.json) |
| Managed Computer Use Host | Signed runtime distributed through the standard Host feed | [Host package and contributor build](packages/computer-use-host/package.json) |
| Downloadable security scanners | Exact scanner manifest and reviewed release identity | Private maintainer release operation |

Public distribution uses protected maintainer publishing infrastructure separate
from this repository's build workflows. Its credentials are not needed to build
or inspect the public source. GitHub attachment success alone does not prove
that an updater feed or installer channel has advanced.

## Repository and source admission

Official Desktop, Host, CLI, scanner, server, hosting and Mobile signing and publication
are maintained outside this source tree. A merge does not automatically publish
a server release. Contributors retain ordinary CI, local builds, audit tools,
artifact schemas and public-key verification without official credentials.

Tart baseline publication is also maintained outside this source tree.

## Desktop artifacts and contributor packaging

Official Desktop artifacts are produced through maintainer infrastructure outside
this source tree. An exact source commit and `desktop-vX.Y.Z` release identify the
published application; source packages retain the development version.

Use [GitHub Releases](https://github.com/agentsea/nautilo-public/releases) to obtain the
DMG, ZIP, blockmap, updater metadata and checksums. Verify the artifact's publisher
identity and notarization. Read back the standard
[macOS updater manifest](https://media.nautilo.ai/desktop/stable/mac/latest-mac.yml)
and its referenced payloads before claiming channel availability. Installation
and successful client operation are separate checks.

For source builds, use the [contributor packaging guide](apps/desktop/PACKAGING.md)
and [manual packaging workflow](.github/workflows/desktop-package.yml). These
produce ad-hoc packages and run smoke checks without official release credentials
or publication. The updater origin in
[`electron-builder.yml`](apps/desktop/electron-builder.yml) remains a public
consumer contract. The [package inventory](apps/desktop/PACKAGE-MANIFEST.md)
describes bundled resources and verification requirements.

## Server image and stable deployment channels

Official server and bootstrap images are built and audited by maintainer
infrastructure outside this repository. The release selects one exact source
commit and native Linux amd64/arm64 image digests. Deployable runtime identity is
`ghcr.io/agentsea/nautilo-runtime@sha256:<digest>`; discovery tags never substitute
for the resolved immutable digest.

Signed server and hosting manifests select the same runtime image. Their public
consumer contracts remain in `packages/hosting`, with trust verification in the
CLI. Read [hosting stable](https://media.nautilo.ai/hosting/stable/manifest.json)
and [server stable](https://media.nautilo.ai/server/stable/manifest.json) to identify
the currently offered release. A new source merge alone does not advance them.

Verify the public pointers and anonymous digest pulls before selecting a
release for deployment. Use the supported profile-aware `nautilo upgrade`
procedure for an existing packaged deployment, then verify that target's
health and running image. Source-based development updates are a different
procedure. See [deployment documentation](deploy/README.md) and the
[server-channel handoff](apps/cli/RELEASING.md#public-release-sequence).

## Standalone administrator CLI

The package version, generated `src/version.ts`, lock importer and immutable
`cli-vX.Y.Z` identity must agree. Official native builds, signing, notarization
and publication are maintained outside this repository. The source retains
contributor packaging, artifact schemas and public-key verification.

Verify the [CLI stable manifest](https://media.nautilo.ai/cli/stable/manifest.json),
its signature and the exact installer/archive hashes before installing. Check
`nautilo --version` after installation. CLI publication does not advance server
or hosting manifests; npm is a separate distribution channel. See
[CLI packaging and distribution](apps/cli/RELEASING.md).

## Mobile: store builds and tester availability

Official iOS and Android builds, remote native counters, signing and store
submission are maintained outside this source tree. The product retains app IDs,
native capabilities, its semantic version contract and
[contributor build profiles](apps/mobile/eas.json).

The [Mobile ledger](apps/mobile/releases/ledger.json) records the exact product
source, EAS build IDs, allocated native counters and verified distribution state.
A ledger-only commit is bookkeeping, not the binary's source identity. See
[release record conventions](apps/mobile/releases/README.md).

A finished build or successful upload does not establish availability. Verify the
intended TestFlight group and Play internal track before claiming tester access;
public App Store/Play availability is a separate state. Preserve prior build
records and report only the distribution actually verified.

## Independently distributed local runtimes

- **Computer Use Host:** official releases are distributed through the
  [standard Host feed](https://media.nautilo.ai/computer-use/host/v1/latest.json).
  Desktop verifies the referenced manifest, archive digests, Apple identity and
  compatibility before managed installation. Publication and running Host adoption
  are separate states. A Host release does not change the Desktop-bundled Cua Driver pin.
  Contributors can compile the executable with
  `bun run --cwd packages/computer-use-host build:executable`; this does not issue
  an official release or grant access to the official distribution channel.
- **Security scanners:** official assembly, attestation and publication are
  maintained outside this repository. The [scanner manifest](apps/desktop/security-scanners/manifest.json)
  binds exact engine, rule and notice bytes. Source rules, licenses and the
  managed acquisition/runtime contracts remain here. Verify the public artifact
  hashes and notices against that manifest before using a downloaded scanner.
- **Vendored tools:** update manifests, checksums, and
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) together. Desktop and Server
  OfficeCLI must remain on the same release; see
  [OfficeCLI provisioning](docs/officecli-provisioning.md).

## Railway qualification bundles

Railway uses the signed hosting channel. Official qualification bundle assembly
is maintained outside this source tree. Historical checked-in records are test
fixtures, not release selection or permission to deploy.

Follow the [receipt-based qualification procedure](deploy/releases/qualification/README.md):
plan before mutation, deploy once, resume the same launch after interruption,
and inspect/tear down only the launch and project named by its receipt. Do not
hand-edit signed bundles or start a replacement stack to bypass recovery.

## Keep release records current

Update the changelog with user-visible changes and links to their merged PRs.
Record component versions independently; never imply that a Desktop tag also
released every server, Mobile, or Host change on `main`. A completion report
must name the source, successful build, artifact identity, public-channel
verification, and any target adoption actually checked.

## Desktop FFmpeg distribution

Desktop packages pin prebuilt LGPL FFmpeg 9.0.1 for both Mac
architectures. Run `bun run --cwd apps/desktop vendor:ffmpeg` before native media
tests. `afterPack` and `afterSign` verify the staged executable, notices and exact
FFmpeg/dependency/build-script source archives. Missing or changed sources and
GPL/nonfree configurations fail the build. Never restore the retired `b6.1.1`
aggregator pin as a fallback.

The complete source travels inside `Contents/Resources/tools-ffmpeg/source` in
every DMG and updater ZIP; the existing five-asset GitHub/Bunny release contract
is unchanged. Preserve that directory in packaging and check it in the final
signed download. See [FFmpeg source access](apps/desktop/FFMPEG.md) and
[export quality settings](packages/first-party-apps/video/EXPORT_SETTINGS.md).
Previous public artifacts require separate inventory/remediation; publishing
a corrected release does not erase historical distribution.
