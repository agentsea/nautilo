# @nautilo/fonts

Shared document font registry for generated files and viewers.

This package owns:

- semantic document font roles (`sans`, `serif`, `mono`, `cjkSans`, `arabic`, `emoji`)
- bundled default font assets
- script/glyph detection helpers
- renderer integrations such as React-PDF registration

Font provenance and the embedded license declarations are documented in
[NOTICE.md](NOTICE.md); [assets.manifest.json](assets.manifest.json) records exact
file hashes. Full font licenses are retained under `licenses/`. Keep these files
with the assets when packaging or copying this package.

Recorded project families:

- Noto Sans / Noto Serif / Noto Sans Mono from `notofonts/noto-fonts`
- Noto Sans CJK SC/TC/JP from `notofonts/noto-cjk`
- Noto Naskh Arabic Regular 1.05 matches `notofonts/noto-fonts` at the immutable revision recorded in the manifest
- Noto Color Emoji from `googlefonts/noto-emoji`

Emoji note: the emoji font is bundled for future support, but React-PDF color emoji
rendering is not yet treated as supported until verified.
