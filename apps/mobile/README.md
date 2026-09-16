# Nautilo Mobile

Nautilo's iOS, Android, and Mobile Web client lives here. It supports Room/chat
collaboration, Genies and delegated Tasks, Memory and files, voice, document
and media viewing, notifications, and server/account settings. It connects to
a Nautilo server through shared typed API and realtime clients.

Read [AGENTS.md](AGENTS.md) for development boundaries and the
[root source orientation](../../README.ai) for cross-package ownership.
This is an existing Bun workspace application; do not reset it with the
retained Expo starter utility.

## Start development

Install from the repository root:

```bash
bun install --frozen-lockfile
```

Then choose the relevant package script, also from the root:

```bash
bun run --cwd apps/mobile start
bun run --cwd apps/mobile ios
bun run --cwd apps/mobile android
bun run --cwd apps/mobile web
```

`start` runs Metro; `ios` and `android` build/run native development clients and
require the matching native toolchain. Nautilo uses custom config plugins and
native modules, so Expo Go is not a substitute for a development build. Use a
named Nautilo development instance and a server URL reachable from the device;
phone/emulator loopback and the host's loopback are different network contexts.
Select or register that server through the app's existing connection flow.

The app currently targets Expo SDK 57 and React Native 0.86. Consult the
[SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/) for affected APIs;
`package.json` and the root lockfile retain exact dependency authority.

## Source and platform layout

Expo Router routes are under `src/app/`, lifecycle owners under
`src/providers/`, feature controllers under `src/features/` and `src/hooks/`,
and reusable UI under `src/components/`. `src/lib/` contains API, authentication,
server storage, Artifact/media, and platform adapters. Shared visual tokens
live in `src/theme/tokens.ts`.

Keep native and Web adapters separate. Native secure storage, Web sessions,
share/download behavior, viewers, and push lifecycles have different APIs.
The Mobile Web export is served by Nautilo's server; it does not embed a server.
The current [release contract](src/lib/release-contract.ts) supports
`plaintext_only` servers and treats protected modes as unavailable. Do not
infer native encryption readiness from shared Browser code.

## Checks and production Web export

```bash
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test:unit
bun run --cwd apps/mobile export:web
```

The unit runner isolates each test file to avoid shared native-module mock
state. `export:web` stages the Expo export, verifies static output and the
shared browser-viewer payload, and only then replaces `dist`. Use this wrapper
for deployable Mobile Web output rather than an unchecked Expo export.

Native feature acceptance requires the affected iOS and Android builds when
applicable, including their permission, keyboard, background/foreground, and
file/media handoff behavior. A successful Web export or mocked unit suite does
not establish native acceptance.

## Builds and distribution

[EAS profiles](eas.json) retain contributor simulator, development-device and
internal builds. They use local version inputs and do not allocate official
remote counters. All profiles use contributor-owned
[local credentials](https://docs.expo.dev/app-signing/local-credentials/);
iOS simulator builds require no signing credentials. `credentials.json` and
native signing files remain ignored. The ordinary
`ios`/`android` development commands above remain available.

Official native builds, signing and store submission are maintained outside this
source tree. The [release records](releases/README.md) and
[ledger](releases/ledger.json) identify exact source commits, EAS IDs, native
counters and verified tester/store state. TestFlight/Play internal availability
and public rollout are separate milestones. See the
[root release guide](../../RELEASE.md#mobile-store-builds-and-tester-availability)
for the public Mobile release contract.
