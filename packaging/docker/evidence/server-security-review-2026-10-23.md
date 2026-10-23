# Server security source review — 2026-10-23

## Scope and evidence boundary

This review updates source policy only. It does not claim a new server image build, SBOM, vulnerability scan, native build, release qualification, or publication. Those activities remain deferred.

The review is bound to source commit `3967a8e67542814bee3c668ec432082366f5749d` and these immutable before-policy snapshots:

- `packaging/docker/fixtures/server-policy-before-security-renewal-2026-10-23.json`: SHA-256 `5901ea91cbde6d0b52d4499c2cb53c16ba59c2ab207da9a524fe5146366af9f7`, 122 exceptions.
- `packaging/docker/fixtures/bootstrap-policy-before-security-renewal-2026-10-23.json`: SHA-256 `63d56d58a3443d1a13959659f461281262fcb16a35e77939a8aa3799143821d2`, 2 exceptions.

The current Debian security tracker capture contains 42 advisories checked between `2026-10-23T12:45:36.848402+00:00` and `2026-10-23T12:45:37.883866+00:00`; its SHA-256 is `7bc77f57fd1db15482c0a294d71dffac69672b39296769b5d4493a9fece639d9`. The checked tracker URLs and observed trixie rows are recorded in `packaging/docker/fixtures/server-security-renewal-2026-10-23.json` so the source decision does not masquerade as fresh scanner output.

## Chromium removal

[DSA-6577-1](https://www.debian.org/security/2026/dsa-6577) and the current Debian tracker rows mark `156.0.8078.47-1~deb13u1` fixed in trixie-security for CVE-2026-110913 through CVE-2026-110922. Debian security indexes expose that exact `chromium-common` and `chromium-headless-shell` version for both `amd64` and `arm64`:

- InRelease: `https://security.debian.org/debian-security/dists/trixie-security/InRelease`, SHA-256 `c4a2dcb81cb98970f01005a2e559a7db8ecb1641897c18b6aa69c79f4e7d13d6`.
- amd64 Packages index: `https://security.debian.org/debian-security/dists/trixie-security/main/binary-amd64/Packages.xz`, SHA-256 `320ce5ef5baed8f5681bb6c153316450dd6fb11a1cf20625a4d528225b3200f0`.
- arm64 Packages index: `https://security.debian.org/debian-security/dists/trixie-security/main/binary-arm64/Packages.xz`, SHA-256 `a323b860123272717d1c70e713638ff4d1bfb58f35594e7bb5feb887212ca192`.

The availability proof was captured at `2026-10-23T12:45:35Z`. Qualified-CA HTTPS succeeded and each downloaded Packages index matched its hash in the downloaded InRelease metadata. OpenPGP signature verification was not run because an OpenPGP verifier and Debian archive keyring were unavailable, so this evidence is not apt-secure or image qualification.

The minimum supported Chromium package version is therefore `156.0.8078.47-1~deb13u1` for both architectures. The source policy retires all 40 architecture-scoped exceptions for the ten Chromium advisories, two packages, and two architectures. Once the package floor is applied, the absence of those exceptions makes an older or newly vulnerable Chromium tuple fail the existing policy gate.

## Time-bounded renewal

The other 32 advisories in the current tracker capture remain vulnerable in trixie. The maintainer approved the exact existing residual-risk tuples for 45 days. Only entries expiring before `2026-12-07T00:00:00Z` were renewed:

| Policy | Before | Renewed | Retired | Preserved unchanged | After |
| --- | ---: | ---: | ---: | ---: | ---: |
| Server | 122 | 72 | 40 Chromium | 10 | 82 |
| Bootstrap | 2 | 2 | 0 | 0 | 2 |
| Total | 124 | 74 | 40 | 10 | 84 |

Each renewed entry retains its advisory, package, installed version, severity, scanner provenance, owner, and existing exposure rationale. Its `reviewedAt` is `2026-10-23T00:00:00Z` and its `expiresAt` is `2026-12-07T00:00:00Z`. The appended rationale records the source-only review, the explicit 45-day risk acceptance, and the requirement to remove the exception sooner at the first supported Debian 13 fix or corrected applicability evidence.

The ten entries already expiring on December 21 or December 25 remain field-for-field unchanged. Their canonical JSON SHA-256 before and after this update is `62cefe6b1d872810f723829b56e039b751e6895521ecfbd28b28289cd0641c8b`.

The machine-readable renewal ledger records the original policy entries and hashes, current Debian observations, Chromium index metadata, removal set, renewal set, preserved set, and deferred work in `packaging/docker/fixtures/server-security-renewal-2026-10-23.json`.
