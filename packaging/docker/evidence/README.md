# Runtime image evidence layout

Task D490 writes each exact runtime-image capture to the caller-supplied
evidence root using only immutable release identity:

```text
source-<source-sha>/
  dockerfile-<dockerfile-sha256-without-prefix>/
    linux-amd64|linux-arm64/
      image-<image-sha256-without-prefix>/
        manifest.json
```

Raw captures are CI/release artifacts. They do not live in this source tree;
the canonical workflow writes them below `$RUNNER_TEMP`, retains them through
the artifact service, and passes the same artifacts to promotion authority.
This directory contains only compact human-readable qualification records and
small native-probe records. The `source-*` path is ignored and protected by a
repository invariant so local or CI scan output cannot become source again.

`manifest.json` is versioned (currently `version: 1`) and requires the source
SHA, Dockerfile SHA-256, one or more immutable base-image `repository@digest`
identities, architecture, exact image `sha256:` digest, matching immutable
image `repository@digest` authority, positive byte size, tool versions,
database identities and versions, and a canonical ISO-8601 UTC capture time.
Mutable tags are discovery metadata only and are deliberately invalid as either
image or base-image authority.

The writer creates the final evidence directory once. It never overwrites a
manifest or reuses an existing directory: any existing path is a collision and
the capture fails closed. This preserves a previously captured artifact instead
of silently substituting bytes from another source or image.

This primitive establishes identity and collision-safe layout only. Artifact
retention and recovery belong to the producing CI/release system; Task 0.3 owns
the pinned scanner/audit harness and report-specific contracts.

## D490 audit-tool and vulnerability-database authority

Task 0.3.1 pins Syft 1.50.0, Grype 0.116.1, and Trivy 0.73.0 in
[`../exact-image-audit-tools.manifest.json`](../exact-image-audit-tools.manifest.json).
The matching installer validates that exact versioned manifest, maps only the
supported Darwin ARM64 and Linux AMD64/ARM64 hosts, and delegates archive
download, checksum verification, and named-member extraction to the shared
vendored-binary helper. It has no ambient-tool fallback.

Scanner database authority is a supplied version-1 runtime identity, not a
committed database snapshot. The identity names Grype and Trivy separately and
records provider, schema/version, available canonical build/update times, an
exact absolute database-file path, and that file's SHA-256. The verifier hashes
both supplied files before use; a missing file, malformed identity, or mismatch
fails closed. A provider tag (including `latest`) is not an accepted identity
field and never makes a mutable database pinned. Task 0.3.1 neither downloads
nor auto-updates a database.

Task 0.3.2 adds one no-shell command for these verified inputs:

```sh
bun packaging/docker/exact-image-audit-cli.ts \
  --manifest /absolute/image-manifest.json \
  --database-identity /absolute/database-identity.json \
  --disclosure-policy /absolute/bounded-disclosure-policy.json \
  --vulnerability-policy /absolute/exact-vulnerability-policy.json \
  --tools-directory /absolute/pinned-tools \
  --grype-cache-directory /absolute/grype-cache \
  --trivy-cache-directory /absolute/trivy-cache \
  --output-root /absolute/evidence-root
```

The command verifies the installed scanner versions and supplied database-file
hashes before scanning. Database files must be inside their explicitly supplied
scanner caches; Grype and Trivy updates are disabled. It runs Syft, Grype,
Trivy, Docker inspect, and Docker history against the immutable image reference,
validates minimum machine-output shapes, enforces exact expiring vulnerability
exceptions, and writes seven JSON reports. Each
report entry records its filename, byte size, SHA-256, source SHA, architecture,
image digest/reference/size, verified tool versions, and database identities.
`report-index.json` is written last, so a failed or incomplete capture cannot be
mistaken for complete evidence.

The version-1 vulnerability policy is bound to one image digest, architecture,
and pair of scanner-database hashes. Server-image exceptions bind the exact
advisory, package, installed version, and severity once; `observedBy` retains
which scanners supplied review evidence without making scanner classification
part of the security decision. Legacy bootstrap-image entries remain
scanner-bound. Every exception also names an owner, review time, expiry, and
rationale. Fixable, unmatched, expired, or differently bound entries fail
before `report-index.json` is written. Unused server decisions remain visible
as bounded summary warnings and complete machine-readable report entries;
legacy scanner-bound unused entries continue to fail closed.

