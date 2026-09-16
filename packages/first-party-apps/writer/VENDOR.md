# Writer engine provenance

Writer consumes Nautilo-owned `@nautilo/office-docs` 0.6.9 from
`packages/office-docs`, using the existing `@nautilo/office-core` source.
Both are private internal packages built by the normal Bun/Turbo graph.

The source derives from Wafflebase revision
`acde58012910ec68645c65b6896d5408fad1645c` and reviewed Nautilo checkpoint
`182b804441a4130a394820df73a714b694152566` (Docs tree
`085c0df19858e8abeb6b63149e0d7c88d603ac7c`). Apache-2.0, original copyrights,
spell dictionary licenses and modification notices are retained. See
[Office provenance](../../../docs/office-engines/README.md) and
[modifications](../../../docs/office-engines/CHANGES.md).

Use `/browser` for the editor, MemDocStore and spell providers and `/node` for
model/serialization and headless tools. NautiloDocStore keeps its injected
browser-store constructor. All consumers use the same owned source model;
stored document MIME types and identifiers are unchanged.

Standalone app installs use relative file dependencies and frozen locks;
Docker compiles the engine before installing/seed-copying Writer. The full
dist tree includes dynamically loaded dictionary chunks. No registry publishing
or upstream service is needed.
