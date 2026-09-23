# Third-Party Notices

**Notice version: 1.2**

This is the canonical notice for third-party software and bundled data
distributed in Nautilo release artifacts. It covers the desktop application,
the server/container image and served Workbench bundle, and the mobile
application. It is an attribution record, not a statement that Nautilo is
affiliated with, sponsored by, or endorsed by any listed project.

## How this inventory is bounded and verified

The contributor-only [floating Genie lab](dev/tools/genie-lab/NOTICE.md) evaluates
Vercel AI Elements Persona and Rive. Those assets are outside the production
release closure; their development provenance is recorded with the lab.

Release paths, rather than the development checkout, define this notice.

| Release path | Authoritative checked-in closure | What is distributed |
| --- | --- | --- |
| Desktop | `apps/desktop/package.json`, `bun.lock`, `apps/desktop/electron-builder.yml`, `apps/desktop/vendor/*.manifest.json`, and the vendor scripts | Electron app, its production JavaScript closure, the packaged Bun runtime, Codex app-server, Cua Driver, and the explicit vendored tools below. |
| Server image | `packaging/docker/Dockerfile` and `packaging/docker/runtime-install/{projection.json,bun.lock}` | The production-only server projection, its Workbench static bundle, OfficeCLI, agent-browser, OpenMLS WASM, and the final OS/runtime packages. |
| Workbench | `apps/workbench/package.json` and `bun.lock` | Static browser assets emitted from the Workbench dependency closure. |
| Mobile | `apps/mobile/package.json` and `bun.lock` | Expo/React Native application JavaScript assets and bundled native modules. No checked-in Podfile.lock or Gradle dependency lock establishes a separate exact native closure. |

The lockfiles are the exact package-version authority: `bun.lock` for the
desktop, Workbench, and mobile release paths, and the production-only
`packaging/docker/runtime-install/bun.lock` for the server image. A package that is only present
in development/test tooling is not included merely because it exists in the
repository checkout. Where a package has a package-local notice, license, or
provenance file shipped with the artifact, that material remains authoritative
and is retained below or called out explicitly.

## Release-component index

The following are the separately bundled programs, runtimes, vendored source,
and non-JavaScript payloads that are especially visible in a shipped artifact.
Versions are release pins, not upstream-latest claims.

