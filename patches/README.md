# Dependency patch maintenance

## Knip 5.88.1 explicit Bun test files

`knip@5.88.1.patch` keeps existing file arguments in Bun test commands as
file entries. The unpatched plugin appends directory globs to them and can
abort Windows scans with `ENOTDIR`. Directory and glob arguments retain
their existing behavior.

Remove this patch when the pinned Knip release handles explicit Bun test
files and `dev/tests/repo-invariants/knip-bun-file-entry.test.ts` passes
without it.

## LangGraph 1.2.9 checkpoint promise ownership

`@langchain%2Flanggraph@1.2.9.patch` applies to both distributed ESM and CJS
artifacts. LangGraph creates derived rejected checkpoint promises and only
observes them at graph exit. A checkpoint failure during a node await can
therefore terminate Bun despite the caller awaiting and catching the turn.

The patch immediately observes each retained promise and still propagates its
original rejection through the turn. Finalization drains every pending save
with `allSettled`, even if a sibling save or store/cache stop fails. It neither
changes checkpoint contents nor installs a global rejection handler.

Remove the patch when the pinned upstream release provides immediate rejection
ownership and unconditional draining, and the hermetic ESM/CJS regressions in
`packages/agent/tests/unit/checkpoint-failure-containment.test.ts` pass without it.
