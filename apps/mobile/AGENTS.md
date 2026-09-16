# Working on Nautilo Mobile

Apply the [root working rules](../../AGENTS.md) and
[architecture orientation](../../README.ai). This subtree is the Nautilo
Expo/React Native client and Mobile Web export, not an Expo starter project.
See [README.md](README.md) for commands and [releases/README.md](releases/README.md)
for release identity.

## Use the installed platform contract

The checked-in app currently uses Expo SDK 57 and React Native 0.86. Read the
relevant [versioned Expo API documentation](https://docs.expo.dev/versions/v57.0.0/)
before changing native/platform code. `package.json`, the root `bun.lock`,
`app.json`, Metro configuration, and existing adapters determine what this app
actually supports. Do not copy an older Expo API or change dependency versions
just to match a generic example.

Install dependencies from the repository root with Bun. Preserve workspace
resolution in `metro.config.js`; do not create an independent npm lockfile or
replace the monorepo configuration. Use a development build for native work
that depends on Nautilo's config plugins/modules. Expo Go is not sufficient
acceptance evidence for those features. Do not run `reset-project`: that
retained starter utility is not a Nautilo maintenance procedure.

## Source map

- `src/app/` — Expo Router layouts and routes, including Room/chat navigation.
- `src/providers/` — server selection, authentication, realtime, voice,
  notifications, user agreement, and inbound-intent lifecycles.
- `src/hooks/`, `src/features/`, `src/components/` — reusable screen behavior,
  feature controllers, and UI.
- `src/lib/` — API/auth adapters, server-bound storage, document/media bytes,
  platform handoffs, and release contracts.
- `src/theme/tokens.ts` — shared Mobile visual tokens.
- `plugins/` and `modules/` — native/config-plugin integration where present;
  inspect the matching `app.json` plugin before changing native behavior.
- `scripts/` — isolated unit runner and verified Mobile Web export.
- `releases/` — semantic release notes and exact source/EAS/store records.

## Identity and platform boundaries

Use `@nautilo/api-client/browser`, `@nautilo/realtime-client`, and shared types.
Reuse the canonical server registry, auth provider, and `src/lib/api.ts`
composition rather than creating a second API client or token cache per screen.
Native Logto configuration is discovered from the selected server. Preserve
per-server token revisions and refresh coordination; late work from an old
server/session must not update the replacement's state.

Keep `.native` and `.web` implementations explicit. Browser storage, DOM,
WebView, native permissions, download/share APIs, and push lifecycles are not
interchangeable. Browser-only OOXML/WASM viewer dependencies must not enter the
native bundle; Metro has an explicit guard for that boundary.

Read `src/lib/release-contract.ts` before enabling a server mode. The current
Mobile release contract allows `plaintext_only` and reports protected modes
as unavailable. Shared crypto packages or Browser support do not establish
native Mobile qualification. Do not remove admission checks to make a screen
load.

For paired-workstation actions, preserve the selected Desktop/Relay identity
and its grants. A phone does not acquire local filesystem or Computer Use
authority merely by being in the same Room.

## Product behavior to preserve

- Keep Room/thread identity, per-Room drafts, selected responders, message
  history, stream reconciliation, and background Task state attached to their
  canonical owners across focus changes and reconnects.
- Use theme tokens, safe-area handling, and the existing keyboard/composer
  controllers. Verify editing with the keyboard open, Android back behavior,
  sheet dismissal, dynamic text, and light/dark presentation when affected.
- Preserve exact Artifact bytes, filenames, media types, and document versions
  through preview, download, share, and save-original actions. Native and Web
  handoffs need separate verification.
- Voice and media work must respect interruption, navigation, and foreground
  lifecycle. Notification identity follows the current server/Human binding.
- Preserve account deletion, blocking/reporting, consent, and reauthentication
  behavior when changing settings or onboarding.

## Verification

Run from the repository root:

```bash
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test:unit
```

The canonical unit runner executes each file in a fresh Bun process because
native/auth mocks are process-global. Do not replace it with one combined
`bun test src` invocation. A focused single-file test is appropriate while
iterating. Pure tests must not require a device, live server, or credentials.

For Mobile Web changes, run `bun run --cwd apps/mobile export:web`; this wrapper
validates generic export and shared-viewer output before promoting `dist`.
For native changes, qualify the affected iOS/Android development build and
rebuild when native dependencies or plugins change. State which platforms and
flows were actually checked; passing Web tests is not native acceptance.

## Release identity

Update `app.json`, `package.json`, `src/lib/release-contract.ts`, release notes,
and ledger together when changing the semantic version. Official native builds,
remote counters, signing and store submission are maintained outside this source
tree. Record verified source/EAS identities and tester availability in the ledger;
do not infer distribution from build completion. The checked-in EAS profiles are
for contributor builds with local version inputs and local device credentials.
Keep credentials and generated native artifacts out of commits.
