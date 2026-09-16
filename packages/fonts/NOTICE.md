# Bundled font notices

These notices apply to the font files in `assets/`, independently of the
license of Nautilo's font registry code. The exact file hashes, sizes and
embedded metadata are recorded in [assets.manifest.json](assets.manifest.json).

| Files (under assets/) | Embedded version | Copyright | License |
| --- | --- | --- | --- |
| `arabic/NotoNaskhArabic-Regular.ttf` | Version 1.05 | Copyright 2014 Google Inc. All Rights Reserved. | [Apache-2.0](licenses/Apache-2.0.txt) |
| `cjk/jp/NotoSansCJKjp-Regular.otf` | Version 2.004 | © 2014-2021 Adobe (http://www.adobe.com/). | [OFL-1.1](licenses/OFL-1.1.txt) |
| `cjk/sc/NotoSansCJKsc-Regular.otf` | Version 2.004 | © 2014-2021 Adobe (http://www.adobe.com/). | [OFL-1.1](licenses/OFL-1.1.txt) |
| `cjk/tc/NotoSansCJKtc-Regular.otf` | Version 2.004 | © 2014-2021 Adobe (http://www.adobe.com/). | [OFL-1.1](licenses/OFL-1.1.txt) |
| `core/mono/NotoSansMono-Regular.ttf` | Version 2.007 | Copyright 2015-2021 Google LLC. All Rights Reserved. | [OFL-1.1](licenses/OFL-1.1.txt) |
| `core/sans/NotoSans-Bold.ttf` | Version 2.008 | Copyright 2015-2021 Google LLC. All Rights Reserved. | [OFL-1.1](licenses/OFL-1.1.txt) |
| `core/sans/NotoSans-Regular.ttf` | Version 2.008 | Copyright 2015-2021 Google LLC. All Rights Reserved. | [OFL-1.1](licenses/OFL-1.1.txt) |
| `core/serif/NotoSerif-Regular.ttf` | Version 2.007 | Copyright 2015-2021 Google LLC. All Rights Reserved. | [OFL-1.1](licenses/OFL-1.1.txt) |
| `emoji/NotoColorEmoji.ttf` | Version 2.051 | Copyright 2022 Google Inc. | [OFL-1.1](licenses/OFL-1.1.txt) |

The older Noto Naskh Arabic file declares **Apache-2.0**, not OFL; its separate
license is retained here. No font was modified as part of adding this record.

## Exact upstream byte identities

All nine files match immutable upstream Git blob IDs and byte sizes, verified
through anonymous HTTPS on September 15, 2026. The manifest records each exact
revision, upstream path, blob ID and download URL. The Arabic and four core
fonts also match independently downloaded upstream bytes by SHA-256. The larger
CJK and emoji files were matched through Git metadata without downloading them
again; their local SHA-256 values were checked against the manifest.

| Files | Byte-equivalent upstream snapshot |
| --- | --- |
| Noto Naskh Arabic 1.05 | [Noto fonts, `45c4c9d0`](https://github.com/notofonts/noto-fonts/blob/45c4c9d0e1e8f24c1c7928a8637ceed014deb704/hinted/NotoNaskhArabic-Regular.ttf) |
| Noto Sans Regular/Bold, Noto Sans Mono, Noto Serif | [Noto fonts, `ffebf8c1`](https://github.com/notofonts/noto-fonts/tree/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf) |
| Noto Sans CJK JP/SC/TC | [Noto CJK, `f8d15753`](https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF) |
| Noto Color Emoji | [Noto Emoji, `8998f5dd`](https://github.com/googlefonts/noto-emoji/blob/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts/NotoColorEmoji.ttf) |

These matches establish public sources for the exact bundled bytes. They do
not reconstruct the original download date or operator, or constitute a
separate legal clearance. The Arabic file retains its embedded Apache-2.0
declaration; the later OFL versions are different font bytes. No font or license
text was changed when these source references were added.

The OFL text was obtained from [Noto Emoji's license file](https://github.com/googlefonts/noto-emoji/blob/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts/LICENSE).
That reference identifies the license text, not the source of these font bytes.
The Apache text comes from the [Apache Software Foundation](https://www.apache.org/licenses/LICENSE-2.0.txt).
The font-specific copyright statements above are preserved from the binaries.
