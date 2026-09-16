# D490 recovered local image inventory

Captured during Task 0.1 on 2026-08-04 before candidate ports changed Stack
282. These are Docker's local content-addressed image IDs, not publishable OCI
repository digests. They preserve the recoverable identity without upgrading a
mutable tag into release authority.

| Local tag | Local image ID | Platform | Size (bytes) | Created (UTC) | Repository digest |
|---|---|---|---:|---|---|
| `nautilo-server:railway-qualification` | `sha256:4ceaf06f78790df73655a2ea8c6d1c366abfb2de79c7094ac39629d8964f74eb` | `linux/arm64` | 3014387450 | `2026-08-04T13:09:48.32623846Z` | absent |
| `nautilo-server:railway-public-audit` | `sha256:14c4a8adc17a9c413c4f9cf54ffb19c39986f59d5e50bf1f09472f9bc5292b47` | `linux/arm64` | 1107802387 | `2026-08-04T13:16:20.116766669Z` | absent |
| `nautilo-server:railway-public-audit-remediated` | `sha256:361c0066f22ae9e62d56665dca2c93515fb6f70127b2ec51ece874457c631fef` | `linux/arm64` | 1111907193 | `2026-08-04T15:02:12.042066179Z` | absent |
| `nautilo-server:railway-public-audit-parent-remediated` | `sha256:a8e31a52ca9127d921bb820181136aa914bfbda53e9676d21f4cecf9e6ab6269` | `linux/arm64` | 1116421090 | `2026-08-04T15:13:10.912215386Z` | absent |

All four images inherit Bun base labels reporting Bun `1.3.14` and upstream
revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`. Those labels do not identify
the base image digest and therefore cannot satisfy the immutable-base field in
`RuntimeImageEvidenceManifestV1`.

The local tags align chronologically with the bounded D490 candidate sequence,
but the images carry no Nautilo source SHA, Dockerfile hash, or repository
digest labels. No surviving SBOM, vulnerability, license, disclosure, layer, or
behavior reports were found in the code or docs repositories. Consequently,
the table is preservation/inventory evidence only: none of these images is
promotion authority and none can be written as a valid V1 evidence manifest.

The original ARM64 inspection already rejected the baseline because it retained
development and unused Community dependency trees and unresolved high-severity
findings. Building an equivalent AMD64 baseline would reproduce a rejected
artifact without resolving any missing identity field. D490 instead ports and
tests the bounded candidates separately, then creates fresh digest-bound AMD64
and ARM64 evidence for the corrected image.
