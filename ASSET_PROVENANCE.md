# Asset provenance

This record covers non-code artwork, audio, fonts and document fixtures
tracked for Nautilo. It describes recorded origins; it is not a per-asset
rights-clearance receipt. Unless noted below, Kentauros AI created or commissioned these
assets for the project and permits their redistribution with Nautilo under the
[MIT License](LICENSE), to the extent it holds rights in them. The Nautilo name
and logos remain project trademarks; the license does not imply endorsement.

## Project-created and generated assets

- Brand masters under `assets/brand/` were created for Nautilo using internal
  design work and generative-image tools. The
  [Desktop generator](apps/desktop/scripts/generate-icons.ts) derives application
  and tray icons from two named masters and creates the plain installer
  backgrounds. The [Mobile generator](apps/mobile/scripts/generate-release-icons.sh)
  uses the retained Mobile `icon.png` to produce the Android foreground,
  monochrome and splash icons. The Mobile source icon, branding SVG and favicon,
  and `packages/server/src/onboarding/images/server/server-default.png`, are
  retained project brand derivatives under the category attestation above;
  their original generation recipes are not recorded here.
- Preset avatars under `packages/server/src/onboarding/images/avatars/` were
  generated for Nautilo with OpenAI image models and adopted as project assets.
- Onboarding narration and voice samples under
  `packages/server/src/onboarding/audio/` were generated for Nautilo with
  ElevenLabs under a paid plan permitting commercial use. The spoken scripts
  are project content.
- Geometric server icon presets are deterministic outputs of
  `packages/server/scripts/generate-server-icon-presets.ts`.
- Blank Office templates and Desktop Office samples were created for Nautilo
  with LibreOffice or Collabora. Their document content is project-created test
  and runtime material.
- The Writer, Design, Sheets, Slides, and Board icons and preview captures under
  `apps/workbench/public/apps/office/` were created for Nautilo. The previews
  show Nautilo's own editors using fictional Studio North content; they contain
  no customer, account, or private instance data. The asset README records the
  category-level origin and capture descriptions. Sheets, Slides, and Board also
  have checked-in generators for reproducible captures; Writer and Design are
  retained under the project-created category-level attestation above.
- The OOXML qualification corpus under
  `apps/workbench/tests/fixtures/ooxml/`, including its text, data, color-study
  image, generated Office files, and local reference renders, was created for
  Nautilo from the checked-in fixture generators. It contains no customer or
  private documents.

## Additional source documentation and test assets

These assets are retained as source documentation or test fixtures, separately
from the five Office app previews described above:

| Assets | Recorded context |
| --- | --- |
| Five PNGs under `docs/office-engines/board-design/` | The [Board interface study](docs/office-engines/board-interface.md) records the local interactive mock and example content. |
| Eleven PNGs under `docs/office-engines/board-native/` | Synthetic editor fixtures captured by the [surface browser harness](packages/first-party-apps/board/scripts/qualify-browser.ts) and [canonical browser harness](packages/first-party-apps/board/scripts/qualify-canonical-browser.ts); results and images are retained in [board-native](docs/office-engines/board-native/). |
| `packages/server/tests/integration/fixtures/d391-roundtrip.docx` | Project test document with a round-trip heading and body paragraph, created with OfficeCLI; also listed in the [OOXML corpus manifest](apps/workbench/tests/fixtures/ooxml/manifest.json). |

These records describe their test and capture context. They do not establish a
new per-image privacy or rights-clearance review.

## Inherited Office fixture

`packages/office-docs/test/export/fixtures/pdf/test-image.png` came from
Wafflebase's `packages/docs/test/export/fixtures/pdf/test-image.png`. Its exact
upstream revision and intake SHA-256 are recorded in the
[Office snapshot](docs/office-engines/snapshot.json). It is covered by the
package's [Apache-2.0 license](packages/office-docs/LICENSE) and
[upstream notice](packages/office-docs/NOTICE.md), independently of the MIT
declaration for project-created assets above.

## Expo-derived mobile assets

The `home` and `explore` raster tab icons under
`apps/mobile/assets/images/tabIcons/` originated in the Expo application
template and are used under Expo's MIT License. The complete Expo license and
copyright notice are retained in [`apps/mobile/LICENSE`](apps/mobile/LICENSE).

Provider and project names are used only to describe provenance. No provider
endorses or sponsors Nautilo.

## Third-party fonts

The nine Noto files in `packages/fonts/assets/` retain their own licenses,
independently of the MIT license for project-created material above. Their
embedded versions, copyrights, license declarations and file hashes are in
[`packages/fonts/NOTICE.md`](packages/fonts/NOTICE.md) and its linked manifest.
Full OFL-1.1 and Apache-2.0 texts travel with that package. The older bundled
Arabic font declares Apache-2.0. Each bundled font now has a verified,
byte-equivalent public upstream snapshot recorded in the manifest. This closes
the exact upstream-byte identification gap; it does not reconstruct the original
download history or constitute a separate rights-clearance claim.

## Record scope

This is the repository's category-level asset provenance record. Checked-in
generators, manifests, embedded metadata, retained third-party license texts,
and the specific records linked above provide the inspectable evidence that is
available with the source. Private commercial receipts and provider account
records are not part of the public repository and are not required as
per-asset public files.

Source fixtures and captures are inventoried separately from release payloads;
their presence in Git does not by itself mean that they ship in an installer.
