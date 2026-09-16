# Nautilo Mobile release ledger

This directory is the source-owned record of Mobile release identity and signed
store builds. `ledger.json` answers three different questions without mixing
their numbers:

- `version` is the human-visible semantic version shared by iOS and Android.
- `nativeBuildNumber` is Apple's build number or Google's version code.
- `easBuildId` identifies the immutable EAS build that produced the binary.

`candidateCommit` identifies the current candidate's product source. Each new
build records its own product `sourceCommit` and the exact `gitCommitHash`
reported by its native builder. An assembled build can have a different commit
from its product source. Preserve both per-build identities when the release
candidate advances; never replace the builder's commit with the product SHA.
Older records without `sourceCommit` remain historical evidence as recorded.

Official native builds, signing, remote counter allocation and store submission
are maintained outside the product source tree. The checked-in `../eas.json`
contains contributor profiles only. Record native counters from the verified
build receipt; never infer the next counter or encode it in the semantic version.

## Version policy

- The first public release is `0.1.1`.
- A bug-fix store update increments the patch version: `0.1.2`, `0.1.3`, and so
  on.
- A meaningful compatible feature cycle increments the minor version and resets
  patch: `0.2.0`, `0.3.0`, and so on.
- `1.0.0` is reserved for an explicit product decision that Nautilo Mobile has
  reached its 1.0 stability promise.
- The maintainer explicitly selected `0.1.2` for the Mobile timestamp and
  workspace-sharing tester cycle on 2026-09-07.
- The maintainer selected `0.2.0` for the document/media/original-file tester
  feature cycle on 2026-09-08. Public rollout remains separately gated.
- Never turn an iOS build number or Android version code into a semantic
  version. Apple build `25` and Android version code `31` were both Nautilo
  Mobile `0.1.0` tester binaries.

## Recording a release

1. Keep `app.json`, `package.json`, `src/lib/release-contract.ts`, the matching
   `<version>.md` release note and `ledger.json` aligned on the semantic version.
   A `preparing` entry has no candidate source or build receipt yet.
2. Record the exact admitted product SHA as `candidateCommit` once a candidate is
   verified. A later ledger-only commit is bookkeeping, not the binary's source
   identity.
3. Append the actual platform, native counter, immutable EAS build ID and
   submission ID from the release evidence. Preserve earlier build records;
   another candidate in the same unreleased semantic version has its own exact
   source/build identity.
4. Record tester distribution only after verifying the intended Play track or
   TestFlight group. A finished build, upload or signing success alone does not
   establish tester availability.
5. Public App Store/Play release is a separate state. Record the public store URL
   and release time only when verified live; preserve review/processing state
   until then. After a public release, a changed binary starts a higher semantic
   version under the policy above.

Release notes describe what users receive. The ledger records exactly which
commit and signed binaries delivered it. Neither file may contain credentials,
signing material, API keys, or portal session data.
