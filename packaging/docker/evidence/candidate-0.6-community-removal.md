# D490 candidate 0.6 — LangChain Community removal

This is local candidate evidence, not publication authority. The images have
content-addressed local Docker IDs and local manifest digests but no OCI
repository digests, so they are not valid release records.

| Field | ARM64 | AMD64 |
|---|---|---|
| Source SHA | `540cd50aa708b13270a7cbd47727e4d3b4062ecd` | `540cd50aa708b13270a7cbd47727e4d3b4062ecd` |
| Dockerfile SHA-256 | `sha256:8c0a534aae1d0cd6b07ae78beac6016599d0f63d6f8cfed02cb1c3c4d2475ae6` | same |
| Platform | `linux/arm64` | `linux/amd64` |
| Local image ID | `sha256:a374c19e4f646eb72647ade375f28f1e6f0a7fbab7569d8e048f03111669f41e` | `sha256:a03eb2d5a26a274c595d1db36376a557213753b6c527be07964536b087565d3d` |
| Local manifest digest | `sha256:2e06762b50112c2b6c5ce3ad189141356139ba77698a30e1baaa76ae08d59a37` | `sha256:25ad7b9e8fe75c5ad3684af7bfa8e7c9607139b43fc07a99eb388419aaf86daf` |
| Local tag | `nautilo-runtime:d490-0.6-arm64` | `nautilo-runtime:d490-0.6-amd64` |
| Image size | 1070234505 bytes | 1049572801 bytes |
| Root `node_modules` | 476916 KiB / 457 top-level directories | 477360 KiB / 457 top-level directories |
| Syft artifacts | 870 | 871 |
| Syft report SHA-256 | `5f5ed5e79d5bbc8524cfbb5af1c69cb2b6ec6b2af27f814bc57abeb350dc60b5` | `493ef20df953886cd9cb84378234e37799326a1fe6f3443e999a905d71242f9f` |

## Behavior qualification

- Focused Together provider, endpoint, tool-binding, callback, timeout, and
  error-propagation tests passed.
- The complete `@nautilo/agent` unit suite, package typecheck, and package lint
  passed before the implementation commit.
- The production install completed with 633 packages on both architectures,
  down from the prior 778-package candidate.
- The repository-owned native probe passed natively on ARM64 and under explicit
  AMD64 emulation. Sharp 0.35.3/libvips 8.18.3 produced the deterministic PNG;
  argon2id accepted the correct value and rejected the incorrect value.

## Physical graph qualification

Pinned Syft 1.50.0 scanned each exact local image. Both SBOM queries returned
zero artifacts for:

- `@langchain/community`
- `@browserbasehq/stagehand`
- `@browserbasehq/sdk`
- `@ibm-cloud/watsonx-ai`
- `ibm-cloud-sdk-core`
- `playwright`
- `playwright-core`

An independent directory search across `/srv` in each image returned no paths
for the same package families. The checked-in lockfile also contains none of
those package identities.

## Decision

Keep the OpenAI-compatible Together implementation and close D490 Task 0.6.
Together remains a dormant supported provider while the broad Community-owned
runtime branches are absent. Final publication qualification must repeat the
exact-image gates against immutable registry digests.
