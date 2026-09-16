# Bundled Design fonts

The Design app generates its deterministic font catalogue in
`src/bundled-fonts.ts` from these canonical repository assets:

- `packages/fonts/assets/core/sans/NotoSans-Regular.ttf`, SHA-256 `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`
- `packages/fonts/assets/core/sans/NotoSans-Bold.ttf`, SHA-256 `c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a`
- `packages/fonts/assets/core/serif/NotoSerif-Regular.ttf`, SHA-256 `c8f669ceb2c9c60ccf55198b305e08a997ffca79a38cc7eeb551e643cbe66505`
- `packages/fonts/assets/core/mono/NotoSansMono-Regular.ttf`, SHA-256 `d9e2b23d19f8230be7146f409a52b1d23117e635e28f2e2892cf91b7382f325b`

Run `bun scripts/generate-bundled-fonts.ts` from the Design package after an
intentional asset update. CI and local verification can run the same command
with `--check`. The generator verifies each complete face by SHA-256 before it
updates the module. SVG documents embed only the faces they use; the complete
face remains intact so it retains a browser-readable character map.

The catalogue intentionally contains Noto Sans Regular and Bold, Noto Serif
Regular, and Noto Sans Mono Regular. It does not advertise synthetic weights or
ambient system fonts. Arabic, CJK, emoji, and user-installed fonts require
layout and portable-asset support before Design can promise matching browser,
SVG, and PNG output.

The font metadata names Google LLC as a copyright holder and licenses the files
under the SIL Open Font License, Version 1.1. The complete license and copyright
notice are reproduced in [`OFL.txt`](./OFL.txt).