The version-1 bounded-disclosure policy supplies exact repository/operator
paths, private hostnames/emails/usernames, and customer markers. Fixed rules
also cover high-signal secret forms, package authentication/configuration files,
the canonical GitHub workspace path, source maps, and credential-bearing or
source-mismatched OCI metadata. Exact policy markers carry environment-specific
private host and operator identity. The command saves the exact image and inspects
every declared layer in an isolated temporary directory. Oversized text that
cannot be fully inspected fails the gate; binaries are path-checked without
being decoded as text. Findings retain category, rule, layer/location, and a
SHA-256 of the match without copying secret or policy-marker values into the
report. The report explicitly identifies itself as a bounded taxonomy and does
not claim detection of all PII or every possible sensitive value.

```json
{
  "version": 1,
  "repositoryPaths": ["/absolute/private/repository-root"],
  "operatorPaths": ["/Users/operator"],
  "privateHostnames": ["private.example.internal"],
  "privateEmails": ["operator@example.internal"],
  "privateUsernames": ["operator"],
  "customerMarkers": ["EXACT-CUSTOMER-MARKER"]
}
```

Arrays may be empty when a category has no environment-specific markers; the
fixed structural rules remain active.

The recoverable pre-port local image identities and their authority limitations
are recorded in [`baseline-inventory.md`](baseline-inventory.md).

The known-bad AMD64 baseline does not need rebuilding. The prior ARM64
inspection already established that the baseline retained development packages,
unused Community dependencies, and unresolved high-severity findings. D490
must recover any surviving exact ARM64 records without representing missing
reports as present, then spend new build effort on the corrected AMD64 and
ARM64 candidates instead of reproducing an artifact already rejected on those
grounds.

## Native runtime qualification

Task 0.5 mounts the repository-owned probe into an otherwise unchanged final
image and requires both physical and functional evidence. For the requested
platform it verifies the pinned Sharp, glibc libvips, and argon2 packages; reads
the ELF machine identity of both native addons and libvips; performs a real
Sharp PNG transform; and proves argon2id accepts the correct value and rejects
an incorrect value.

The host runner refuses a dirty worktree, binds the result to the source SHA,
Dockerfile SHA-256, local image ID, image size, requested and observed runtime
architectures, and Docker engine architecture, then records whether execution
was native or emulated. The local tags are discovery names only. These Task 0.5
captures have no registry digest because they are private `--load` candidates;
Task 0.9 must rerun the same probe against the final immutable candidate
digests before approval.

- [`native-probes/d490-0.5-arm64.json`](native-probes/d490-0.5-arm64.json):
  native ARM64 execution on an AArch64 Docker engine.
- [`native-probes/d490-0.5-amd64.json`](native-probes/d490-0.5-amd64.json):
  emulated AMD64 execution on that AArch64 Docker engine.

Task 0.6 repeats those probes after replacing the dormant Together adapter's
LangChain Community import with the bounded OpenAI-compatible client. The
paired candidate record also binds pinned Syft inventory and exact filesystem
absence checks to the local image identities:

- [`candidate-0.6-community-removal.md`](candidate-0.6-community-removal.md)
- [`native-probes/d490-0.6-arm64.json`](native-probes/d490-0.6-arm64.json)
- [`native-probes/d490-0.6-amd64.json`](native-probes/d490-0.6-amd64.json)

Task 0.9 reruns the probe against the immutable local-registry candidate
digests and records the complete approval in
[`candidate-0.9-private-approval.md`](candidate-0.9-private-approval.md).

## Contributor audit commands

These independent command entry points remain usable without the official
release workflows. `knip.json` lists them explicitly so their internal dependency
graph is still checked after the workflow callers move out.

| Command under `packaging/docker/` | Purpose |
| --- | --- |
| `exact-image-audit-tools-cli.ts` | Install checksum-pinned audit tools. |
| `prepare-release-audit.ts` | Capture exact image and scanner database identity. |
| `exact-image-audit-cli.ts` | Run the indexed image audit. |
| `native-runtime-probe-cli.ts` | Probe the server image on its native architecture. |
| `bootstrap-native-probe-cli.ts` | Probe bootstrap safe-failure behavior. |
| `release-evidence-gate.ts` | Validate a complete server audit and native receipt. |
| `bootstrap-release-evidence-gate.ts` | Validate a complete bootstrap audit and native receipt. |

## Image audit evidence

Official image publication and signing are maintained outside this source tree.
The source retains local image builders, native runtime probes, exact-image
scanners, vulnerability exception policy and `release-evidence-gate.ts` so
contributors can inspect the image they built without release credentials.

The per-architecture gate requires all seven indexed reports with matching byte
hashes and image/source bindings, passing vulnerability and bounded-disclosure
policies, absence of prohibited runtime packages, license inventory and native
runtime evidence against the same digest. Its receipt records audit results;
it does not publish an image or authorize the official distribution channel.

Earlier dated captures in this directory are historical evidence. Current
release selection comes from the signed public channels described in
[RELEASE.md](../../../RELEASE.md#server-image-and-stable-deployment-channels).