| Component | Exact version or revision | Canonical source | License | Shipped scope |
| --- | --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 41.10.3 | Electron | MIT | Desktop shell (and its Chromium/Node.js runtime components). |
| [Bun](https://github.com/oven-sh/bun) | 1.3.11 | Bun | MIT | Desktop: both macOS architectures are vendored under `Contents/Resources/bun`. |
| [Bun](https://github.com/oven-sh/bun) | 1.3.14 | Bun | MIT | Server image base, digest-pinned in `packaging/docker/Dockerfile`. |
| [OpenAI Codex app-server](https://github.com/openai/codex) | 0.146.0 (`rust-v0.146.0`) | OpenAI Codex | Apache-2.0 | Desktop external Codex runtime package. |
| [OpenAI Codex apply-patch extraction](https://github.com/openai/codex/tree/3389fa554e953d07a12a34f5681aae46f17958f8) | 3389fa554e953d07a12a34f5681aae46f17958f8 | OpenAI Codex | Apache-2.0 | Server and desktop `nautilo-apply-patch` runtime; Nautilo-modified extracted source. |
| [OOMOL OpenConnector](https://github.com/oomol-lab/open-connector) | 1.4.1 (`1bfdc0343057303d2993bcff44d0d5821ea658fd`) | OOMOL | Apache-2.0 | Compose-managed connected-app runtime; Nautilo-modified derivative source. |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | 0.35.2 | Vercel Labs | Apache-2.0 | Desktop and Server vendored CLI (macOS and Linux arm64/x64). |
| [Cua Driver](https://github.com/trycua/cua) | 0.23.2, base revision `e88e9d899ac5effaeae38619527ebaa46b26ce72` + Nautilo patch | Cua | [MIT](apps/desktop/cua-driver/qualification/LICENSE.md) | Desktop macOS native Computer Use driver. The exact upstream license is retained beside the source patch. The patch and resulting tree are pinned in `apps/desktop/cua-driver/qualification/manifest.json`; the package retains LICENSE, PROVENANCE.md, manifest.json, and qualification.patch. |
| [gogcli](https://github.com/openclaw/gogcli) | 0.31.1 | OpenClaw | MIT | Desktop vendored `gog` CLI (macOS arm64/x64). |
| [FFmpeg](https://github.com/ispysoftware/agentdvr-ffmpeg-build) | 9.0.1 | FFmpeg / iSpy Connect | LGPL-3.0-or-later | Desktop macOS arm64/x64; GPL/nonfree disabled. Exact source, build scripts and licenses are included. |
| [OpenSSL](https://openssl.org/) | 3.5.7 | OpenSSL Project | Apache-2.0 | Statically included in the Desktop FFmpeg libraries; source and license included. |
| [OpenHue CLI](https://github.com/openhue/openhue-cli) | 0.24 | OpenHue | Apache-2.0 | Desktop vendored CLI. |
| [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) | 1.0.148 | iOfficeAI | Apache-2.0 | Desktop macOS and Server macOS/Linux document-processing binaries; both manifests pin the same release and identical macOS artifacts. |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | 15.1.0 | BurntSushi | MIT OR Unlicense | Desktop vendored `rg` binary (macOS arm64/x64). |
| [OpenMLS](https://github.com/openmls/openmls) | 0.8.1, commit `47dbedecad0c1fd8eb5368d582250ebfcc1e1ce6` | OpenMLS | MIT | Vendored `openmls_wasm_bg.wasm` used by the server lattice-crypto runtime. |
| [Silurus OOXML](https://github.com/yukiyokotani/office-open-xml-viewer) | 0.75.2 | Yuki Yokotani | MIT | Workbench and mobile OOXML parser assets. |
| [Wafflebase Core, Docs, Sheets, Slides and Board](https://github.com/wafflebase/wafflebase) | 0.6.9, commit `acde58012910ec68645c65b6896d5408fad1645c` | Wafflebase | Apache-2.0 | Nautilo-owned private workspace source. Writer and Slides consume owned Docs; no registry Docs runtime remains. Package identities, build/runtime compatibility and grid contrast are adapted in source; see `docs/office-engines/CHANGES.md` and original-file hashes in `snapshot.json`. The optional Sheets mini-app carries compiled browser/headless outputs, LICENSE, bundled dependency notices and full artifact provenance. |
| [Noto fonts](https://github.com/notofonts) | Per-file versions and SHA-256 in `packages/fonts/assets.manifest.json` | Google / Adobe / Noto projects | OFL-1.1; bundled Noto Naskh Arabic 1.05: Apache-2.0 | Nine font files in `@nautilo/fonts`; the Server image copies the package, including its [notices](packages/fonts/NOTICE.md) and full license texts. |

### Reconciliation notes

- Desktop and Server OfficeCLI manifests must use the same upstream release;
  shared platform artifacts must have identical URLs and SHA-256 digests.
  The server `.version` and upstream `SHA256SUMS` provenance record are kept
  aligned with that release. The Desktop manifest tests enforce this parity.
- The Workbench declaration is a `~0.75.0` range, but `bun.lock` resolves it
  to **`@silurus/ooxml` 0.75.2**; mobile also pins 0.75.2. This notice therefore
  records the shipped resolution, not the manifest range.
- MathJax/STIX is retained below because it belongs to Silurus's published
  package payload. Nautilo's ordinary supported Workbench build does not
  import `@silurus/ooxml/math`, so it does not claim that optional asset is
  emitted by that build.

### Desktop Bun notices

The Desktop package retains Bun 1.3.11's exact upstream notice under
`Contents/Resources/bun/LICENSE-bun.txt`. Its source revision and SHA-256 are
recorded in `apps/desktop/licenses/bun/manifest.json`. Bun's own MIT declaration
does not describe every linked component: that upstream notice also identifies
JavaScriptCore/WebKit, other linked libraries, and source/relink instructions.
The canonical notice you are reading is copied into `Contents/Resources/legal/`.
Packaging verifies both files against their checked-in inputs, including when
the Bun binaries are reused from cache.

### FFmpeg distribution

FFmpeg's libraries also contain zlib 1.3.2 (Zlib), bzip2 1.0.8 (bzip2-1.0.6),
xz/liblzma 5.8.3 (0BSD for liblzma), libogg 1.3.6 and libvorbis 1.3.7
(BSD-3-Clause), Opus 1.6.1 (BSD-3-Clause), LAME 3.100 (LGPL-2.0-or-later),
libvpx 1.16.0 and dav1d 1.5.4 (BSD-3-Clause). Their complete source archives
and original notices travel with the app; consult each archive for the full
component-specific terms.

Desktop uses iSpy's precompiled LGPL FFmpeg 9.0.1 for both
Mac architectures. Video encoding uses Apple's VideoToolbox; GPL/nonfree
components, including libx264 and libfdk_aac, are excluded. Native AAC remains.

Every app download includes exact FFmpeg and dependency source archives, matching
build scripts, license texts, configuration records and checksums under
`Nautilo.app/Contents/Resources/tools-ffmpeg`. See [source access and build
instructions](apps/desktop/FFMPEG.md). Vendoring and packaging validate these
records and reject unapproved binaries or missing sources. Nautilo's own code
retains its own license.

The previous `b6.1.1` aggregator pin combined an arm64 FFmpeg 6.0 executable
that reported nonredistributable/nonfree components with a GPLv3+ x64 executable.
Those pins are removed here. This change does not establish which historical
installers contained them or close the separate historical-distribution work.
See [FFmpeg's licensing explanation](https://ffmpeg.org/legal.html).

## Downloadable Desktop security scanners

These tools are acquired separately by the Desktop security-scanner runtime;
this table does not imply that their binaries are embedded in the app bundle.
`apps/desktop/security-scanners/manifest.json` pins each macOS arm64/x64
artifact, upstream source, license, and accompanying notice URL and digest.
Those component notices remain part of the scanner distribution record.

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| [Gitleaks](https://github.com/gitleaks/gitleaks/tree/v8.30.1) | 8.30.1 | MIT | Secret detection. |
| [OSV-Scanner](https://github.com/google/osv-scanner/tree/v2.5.1) | 2.5.1 | Apache-2.0 | Dependency vulnerability scanning. |
| [Trivy](https://github.com/aquasecurity/trivy/tree/v0.74.0) | 0.74.0 | Apache-2.0 | Vulnerability and configuration scanning. |
| [Semgrep](https://github.com/semgrep/semgrep/tree/v1.172.0) | 1.172.0 | LGPL-2.1-or-later | Static code analysis via semgrep-core. |

The separately acquired `semgrep-nautilo-rules` 1.0.0 bundle is Nautilo-authored
and MIT-licensed; its source and license are retained under
`apps/desktop/security-scanners/rules`.

## JavaScript and native package inventory

The lockfiles named above are the full package-by-package version inventory,
including transitives. This index names the direct product dependencies that
bring those locked transitive closures into a shipped artifact; each package's
canonical registry record provides the canonical project link and the license
declared by its shipped package metadata. The project families are kept
compact where every listed member shares the same version and license.

| Package or family | Exact locked version(s) | Canonical source | License | Release scope |
| --- | --- | --- | --- | --- |
| [React](https://github.com/facebook/react) / [React DOM](https://github.com/facebook/react) | 19.2.5 / 19.2.5 | Meta | MIT | Desktop, Workbench, mobile, server-rendered tooling. |
| [React Data Grid](https://github.com/Comcast/react-data-grid) | 7.0.0-beta.61 | Comcast | MIT | Workbench connected-app result tables. |
| [React Native](https://github.com/facebook/react-native) | 0.86.2 | Meta | MIT | Mobile. |
| [Expo SDK](https://github.com/expo/expo) | 57.0.11; Expo modules 57.0.1–57.0.11 | Expo | MIT | Mobile: audio, auth session, camera, file system, notifications, secure store, router, UI, and related Expo modules. |
| [Electron Log](https://github.com/megahertz/electron-log) / [electron-updater](https://github.com/electron-userland/electron-builder) | 5.4.3 / 6.8.9 | Community | MIT | Desktop. |
| [node-pty](https://github.com/microsoft/node-pty) / [argon2](https://github.com/ranisalt/node-argon2) | 1.1.0 / 0.44.0 | Microsoft / ranisalt | MIT / MIT | Desktop native addons; argon2 is also in the server projection. |
| [Fastify](https://github.com/fastify/fastify) family | 5.11.2; cors 10.1.0; multipart 10.0.0; static 10.1.2; websocket 11.3.0 | Fastify | MIT | Server. |
| [LangChain JS](https://github.com/langchain-ai/langchainjs) family | core 1.1.45; Anthropic 1.3.29; Fireworks 0.1.3; Google GenAI 2.1.29; OpenAI 1.4.5; Tavily 1.2.0; xAI 1.3.17 | LangChain | MIT | Server agent runtime. |
| [LangGraph JS](https://github.com/langchain-ai/langgraphjs) family | langgraph 1.2.9; checkpoint-postgres 1.0.1 | LangChain | MIT | Server agent runtime. |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) / [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | 1.30.0 / 1.3.0 | MCP / ACP | MIT / Apache-2.0 | Desktop and server integration surfaces. |
| [Zod](https://github.com/colinhacks/zod) | 4.3.6 | Colin McDonnell | MIT | Desktop, server, Workbench, and mobile. |
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) / [postgres.js](https://github.com/porsager/postgres) / [node-postgres](https://github.com/brianc/node-postgres) | 0.45.2 / 3.4.7 / 8.13.1 | Drizzle / porsager / brianc | Apache-2.0 / Unlicense / MIT | Server database clients. |
| [OpenID/JWT libraries: Logto JS](https://github.com/logto-io/js) and [jose](https://github.com/panva/jose) | browser 3.0.13; react 4.0.13; jose 6.2.3 | Logto / panva | MIT / MIT | Desktop, Workbench, mobile, and server authentication. |
| [Noble cryptography](https://github.com/paulmillr/noble-curves) family | ciphers 2.2.0; curves 2.2.0; hashes 2.2.0 | Paul Miller | MIT | Server and mobile cryptography. |
| [HPKE JS](https://github.com/dajiaji/hpke-js) / [ts-mls](https://github.com/LukaJCB/ts-mls) | 1.9.0 / 1.6.2 | dajiaji / LukaJCB | MIT / MIT | Server lattice-crypto runtime. |
| [PDF.js](https://github.com/mozilla/pdf.js) / [React PDF](https://github.com/diegomura/react-pdf) | 6.2.108 / 4.5.1 | Mozilla / Diego Muracciole | Apache-2.0 / MIT | Workbench, mobile, and server document rendering. |
| [docx](https://github.com/dolanmiu/docx) / [Wafflebase Docs](https://github.com/wafflebase/wafflebase) | 9.6.1 / owned 0.6.9 | dolanmiu / Wafflebase | MIT / Apache-2.0 | Server document creation and editing. |
| [CodeMirror](https://github.com/codemirror) language/state/view packages | language 6.12.3; state 6.6.0; view 6.43.1; format-specific packages in `bun.lock` | CodeMirror | MIT | Workbench editor. |
| [Lexical](https://github.com/facebook/lexical) packages via [MDXEditor](https://github.com/mdx-editor/editor) | 0.35.0 / 4.0.4 | Meta / MDXEditor | MIT / MIT | Workbench rich-text editor. |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) packages | core 0.2.20; React/Markdown 0.14.5–0.14.26; React Lexical 0.2.4 | assistant-ui | MIT | Workbench. |
| [Shiki](https://github.com/shikijs/shiki) engine, languages, and themes | 4.0.2 | Shiki | MIT | Workbench syntax highlighting. |
| [xterm.js](https://github.com/xtermjs/xterm.js) / [TanStack Virtual](https://github.com/TanStack/virtual) | 6.0.0 + fit 0.11.0 / 3.13.24 | xterm.js / TanStack | MIT / MIT | Workbench. |
| [Three.js](https://github.com/mrdoob/three.js) / [video.js](https://github.com/videojs/video.js) | 0.183.2 / 8.23.9 | three.js / Video.js | MIT / Apache-2.0 | Workbench media/UI. |
| [sharp](https://github.com/lovell/sharp) | 0.35.4 | lovell | Apache-2.0 | Server image processing; platform libvips payloads are resolved through the lockfile. |
| [Jimp](https://github.com/jimp-dev/jimp) | 1.6.1 | Jimp contributors | MIT | Computer Use Host and server image-processing dependency; locked plugin/type dependencies remain in the corresponding package closure. |
| [CloudConvert Node SDK](https://github.com/cloudconvert/cloudconvert-node) | 3.0.0 | CloudConvert | MIT | Server integration. |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) | client-s3/lib-storage 3.1108.0 | Amazon Web Services | Apache-2.0 | Standalone Nautilo CLI release. |
| [Mozilla Readability](https://github.com/mozilla/readability) / [Turndown](https://github.com/mixmark-io/turndown) | 0.6.0 / 7.2.4 | Mozilla / mixmark-io | Apache-2.0 / MIT | Desktop content extraction. |
| [linkedom](https://github.com/WebReflection/linkedom) / [diff](https://github.com/kpdecker/jsdiff) | 0.18.12–0.18.13 / 9.0.0 | WebReflection / kpdecker | ISC / BSD-3-Clause | Desktop and server. |
| [file-type](https://github.com/sindresorhus/file-type) / [fflate](https://github.com/101arrowz/fflate) / [dotenv](https://github.com/motdotla/dotenv) | 22.0.1 / 0.8.3 / 16.6.1 | Sindre Sorhus / 101arrowz / motdotla | MIT / MIT / BSD-2-Clause | Server runtime. |
| [ws](https://github.com/websockets/ws) / [pino](https://github.com/pinojs/pino) / [cron-parser](https://github.com/harrisiirak/cron-parser) | 8.21.2 / 10.3.1 / 5.5.0 | websockets / pinojs / harrisiiirak | MIT / MIT / MIT | Desktop and server. |

The lockfiles additionally record every transitive package required by the
listed dependencies (including platform-specific optional packages). They are
not a license grant for packages that a supported artifact does not actually
contain. Native platform dependencies whose package metadata carries its own
notice, such as sharp/libvips and Electron/Chromium, retain that shipped
upstream material in addition to this index.

## Container operating-system and image closure

The final Nautilo server image is based on
[oven/bun:1.3.14](https://hub.docker.com/r/oven/bun), pinned by immutable
digest in `packaging/docker/Dockerfile`. It installs `tini`, `ca-certificates`,
`chromium-headless-shell`, `tar`, the current `libicuNN` selected from the
base distribution, and PostgreSQL client binaries (17, plus copied 16
utilities). These are distributed components, but this repository deliberately
does **not** pin their individual Debian package versions: the exact OS
closure is image-digest/SBOM governed at build/release time. This notice does
not invent versions that the checked-in source cannot prove.

| OS component | Version evidence | Canonical source | License |
| --- | --- | --- | --- |
| [tini](https://github.com/krallin/tini) | Dynamic Debian package; release SBOM is authoritative | krallin/tini | MIT |
| [Mozilla CA Certificate Store](https://www.mozilla.org/en-US/about/governance/policies/security-group/certs/) / Debian `ca-certificates` | Dynamic Debian package; release SBOM is authoritative | Mozilla / Debian | MPL-2.0 and package-local notices |
| [Chromium](https://chromium.googlesource.com/chromium/src/) headless shell | Dynamic Debian package; release SBOM is authoritative | Chromium authors | BSD-style and third-party notices |
| [ICU](https://github.com/unicode-org/icu) (`libicuNN`) | Highest available Debian `libicuNN`, selected at image build | Unicode | ICU License |
| [GNU tar](https://www.gnu.org/software/tar/) | Dynamic Debian package; release SBOM is authoritative | GNU | GPL-3.0-or-later |
| [PostgreSQL client](https://www.postgresql.org/) utilities | 17 from the final image; 16 binaries copied from the pinned build stage | PostgreSQL Global Development Group | PostgreSQL License |

Supported Compose/deployment paths also reference the following third-party
images; the declared release tags are the source-level pins:

| Component | Declared pin | Canonical source | License |
| --- | --- | --- | --- |
| [PostgreSQL](https://www.postgresql.org/) | `postgres:16` | PostgreSQL Global Development Group | PostgreSQL License |
| [pgvector](https://github.com/pgvector/pgvector) | `pgvector/pgvector:pg17` | pgvector | PostgreSQL License |
| [Logto](https://github.com/logto-io/logto) | 1.38.0 | Logto | MPL-2.0 |
| [Collabora Online](https://www.collaboraonline.com/code/) | `collabora/code:26.04.1.4.1` | Collabora | MPL-2.0 |
| [nginx](https://nginx.org/) | `nginx:1.27-alpine` | F5/nginx | BSD-2-Clause |
| [local-neon-http-proxy](https://github.com/timowilhelm/local-neon-http-proxy) | source digest `cd2ae14e…bdeb768a` | timowilhelm | MIT |
| [OOMOL OpenConnector](https://github.com/oomol-lab/open-connector) | 1.4.1 + Nautilo patch | OOMOL | Apache-2.0 |

The image's release SBOM, when produced by the release pipeline, is the
authoritative artifact-level record for base-image and operating-system
packages. The repository's source pin alone cannot establish their exact
package revisions or their full nested notices.

## OpenAI Codex apply-patch extraction (shipped server runtime boundary)

- **Version:** `3389fa554e953d07a12a34f5681aae46f17958f8`
- **License:** Apache-2.0
- **Source:** https://github.com/openai/codex
- **Scope:** Nautilo ships a reviewed subset of Codex `apply-patch` parser,
  matching, and portable test-fixture source as the server's vendored
  `nautilo-apply-patch` runtime. The image distributes the upstream Apache
  `LICENSE`, `NOTICE`, and machine-readable `UPSTREAM.toml` provenance record
  alongside those verified bytes.
- **Nautilo modification notices:** Nautilo has modified extracted source files; each
  modified file carries a prominent Nautilo modification notice. The reviewed
  source/hash and update record is `native/apply-patch/UPSTREAM.toml`.

## Nautilo apply-patch runtime Cargo closure

The locked `native/apply-patch/Cargo.lock` contains only the fixed JSON protocol
closure recorded with exact versions and licenses in `UPSTREAM.toml`:

| Crate | Version | License | Canonical source |
| --- | --- | --- | --- |
| [itoa](https://crates.io/crates/itoa/1.0.18) | 1.0.18 | MIT OR Apache-2.0 | crates.io |
| [memchr](https://crates.io/crates/memchr/2.8.3) | 2.8.3 | Unlicense OR MIT | crates.io |
| [proc-macro2](https://crates.io/crates/proc-macro2/1.0.107) | 1.0.107 | MIT OR Apache-2.0 | crates.io |
| [quote](https://crates.io/crates/quote/1.0.47) | 1.0.47 | MIT OR Apache-2.0 | crates.io |
| [serde](https://crates.io/crates/serde/1.0.229) / [serde_core](https://crates.io/crates/serde_core/1.0.229) / [serde_derive](https://crates.io/crates/serde_derive/1.0.229) | 1.0.229 | MIT OR Apache-2.0 | crates.io |
| [serde_json](https://crates.io/crates/serde_json/1.0.151) | 1.0.151 | MIT OR Apache-2.0 | crates.io |
| [syn](https://crates.io/crates/syn/3.0.3) | 3.0.3 | MIT OR Apache-2.0 | crates.io |
| [unicode-ident](https://crates.io/crates/unicode-ident/1.0.24) | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | crates.io |
| [zmij](https://crates.io/crates/zmij/1.0.23) | 1.0.23 | MIT | crates.io |

They are independently resolved Cargo packages, not imported Codex packages.
No Codex execution, protocol, sandbox, network, PTY, WebSocket, or TLS
dependency is shipped.

## OpenMLS WASM and Cargo closure

Nautilo distributes a reviewed, modified `openmls-wasm` wrapper and its
compiled `openmls_wasm_bg.wasm` artifact. The wrapper is derived from
[OpenMLS](https://github.com/openmls/openmls) tag `openmls-v0.8.1`, commit
`47dbedecad0c1fd8eb5368d582250ebfcc1e1ce6`, under MIT. The wrapper's MIT
notice and the imported lattice-lab MIT notice are retained in the shipped
`packages/lattice-crypto` material.

Its exact `wasm32-unknown-unknown` registry closure is **173 packages**. The
complete package-by-package table—with every crate name, exact version,
license expression, and canonical crates.io link—is retained in
[`packages/lattice-crypto/THIRD_PARTY_NOTICES.cargo.md`](packages/lattice-crypto/THIRD_PARTY_NOTICES.cargo.md)
and is copied into the server runtime alongside the artifact. In particular,
the active build includes [hpke-rs](https://github.com/cryspen/hpke-rs),
`hpke-rs-crypto`, and `hpke-rs-rust-crypto` 0.6.1 under MPL-2.0; its lock
also records optional `hpke-rs-libcrux` 0.6.1 (MPL-2.0), which is not present
in the selected WASM build. This separate full inventory is necessary because
the Rust artifact's closure is materially larger than its JavaScript wrapper.

The following sections record the third-party software and bundled data included by the
Workbench and mobile OOXML Reader. `apps/workbench/package.json` declares
`@silurus/ooxml` as `~0.75.0`, while the release lock resolves that declaration
to **0.75.2**; mobile explicitly pins 0.75.2. No legacy Workbench OOXML renderer
is included by this notice closure.

## @silurus/ooxml

- **Version:** 0.75.2
- **License:** MIT
- **Source:** https://github.com/yukiyokotani/office-open-xml-viewer
- **Published notice provenance:**
  `node_modules/@silurus/ooxml/THIRD_PARTY_NOTICES.md` in the exact installed
  npm package. The package declares that notice file in its published `files`
  list and contains no separate Apache-2.0 `NOTICE` file.

```text
MIT License

Copyright (c) 2026 Yuki Yokotani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled JavaScript asset

The package includes an optional equation-rendering asset,
`mathjax-stix2.js`. Workbench deliberately does not import
`@silurus/ooxml/math`, so that asset is not emitted by the ordinary document-preview
build; its notice is retained here because it is part of the published package
closure.

- **MathJax** (`@mathjax/src`, 4.1.2), Apache-2.0, Copyright © MathJax
  Consortium — https://github.com/mathjax/MathJax-src
- **STIX Two Math** (`@mathjax/mathjax-stix2-font`, 4.1.2), Apache-2.0,
  Copyright © MathJax Consortium — https://github.com/mathjax/MathJax-fonts

The installed package records that neither package supplies a separate
Apache-2.0 section 4(d) `NOTICE` file. The Apache-2.0 license applies:

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including compiled
      object code, generated documentation, and conversions to other media
      types.

      "Work" shall mean the work of authorship, whether in Source or Object
      form, made available under the License, as indicated by a copyright
      notice that is included in or attached to the work.

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including the
      original version of the Work and any modifications or additions to that
      Work or Derivative Works thereof, that is intentionally submitted to
      Licensor for inclusion in the Work by the copyright owner or by an
      individual or Legal Entity authorized to submit on behalf of the
      copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent to
      the Licensor or its representatives for the purpose of discussing and
      improving the Work, but excluding communication conspicuously marked
      or otherwise designated in writing by the copyright owner as "Not a
      Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of this
      License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable by
      such Contributor that are necessarily infringed by their Contribution(s)
      alone or by combination of their Contribution(s) with the Work to which
      such Contribution(s) was submitted. If You institute patent litigation
      against any entity alleging that the Work or a Contribution incorporated
      within the Work constitutes direct or contributory patent infringement,
      then any patent licenses granted to You for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the Work or
      Derivative Works thereof in any medium, with or without modifications,
      and in Source or Object form, provided that You meet the following
      conditions:

      (a) You must give any other recipients of the Work or Derivative Works
          a copy of this License; and

      (b) You must cause any modified files to carry prominent notices stating
          that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works that You
          distribute, all copyright, patent, trademark, and attribution notices
          from the Source form of the Work, excluding those notices that do not
          pertain to any part of the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its distribution,
          then any Derivative Works that You distribute must include a readable
          copy of the attribution notices contained within such NOTICE file,
          excluding those notices that do not pertain to any part of the
          Derivative Works, in at least one of the following places: within a
          NOTICE text file distributed as part of the Derivative Works; within
          the Source form or documentation, if provided along with the
          Derivative Works; or, within a display generated by the Derivative
          Works, if and wherever such third-party notices normally appear. The
          contents of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution notices
          within Derivative Works that You distribute, alongside or as an
          addendum to the NOTICE text from the Work, provided that such
          additional attribution notices cannot be construed as modifying the
          License.

      You may add Your own copyright statement to Your modifications and may
      provide additional or different license terms and conditions for use,
      reproduction, or distribution of Your modifications, or for any such
      Derivative Works as a whole, provided Your use, reproduction, and
      distribution of the Work otherwise complies with the conditions stated
      in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work by
      You to the Licensor shall be under the terms and conditions of this
      License, without any additional terms or conditions. Notwithstanding the
      above, nothing herein shall supersede or modify the terms of any separate
      license agreement you may have executed with Licensor regarding such
      Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or agreed to
      in writing, Licensor provides the Work (and each Contributor provides its
      Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
      ANY KIND, either express or implied, including, without limitation, any
      warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or
      FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for
      determining the appropriateness of using or redistributing the Work and
      assume any risks associated with Your exercise of permissions under this
      License.

   8. Limitation of Liability. In no event and under no legal theory, whether
      in tort (including negligence), contract, or otherwise, unless required
      by applicable law (such as deliberate and grossly negligent acts) or
      agreed to in writing, shall any Contributor be liable to You for damages,
      including any direct, indirect, special, incidental, or consequential
      damages of any character arising as a result of this License or out of
      the use or inability to use the Work (including damages for loss of
      goodwill, work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor has been
      advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing the
      Work or Derivative Works thereof, You may choose to offer, and charge a
      fee for, acceptance of support, warranty, indemnity, or other liability
      obligations and/or rights consistent with this License. However, in
      accepting such obligations, You may act only on Your own behalf and on
      Your sole responsibility, not on behalf of any other Contributor, and
      only if You agree to indemnify, defend, and hold each Contributor harmless
      for any liability incurred by, or claims asserted against, such
      Contributor by reason of your accepting any such warranty or additional
      liability.

   END OF TERMS AND CONDITIONS
```

## Rust/WebAssembly parser closure

The shipped `docx_parser_bg.wasm`, `xlsx_parser_bg.wasm`, and
`pptx_parser_bg.wasm` files are built from the three format parser crates and
the shared `ooxml-common` crate. The installed package's published notice
records the following `wasm32-unknown-unknown` dependency closure:

| License | Crates |
|---|---|
| MIT OR Apache-2.0 | bumpalo, cfg-if, console_error_panic_hook, crc32fast, displaydoc, equivalent, flate2, hashbrown, indexmap, itoa, log, once_cell, proc-macro2, quote, roxmltree, rustversion, serde, serde_core, serde_derive, serde_json, syn, thiserror, thiserror-impl, wasm-bindgen, wasm-bindgen-macro, wasm-bindgen-macro-support, wasm-bindgen-shared |
| (Apache-2.0 OR MIT) AND Unicode-3.0 | unicode-ident |
| 0BSD OR Apache-2.0 OR MIT | adler2 |
| Apache-2.0 | zopfli |
| Apache-2.0 OR MIT OR Zlib | miniz_oxide |
| MIT | simd-adler32, zip, zmij |
| MIT OR Unlicense | memchr |

The published package states that this closure contains no GPL, LGPL, or AGPL
dependency. Full license texts are available from crates.io or each crate's
repository; the SPDX identifiers above are the exact identifiers recorded in
the package provenance.

## Unicode Character Database data

Silurus compiles line-breaking, vertical-orientation, and Arabic-shaping data
from the Unicode Character Database into shipped parser code. That data is
licensed under Unicode License v3 (SPDX `Unicode-3.0`).

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS
INCLUDED IN THIS NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT
OR CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THE DATA FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

The exact upstream package notice also describes a separately distributed MCP
server. Workbench does not package or invoke that binary.

Board engine HTML parsing additionally bundles parse5 8.0.1 (MIT) and entities
8.0.0 (BSD-2-Clause). Complete copyright and license texts are retained in
`packages/office-board/NOTICE.md`. Board app activation is separate from engine intake.
