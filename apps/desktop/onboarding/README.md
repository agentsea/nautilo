# Genie customization wizard boundary (D510 Task 1.1)

This directory is the Desktop host shell for the shared React wizard in
`packages/genie-customization-ui`. Its one runtime-specific read is
`window.nautiloOnboarding` in `index.tsx`, passed explicitly to
`GenieCustomizationApp`. `apps/desktop/electron/preload-onboarding.ts` exposes
that typed port with
`contextBridge`; `apps/desktop/electron/main.ts` owns IPC, bearer-token custody,
the dedicated window, and the Workbench completion notification.

The shared package has no host-global or Electron import. D510 Phase 2 must
provide an explicit Workbench adapter for the same `OnboardingAPI` contract.

## Build and renderer boundary

- The onboarding renderer is bundled by the Desktop Electron build, but it is
  not included in Desktop's TypeScript project. `bun run --cwd apps/desktop
  build:electron` is transpile/bundle coverage; `bun run --cwd
  packages/genie-customization-ui typecheck` now provides the shared renderer
  type proof.
- `apps/desktop/onboarding/index.tsx` mounts `GenieCustomizationApp` in a
  dedicated onboarding `BrowserWindow` and supplies the Desktop port. All
  shared screens receive `api` through `ScreenProps`.
- App concurrently obtains server URL, profile, flags, and `startAt`, then
  dispatches one `HYDRATE`. `null` profile means first run; a snapshot means
  re-trigger and becomes the reducer's material-change baseline.
- Desktop `getStartAt()` comes from main-process window options, not a URL.
  Only `personality` and `avatar` map to screens 5 and 7. The pure
  `screenForOnboardingStartAt()` guard treats malformed input as no target;
  the future Workbench route must validate the same two search values.

## `OnboardingAPI` transport map

| Method | Desktop transport and lifecycle | Browser status / required adapter behavior |
| --- | --- | --- |
| `getServerUrl` | `onboarding:get-server-url` returns the selected main-process origin. | Workbench already has a same-origin location; no fetch equivalent is needed. |
| `complete` | `onboarding:complete` closes the dedicated window, restores/shows Workbench, and emits `onboarding:completed` to the active renderer. | No equivalent port method exists. Phase 2 must complete the route and refresh profile/setup state. |
| `cancel` | `onboarding:cancel` settles the window lifecycle as cancelled and closes it before any uncommitted edit is written. | No existing port method. Phase 2 must use ordinary Back/cancel confirmation without writing. |
| `loadExistingProfile` | `onboarding:load-existing-profile` uses main-held bearer for `GET /api/profile`, maps the agent envelope, and resolves protected photo media. Unauthenticated first run probes `GET /api/profile/status`. | Workbench already has authenticated profile reads. Preserve `null` = first run and snapshot = re-trigger. |
| `getConfigFlags` | `onboarding:get-config-flags` reads `GET /api/config/setup-flags`, falling back to false flags. | Same server route is available to the adapter. |
| `getStartAt` | `onboarding:get-start-at` returns `showOnboardingWizard` options. | Read and validate `startAt=personality|avatar` from the dedicated route search. |
| `getVoices` | `onboarding:get-voices` proxies `GET /api/voices` through main. | Same route exists, but ordinary remote-user authentication/capability behavior needs explicit Phase 2 authorization coverage. Do not assume the Electron proxy's bearer handling proves a browser user is authorized. |
| `listVoiceCatalog` | `onboarding:list-voice-catalog` validates an object query then proxies `GET /api/voices/catalog`. | Same route/query exists. Phase 3 must suppress catalog calls in the no-key branch and avoid exposing raw upstream/provider errors. |
| `previewVoice` | `onboarding:preview-voice` posts `/api/voices/:id/preview`, writes the audio in Electron `userData`, and returns a `file:` URL. | Browser can use the endpoint response without Electron file staging. Phase 3 must sanitize provider failures; current upstream-shaped errors are not safe UX copy. |
| `generateSoul` | Main posts `/api/profile/generate-soul/stream`, parses SSE, relays started/delta/completed/error on `onSoulGenerationEvent`, and returns final `soulFile`. Bearer stays in main. | **Proven transport:** Workbench `profile-section.tsx` posts this authenticated SSE endpoint and `profile-soul-helpers.ts` `consumeSoulStreamChunk` handles decoder carry, deltas, completion, and error. Reuse it; do not invent another stream protocol. Its current parser has no abort wiring and does not surface `soul.started` or fallback-on-error parity, so Phase 2 must either add a bounded adapter or present only truthful supported progress. |
| `onSoulGenerationEvent` | Preload subscribes to `onboarding:soul-generation-event`; unsubscribe removes the IPC listener. | Translate proven parser callbacks to the port. The browser adapter cannot claim Desktop started/fallback event parity until it implements it. |
| `generateAvatar` | Main constructs `NautiloApiClient`, calls `generateAgentPhotoLibraryEntries({ count: 1 })` with idempotency/origin, reads protected media, and returns a data URL. | **Proven canonical path:** Workbench `AgentPhotoLibraryModal` already uses `generateAgentPhotoLibraryEntries` with idempotency and selection-revision fencing. Reuse it rather than a wizard-specific endpoint. |
| `onAvatarGenerationEvent` | Preload can receive partial/completed/error events, but current main produces completed/error only—there is no partial-event producer. | Phase 2 must use truthful indeterminate progress, cancellation, and error handling. It must not promise progressive image previews without a producer. |
| `putProfile` | `onboarding:put-profile` first proxies `PUT /api/profile`; then it may select Agent photo and persist a legacy default voice. | Profile, photo selection, and voice assignment are sequential, not transactional: later photo/voice failure can leave an earlier profile write committed. Phase 2 must characterize/refresh partial outcomes, not claim all-or-nothing save. Profile fields retain same-Human last-write-wins; photo selection keeps its separate revision fence. |
| `upsertVoiceAssignment` | `onboarding:upsert-voice` proxies `PUT /api/profile/voices/:language`. | Existing Settings controls use this canonical write. Voice assignment is a separate sequential mutation from profile write. |

## Current state and persistence contract

- `packages/genie-customization-ui/src/hooks/useWizardState.ts` is the pure
  state-machine boundary. In a re-trigger
  it skips Soul generation until personality, mother answer, privacy, work/life,
  or name differs from the hydrated snapshot. First run always reaches Compile.
- `SKIP_VOICE` clears the reducer's in-memory `voiceSelection` and sets
  `voiceSkipped: true`. It does **not** issue a deletion and current final write
  code has no default-voice-clear operation. Therefore re-triggering an agent
  with an existing default voice, choosing skip, and completing retains the
  existing server assignment while suppressing the Reveal greeting. This is the
  locked current retain-not-clear behavior; Phase 3 must make its UX explicit
  before changing it.
- The ordinary flow writes in `RevealScreen`: profile, optional greeting, then
  `complete`. Targeted personality/avatar flows in `GenieCustomizationApp` write profile,
  optionally upsert voice, then complete. Cancellation before those writes
  preserves the prior profile; once a sequential write begins, later failure
  can require a refresh rather than rollback.
- `ProfileWrite` explicitly carries nullable `voiceName` and `voiceId` through
  the legacy Desktop bridge. Electron main continues to split them into the
  canonical assignment write; the type now covers the actual payload without
  weakening or hiding those fields.

## Regression floor and deliberate limits

Run `bun run --cwd packages/genie-customization-ui typecheck`, `bun test
packages/genie-customization-ui/tests`, and `bun run --cwd apps/desktop
build:electron` before movement. The D510 boundary test covers valid/malformed
start targets, first-run hydration, re-trigger hydration, compile
skip/regeneration, and `SKIP_VOICE` through pure helpers and reducer seams.
It does **not** simulate the Electron window, cancellation handler, final HTTP
write, provider calls, audio, or `onboarding:completed`; those are accurately
mapped above and require later Electron/main-process, web-adapter, and packaged
acceptance rather than a fake unit-test claim.
