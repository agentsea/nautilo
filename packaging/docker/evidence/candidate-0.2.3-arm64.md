# D490 candidate 0.2.3 — ARM64 parent upgrades

This is local candidate evidence, not publication authority. The image has a
content-addressed local Docker ID but no OCI repository digest, so it is not a
valid `RuntimeImageEvidenceManifestV1` release record.

| Field | Value |
|---|---|
| Source SHA | `6c8891a689525930db5e678ae2bec2c5836bec62` |
| Dockerfile SHA-256 | `sha256:8c0a534aae1d0cd6b07ae78beac6016599d0f63d6f8cfed02cb1c3c4d2475ae6` |
| Bun lock SHA-256 | `sha256:eae7c1684fde2ffc965ace60811eb49fe317357b646c21d0f563352bfab0ebf9` |
| Base identity | `docker.io/oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` |
| Architecture | `linux/arm64` (native Docker Desktop worker) |
| Local image ID | `sha256:ac807dd2c9dad67bf58d977d8b609f7a0747c680db1ca55daafaacb36d8e5917` |
| Local tag | `nautilo-runtime:d490-0.2.3-arm64` (discovery only) |
| Repository digest | absent |
| Size | 1141097043 bytes |
| Image created | `2026-08-04T19:54:01.946675172Z` |
| Image Bun | `1.3.14` |

## Verification

- `bun install --frozen-lockfile` passed before the build.
- MCP client, realtime client, and server typechecks passed.
- MCP client unit tests passed (69 tests); realtime unit tests passed (18
  tests); focused server MCP/WebSocket tests passed (55 tests).
- `docker buildx build --platform linux/arm64 --load ...` completed from the
  exact source commit.
- Sharp 0.35.3 generated a PNG (91 bytes) with libvips 8.18.3 inside the image.
- argon2 hash and verify passed inside the image.
- The physical runtime contains MCP SDK 1.30.0 and `@fastify/websocket` 11.3.0.
- Runtime `node_modules`: 620848 KiB, 566 top-level entries.

## Exact inventory comparison with 0.2.2

Candidate 0.2.2 used 614272 KiB for `node_modules`, contained 566 top-level
entries, and produced a 1136583124-byte image. Candidate 0.2.3 keeps the same
top-level count, adds 6576 KiB to `node_modules`, and adds 4513919 bytes to the
image.

The production-filter install reports 778 packages rather than 777. The new
physical edge is the SDK's nested Zod 4.4.3 while the repository's root Zod
4.3.6 remains present. `fastify-plugin` 5.1.0 remains at the physical root for
older Fastify parents; `@fastify/websocket` and `@fastify/static` each carry a
nested 6.0.0 copy. No MCP SDK 1.29.0 or `@fastify/websocket` 11.0.2 remains in
the lock.

ESLint, TypeScript, `@langchain/community`, Stagehand, Playwright, Watsonx,
Sharp, and argon2 remain physically present; Turbo remains absent.

**Decision: keep and close Task 0.2.** The parent upgrades pass focused
behavior and native checks, and their exact closure delta is explained. The
remaining broad runtime leakage is still assigned to D490 Tasks 0.6 and 0.7;
this local candidate is not approved for publication.
