# D431 release delivery evidence

This report records generated fixture/build metadata only. It contains no
operator documents, Artifact IDs, user names, private paths, document bytes,
screenshots, or private evaluation results.

## Production build closure (2026-08-03)

The ordinary Workbench production build now imports Silurus through the DOCX,
XLSX, and PPTX registry adapters. There is no comparison-lab build mode.

```sh
bun run --cwd apps/workbench build
bun apps/workbench/scripts/ooxml-delivery-probe.ts \
  --expect production
```

Silurus 0.75.0 provides retained-session actual-inflation accounting, fail-closed
poisoning after a resource breach, and rejected-load cleanup across all three
formats. D431 uses its public `resourceLimits` contract with a 64 MiB per-entry
limit and a 512 MiB distinct-entry total. Silurus additionally owns a
non-configurable 20,000-entry hard ceiling; Nautilo's declared-archive preflight
retains the same entry-count ceiling independently.

The ordinary Workbench build emitted 18,415,411 bytes and exactly these
package-matched parser assets:

| Format | v0.75.0 asset | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| DOCX | `docx_parser_bg-Bc9hraXb.wasm` | 1,314,823 | `d94301500d7240ed099c31ed9baa2d3dbd4a887797bfe7aaeeeab72cf73889a9` |
| XLSX | `xlsx_parser_bg-BM7cLtfq.wasm` | 1,119,774 | `1e6625b0188f74f50014eb7ca71b6a455589078b57e452f86b342dd5fa288431` |
| PPTX | `pptx_parser_bg-BMlCuMbV.wasm` | 1,043,890 | `0cdd365e335f32a8e89581c4b99dfea026f8317b2cb711a805fdcc3ef8fc6973` |

Real Chrome parsed the three smoke fixtures through the published package.
For each format, a one-byte resource policy rejected with
`ooxml-resource-limit`, constructed exactly one worker, and terminated exactly
one worker. Focused adapter/contract tests and Workbench typecheck pass.

## Server delivery

An injected full Nautilo server mounted the production Workbench distribution.
All three emitted parser URLs returned `200 application/wasm`, correct WASM
magic, and their expected bytes. A missing `/assets/*.wasm` URL returned
`404 application/json` with a non-HTML body, proving it cannot fall through to
the SPA shell.

The reusable network probe is:

```sh
bun apps/workbench/scripts/ooxml-delivery-probe.ts \
  --expect production --server-url http://127.0.0.1:3001
```

## Docker delivery

Both the `workbench-build` target and final `runtime` image were built from this
stack:

```sh
docker build --target workbench-build -t nautilo-d431-workbench \
  -f packaging/docker/Dockerfile .
docker build --target runtime -t nautilo-d431-ooxml \
  -f packaging/docker/Dockerfile .
```

The clean container build proved that the manifests stage includes the root
install inputs required for its frozen Bun install. A stage-shape regression
test guards that requirement.

The final image contains the same three parser assets under `/srv/workbench`,
with the same sizes and SHA-256 values shown above. Running the image's actual
server code against `/srv/workbench` returned `200 application/wasm` for all
three assets and `404 application/json` (not SPA HTML) for a missing parser.

## Packaged Electron

Electron remains a paired thin client; it does not embed a second Workbench or
OOXML/WASM copy. An unsigned arm64 package was successfully produced at
`apps/desktop/release/mac-arm64/Nautilo.app`, and inspection found no parser
WASM or Workbench `index.html` inside the application.

The packaged process survived its 25-second smoke boot and passed log-redaction.
The preload-surface parity bound has since been reconciled with the combined
Desktop API and passes its focused test plus the full affected unit gate. Once
paired and signed in, the packaged client consumes the same server-hosted assets
proven above.

## Product evidence and remaining operator check

The populated signed-in default Electron instance now proves representative
room-scoped Artifact DOCX/XLSX/PPTX; valid 100 MiB Current Folder
DOCX/XLSX/PPTX; the private approximately 42 MiB/35-slide Current Folder deck;
bounded malformed input; and the explicit 300 MiB/100 MiB-cap response. The
private deck opened at fit-page scale, a search reported 56 matches and
navigated across slides, and a 700×700 emulated viewport retained all compact
controls without horizontal overflow. No private filename, Artifact ID,
document byte, or screenshot is recorded here.

Remaining operator evidence is the approximately 42 MiB and 100 MiB Artifact
capacity pass, peak/repeat-open memory, tracked-change, print/accessibility,
public-network, and final Docker/packaged-client rerun against v0.75.0. Native
Expo remains unchanged and outside D431.
