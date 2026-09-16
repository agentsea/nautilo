# D490 candidate 0.2.2 — ARM64 direct-dependency upgrade

This is local candidate evidence, not publication authority. The image has a
content-addressed local Docker ID but no OCI repository digest, so it is not a
valid `RuntimeImageEvidenceManifestV1` release record.

| Field | Value |
|---|---|
| Source SHA | `00cc4c7060d35a85fa64582836e369a4476f6827` |
| Dockerfile SHA-256 | `sha256:8c0a534aae1d0cd6b07ae78beac6016599d0f63d6f8cfed02cb1c3c4d2475ae6` |
| Bun lock SHA-256 | `sha256:eeae0ddbbff7403be90603106c31c7bdf0b113368f4ef54b5ae26ba579dce669` |
| Base identity | `docker.io/oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` |
| Architecture | `linux/arm64` (native Docker Desktop worker) |
| Local image ID | `sha256:7e1172c76416f5d15b66f2e0dbf86911fff323910efdf144428a8064eaaa254c` |
| Local tag | `nautilo-runtime:d490-0.2.2-arm64` (discovery only) |
| Repository digest | absent |
| Size | 1136583124 bytes |
| Image created | `2026-08-04T19:46:17.601666846Z` |
| Image Bun | `1.3.14` |

## Verification

- `bun install --frozen-lockfile` passed before the build.
- Typechecks passed for the CLI, desktop, DB, encryption invariants,
  realtime client, relay, and server packages.
- DB unit tests passed; relay unit tests passed (202 tests); realtime
  WebSocket tests passed (12 tests); server WebSocket tests passed (30 tests).
- `docker buildx build --platform linux/arm64 --load ...` completed from the
  exact source commit.
- Sharp 0.35.3 generated a PNG (91 bytes) with libvips 8.18.3 inside the image.
- argon2 hash and verify passed inside the image.
- Runtime versions resolved to Drizzle ORM 0.45.2, Fastify 5.11.2,
  `@fastify/static` 10.1.2, ws 8.21.2, and Sharp 0.35.3.
- Runtime `node_modules`: 600 MB, 566 top-level entries.

## Physical inventory and decision

ESLint, TypeScript, `@langchain/community`, Stagehand, Playwright, Watsonx,
Sharp, and argon2 remain physically present; Turbo remains absent. The image is
4,106,221 bytes larger than candidate 0.2.1, consistent with the upgraded
dependency closure, while native ARM64 behavior remains healthy.

**Decision: keep as the independently reversible Task 0.2.2 substrate.** The
direct upgrades are verified in the installed runtime and do not broaden the
accepted final closure. Existing development and provider leakage remains
assigned to D490 Tasks 0.6 and 0.7 before candidate approval or publication.
