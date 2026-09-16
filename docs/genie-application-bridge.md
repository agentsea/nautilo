# Genie Application Bridge

## Adding a stable destination

1. Add the stable destination and `catalogueTarget` to its canonical rendered Workbench manifest: route, Settings, Connections, Admin, or access-control. Do not catalogue resource instances, actions, redirects, or disabled affordances.
2. Add matching route-free semantic metadata to `apps/workbench/src/lib/application-catalogue-manifest.ts`. Do not add a route, selector, executable handler, capability, or mutation there.
3. Run `bun dev/scripts/generate-application-catalogue.ts --write` and commit the resulting generated metadata artifact.
4. Add the installed Workbench route, focus, availability, and presentation disposition in `apps/workbench/src/lib/genie-application-targets.ts`. Workbench is shared by browser and Desktop; executable behavior stays local to it and the shared catalogue remains route-free.
5. Extend the manifest-to-catalogue-to-disposition coverage in `apps/workbench/tests/unit/genie-application-targets.test.ts`. Verify with `bun dev/scripts/generate-application-catalogue.ts`, `bun test --timeout 60000 packages/types/tests/unit/genie-application-bridge.test.ts apps/workbench/tests/unit/genie-application-targets.test.ts`, and `bun run --cwd apps/workbench typecheck`.

Remote catalogue updates are metadata-only. They may refresh labels, descriptions, menu paths, and discovery terms for the installed target set; they cannot add routes, selectors, focus behavior, native handlers, capabilities, or mutations.

Mobile has no D513 target adapter yet. Do not add a Mobile mapping, deep link, or automatic presentation here; that work is explicitly deferred to Phase 7 after RC1 qualification. TUI is retired and receives no compatibility work.

`launch_customization` remains the canonical consent-gated typed recovery producer. `guide_user` is the separate semantic discovery and presentation tool; do not merge those responsibilities. The retired sentinel, listener, dialog, route prose, and duplicate presentation paths remain absent.
