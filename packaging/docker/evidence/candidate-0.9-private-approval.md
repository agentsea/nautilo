# D490 Task 0.9 private candidate approval

Approved locally on 2026-08-05 from clean source
`7cecc85652516a83eaaa4d588060faec3a92d20c` and Dockerfile SHA-256
`d4018a4629e9ce8a4baaa7c9c8fd8338ada7b4b941fd5a7bd710fb2aed993a95`.
This is private-candidate evidence only. No GitHub or GHCR artifact was created
or changed.

| Architecture | Immutable local-registry digest | Image ID | Size | Native-addon execution |
|---|---|---|---:|---|
| linux/arm64 | `sha256:2778696383add155bcfc6f34611d6c9ec3dd4ab1b7b2a155e259cf7439bd7720` | `sha256:524ef23fa80717839b63d5390ae848173a1367cf6d6919e23242c0df2a244ffe` | 850,442,662 bytes | Host-native ARM64 |
| linux/amd64 | `sha256:422b925d206cda8c592f000c89a260ff8abc653514cdd8380bc4a2d18c62dced` | `sha256:17497e64af45ba834ac7312be535e6e322acf2f8c8d38d2e6737d49155f974f8` | 818,267,584 bytes | AMD64 under the local AArch64 engine's emulation |

## Approval result

- Both exact audits wrote a seven-report `report-index.json` bound to the
  immutable digest, source SHA, Dockerfile SHA, scanner versions, and database
  hashes.
- Syft found 714 packages per architecture. The only inventory differences are
  architecture-specific Sharp/libvips packages, the matching .NET runtime pack,
  and Debian's architecture-specific `grep` build suffix.
- Trivy recorded 1,172 license entries per architecture in the exact-image
  analysis report.
- The disclosure gate inspected all 63 layers. ARM64 covered 40,771 files and
  360,004,952 text bytes; AMD64 covered 40,770 files and 360,026,851 text bytes.
  Both had zero findings and zero unscanned text files.
- Sharp/libvips and argon2 functional probes passed on both architectures.
  Complete server import, first-party app scanning, and Writer/Spreadsheet
  agent-tool imports also passed in both final images.
- Source maps, curl, the Lattice Rust/Cargo builder tree, and the prohibited
  Community/Stagehand/Browserbase/Watsonx/IBM SDK ecosystems are absent.

## Advisory ownership

The JavaScript findings that initiated remediation are gone: `hono`,
`socket.io-parser`, `brace-expansion`, `fast-uri`, and `ip-address` have no
remaining high/critical result.

Each architecture has 48 scanner-specific high/critical findings covering 22
unique Debian advisories. All are non-fixable in the pinned 2026-08-05 scanner
databases and match an exact exception; no fixable or unmatched finding exists.
Every exception is owned by **D490 release/security**, expires at
**2026-08-19T00:00:00Z**, and is bound to scanner, advisory, package, installed
version, severity, architecture, image digest, and database hashes. The input
policy and evaluated policy report in each digest directory are the canonical
advisory ownership map. Expired, unused, fixable, unmatched, or differently
bound entries fail the audit.

## Evidence identity and retention

- ARM64 identity: source `7cecc85652516a83eaaa4d588060faec3a92d20c`,
  Dockerfile `d4018a4629e9ce8a4baaa7c9c8fd8338ada7b4b941fd5a7bd710fb2aed993a95`,
  image `sha256:2778696383add155bcfc6f34611d6c9ec3dd4ab1b7b2a155e259cf7439bd7720`.
- AMD64 identity: the same source and Dockerfile, image
  `sha256:422b925d206cda8c592f000c89a260ff8abc653514cdd8380bc4a2d18c62dced`.
- Runtime probes: `native-probes/d490-0.9-arm64.json` and
  `native-probes/d490-0.9-amd64.json`.

The original private-candidate raw reports remain recoverable from the D490
merge history. They are not live source inputs. Current and future raw reports
are retained by the producing CI/release workflow and referenced by immutable
artifact and image identity.
