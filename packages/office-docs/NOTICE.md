# Nautilo-owned docs engine

Derived from Wafflebase packages/docs, revision
acde58012910ec68645c65b6896d5408fad1645c (upstream version 0.6.9).
Original source: https://github.com/wafflebase/wafflebase
Licensed under Apache-2.0; see LICENSE. No upstream NOTICE was present.

Modified by Nautilo from 2026-09-06 through 2026-09-11: private package identity,
owned internal imports and workspace/test/build configuration. Browser and Node
entry points are explicit. Original copyright notices are retained.
See ../../docs/office-engines/CHANGES.md and snapshot.json for modifications,
original-file hashes and the selective upstream maintenance policy. The Writer
intake retains reviewed checkpoint 182b804441a4130a394820df73a714b694152566,
with additional data-only Node exports, owned browser output filenames and
standalone local dependency resolution. Internal version pins resolve to the
matching root workspaces; standalone Writer overrides bind them to local source.
