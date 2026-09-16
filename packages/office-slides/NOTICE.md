# Nautilo-owned slides engine

Derived from Wafflebase packages/slides, revision
acde58012910ec68645c65b6896d5408fad1645c (upstream version 0.6.9).
Original source: https://github.com/wafflebase/wafflebase
Licensed under Apache-2.0; see LICENSE. No upstream NOTICE was present.

Modified by Nautilo on 2026-09-06 and 2026-09-08: private package identity,
owned internal imports and workspace/test/build configuration. Browser and Node
entry points are explicit. Original copyright notices are retained.
Modified on 2026-09-11: DOM-free theme export, compatible distinct Slides table
type names, and generated native-model schema tooling for Genie authoring.
Modified on 2026-09-11: lossless native color adoption, master/layout placeholder
geometry and identity preservation, and explicit PowerPoint fidelity reporting.
See ../../docs/office-engines/CHANGES.md and snapshot.json for modifications,
original-file hashes and the selective upstream maintenance policy.

Modified on 2026-09-13: expose existing pure viewport, connector-site and theme
helpers through the Node entry for the owned Board engine.
