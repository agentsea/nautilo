# D490 candidate 0.2.1 — ARM64 production-filter substrate

This is local candidate evidence, not publication authority. The image has a
content-addressed local Docker ID but no OCI repository digest, so it is not a
valid `RuntimeImageEvidenceManifestV1` release record.

| Field | Value |
|---|---|
| Source SHA | `d91d46ed6337509656672cfe215ecea971d3ff32` |
| Dockerfile SHA-256 | `sha256:8c0a534aae1d0cd6b07ae78beac6016599d0f63d6f8cfed02cb1c3c4d2475ae6` |
| Base identity | `docker.io/oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` |
| Architecture | `linux/arm64` (native Docker Desktop worker) |
| Local image ID | `sha256:05f6ffd18cb1c08a2392045bf031c1be8ed38e604f5484577afcbeec495d5b82` |
| Local tag | `nautilo-runtime:d490-0.2.1-arm64` (discovery only) |
| Repository digest | absent |
| Size | 1132476903 bytes |
| Image created | `2026-08-04T19:36:45.662264721Z` |
| Tool versions | Docker `29.6.2`; Buildx `0.35.0-desktop.2`; BuildKit `0.31.2`; image Bun `1.3.14` |
| Database pins | app `pgvector/pgvector:pg17`; Logto DB `postgres:16`; Logto `1.38.0` (not started in this candidate check) |

## Verification

- `docker buildx build --platform linux/arm64 --load ...` completed from the
  exact source SHA.
- Dockerfile stage-shape suite: 41 passed.
- Runtime source-closure suite: 5 passed.
- Sharp generated a 2×2 PNG (95 bytes) inside the image.
- argon2 hash and verify passed inside the image.
- Runtime `node_modules`: 595 MB, 566 top-level entries.

## Physical inventory and decision

The filter removes enough of the monorepo graph to reduce the old 3.01 GB local
baseline to 1.13 GB while retaining working ARM64 Sharp and argon2. It does not
constitute the final production closure: ESLint, TypeScript,
`@langchain/community`, Stagehand, Playwright, and Watsonx remain physically
present; Turbo was absent.

**Decision: keep as the independently reversible Task 0.2.1 substrate.** The
build succeeds, materially reduces the image, and preserves native behavior.
The observed leakage is neither accepted nor deferred silently: D490 Tasks 0.6
and 0.7 remove Community and replace Bun's broad filtered install with the
derived production closure before candidate approval or publication.
