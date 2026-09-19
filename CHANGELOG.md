# Changelog

User-visible changes and dated release records for Nautilo. Desktop, server,
CLI, Mobile, and Computer Use Host have independent release identities; there
is no single version number that proves all clients and deployments are current.
See [`RELEASE.md`](RELEASE.md) for publication and verification procedures.

## [Unreleased]

Changes on `main` after the source used for Desktop 0.14.44, plus the maintenance
changes recorded here. Inclusion does not assert a server deployment, Mobile
store update, or Desktop/Host installation.

### Added

- Quiet Events per Human: snooze for an hour, until tomorrow, until a chosen
  time, or until manually resumed. A crossed-out bell replaces the bell and its numbered
  badge disappears while quiet. Event history and unread state remain available;
  the preference follows your sessions on the same server without changing
  anyone else's settings or chat notifications.

### Fixed

- Browser shared-room history verifies retained Human signer evidence for other
  participants. Cancelled protected turns and graceful shutdown close unpublished
  reservations and prevent late publication. Pending sends show progress, and
  authenticated Guests can reach the workspace with their existing permissions.

- Desktop shell commands honor replacement folder grants without being blocked by
  superseded revocation history. Narrower restrictions and protected paths remain
  enforced. Folder changes reach outgoing messages immediately, and delayed
  startup reads no longer restore an older folder selection.

- Fresh database installations permit legitimate content-access receipt cleanup
  when associated users or content are deleted, while retaining protection
  against direct receipt mutation.

- Video references use one optional **Extra instructions** field; existing role
  guidance remains visible and editable alongside saved instructions.

- Video generation references can apply to all scenes or selected scenes, with
  previews and scope controls beside the scene list. Scene assignments and prompt
  mentions persist across saves and scene reordering; review uses each scene's
  own image, video, and audio references.

- Video generation accepts MP3/WAV audio references from Artifacts, the Media Bin,
  and computer uploads. Audio references retain waveform/playback previews and
  prompt mentions, appear in paid review, and reach Seedance with validated
  source bytes and duration. Audio donors require an image or video reference.

- Routine workspace checks and same-account credential renewal preserve valid
  in-flight saves and editor access. Expiry, revocation and actual access
  changes still invalidate protected requests.

- Human-only chats correctly report no pending Agent approvals. Background
  approval recovery no longer interrupts conversations with a retry banner;
  actual approval requests remain available through their existing prompts.

- Mini-app editors release their live sessions across reloads and recover failed
  cleanup before subsequent agent edits. Read-only previews now tell Genie to
  use saved-document tools, and write guards no longer misidentify every editor
  as Writer. Context updates preserve editor close guards and ongoing media
  operations. Cleanup recovery also covers ordinary navigation without
  cancelling editors in other live tabs. Native Video edits can rename the
  project title durably.

- Desktop content follows window resizing after server switching or changed-identity recovery.

- Desktop can accept a changed server identity from a fresh development profile,
  and recovery-screen actions remain available when its URL includes recovery state.

- Video generation can use references from all currently readable Workspace
  contexts, rechecks access before submission, and shows specific preparation errors.

- Video generation status follows the saved project’s authorized room instead
  of an unrelated open chat. Saved takes remain usable when status is unavailable.

- Audio-only MP4 artifacts show audio waveforms and import as audio even when
  their stored MIME label says video. Stream inspection determines media kind.

- Confirmed Video generations open a dedicated progress pane with animation,
  timing, scene status, recovery, and the saved result. Returning to scene design
  keeps a progress shortcut and does not cancel or resubmit the generation.

- Video uses one searchable media browser for Artifacts, the Media Bin, and
  computer uploads, including batch selection and generation references.
  Cancel closes quietly; actionable media messages can be dismissed. Image
  assets show thumbnails in the editor’s Media Bin as well as the picker.
  Audio cards show their actual waveform with playback and seeking controls,
  including waveform thumbnails and audio previews in the Add media picker.

- Browser Use can carry out requested website work, including creating and
  editing content, on public or connected sites. A task does not require a
  second approval or per-click confirmations. Genies pause for dangerous,
  irreversible, ambiguous or out-of-scope actions and retain Watch live/Stop.

- Open Boards recheck the saved document after a successful Genie edit, so a
  missed document notification no longer requires closing and reopening the
  canvas. Unsaved human edits retain their existing conflict protection.
- Protected website sign-in buttons use the theme's contrasting foreground,
  keeping Done and the related controls readable in light and dark mode.

- CLI release-metadata requests allow up to 60 seconds each, preventing slow
  but valid signed stable releases from failing after ten seconds.

- New Railway template deployments automatically select the latest signed
  stable Nautilo runtime during CLI adoption. Interrupted deployments retain
  their verified release so they can resume after the stable channel advances.

- Enabled Workstation access survives Relay Host replacement without resetting
  its capability revision. Readiness checks validate the live relay binding,
  and shell failures identify revision rollback instead of asking repeatedly
  for approval of the same command.

### Changed

- Provider model choices refresh after credentials are saved without discarding
  unsaved settings. Deep Research now honors configured role output budgets,
  propagates cancellation to model calls, and reports exhausted supervisor
  retries as failures rather than producing an unsourced success report.

- Automatic model selection on Venice and OpenRouter now prefers MiniMax M3 for
  chat, image reading, web summaries, and background roles, and Kimi K3 for Deep
  Research. Explicit model selections retain precedence.
- Automatic embeddings on Venice and OpenRouter now use Qwen3 Embedding 8B at
  1,536 dimensions. OpenAI text-embedding-3-small remains an explicit choice
  through both providers and the automatic choice with only an OpenAI key.
  Existing explicit embedding settings are preserved; existing vectors are not
  migrated or relabelled when the selected model changes.

### Added

- Server release consumers admit the fresh `nautilo-runtime-v2` and `nautilo-bootstrap-runtime-v2` public image namespaces while preserving immutable legacy release and recovery records during the transition.

- Durable named local instances now retain deletion protection across root
  recreation through local deployment-profile authority. Existing local
  Compose profiles fail safe as durable, while disposable fixtures stay
  explicit.

- Administrator CLI artifact relocation can repair restored file and document-history
  references against a verified original backup, with an exact atomic plan and
  byte-verified rollback. Source CLI version 0.1.30 requires separate publication.

- Active video, image, and music generation share flowing ribbon animation with distinct media shapes, saturated light/dark palettes, and a static reduced-motion presentation. Animation pauses offscreen or in hidden windows and leaves real job status, timing, and paid-generation controls unchanged.

- Video now shows the chat generation animation with elapsed and typical timing in both generation modes. Completed HEVC videos pass native inspection and can enter the Media Bin automatically. Import media offers existing Workspace files alongside computer uploads in a bounded, scrollable picker with image thumbnails, video stills, recognizable project names and a visible close button. Picker previews load as their rows become visible and release when closed or scrolled away. Verified identical media copies share one readable picker entry with expandable originals; every Workspace file is preserved. Preview connections are ready before the embedded editor opens and support video seeking without stalling at time zero. Timeline clips have a Delete clip context action that preserves their Media Bin source and supports Undo; generation approval and busy buttons retain readable theme colors.

- Simple generation displays and edits the actual first-scene duration so an old scene override cannot silently replace the entered seconds in paid review. Video has matching spacious Simple and Advanced writing panes, reference thumbnails and multiple-image selection. Native previews use the active server session, and saving while the image picker is open preserves the import. Generate scene acts on the selected scene; Generate sequence appears beside the scene list when there are multiple scenes. Exact-cost approval accepts reference fingerprints correctly, and feedback distinguishes preparation failures from uncertain submissions.

- The compact Apps panel now has search at the top, including matches inside
  collapsed groups. Removed the unavailable install button from both Apps views.

- Protected Reflection can combine supported Records and authored Memories from
  different Rooms using one complete device grant per question. The result is
  restricted to the audience shared by all model inputs, including uncited inputs.
  Independent questions retain shared model batching.

- Browser Use can research public interactive websites without a website login or saved connection. Ask for Browser Use directly, or let your Genie select it when navigation, filters, or dynamic content require it. Ordinary research continues to prefer Tavily. Public jobs include progress, Watch, Stop, and source results. Browser cards distinguish unavailable status and pending settlement from active work, and support status retry.
- Board brings notes, text formatting, shapes, attached connectors, images and
  undo to an infinite canvas under Nautilo Office. Humans and Genies can create,
  edit and reopen canonical Boards in Workspace and granted Current Folder, with
  strict save conflicts and draft recovery. Server images include Board enabled
  by default while preserving explicit disable preferences; the Apps listing has
  a distinct Office icon and an actual editor screenshot.

- Same-Room Reflection can organize protected Records with device-authorized
  inputs and outputs. Questions obtain authority independently while preserving
  shared model batching; plaintext processing remains grant-free. Journal context
  can read Records after their encrypted access binding is reconciled.

### Fixed

- Video timeline snapping preserves exact neighboring clip edges, including media durations between frame boundaries, so adjoining clips meet without a gap or a rejected overlap. The snapped position survives saving and reopening.

- Artifact relocation's backup reader now supports the Node CLI entrypoint as
  well as the signed executable. This is an unreleased source portability fix;
  the published signed CLI 0.1.30 already supports artifact repair.

- Upgrade and full-bundle restore reconcile restricted Memory coordinator grants
  against the installed database schema, so older schemas can be repaired before
  migrations without granting access to immutable or unrelated columns.

- Remote CLI deploy and restore synchronization preserves the target SSH
  operator's ownership instead of copying a workstation user's numeric owner
  and group into the deployment root.

- Sheets documents now include a safe static Reader preview, and Sheets can
  import `.xlsx` workbooks into editable native copies and export saved native
  spreadsheets back to `.xlsx` with explicit fidelity warnings.
- New server images include the native Slides app and its owned Core, Docs and
  Slides engine by default. Fresh installs enable Slides; upgrades and restarts
  preserve a Human's explicit disabled preference.
- Slides creates the saved document before enabling editing on a generic Launch.
  Protected Desktop drafts can reopen through the original editor when a local
  file is moved or deleted, with Save Copy and fresh-version checks preventing
  accidental recreation or overwrite of the original.
- Genies can create native Writer documents, populate them with Writer tools,
  and return the saved document path for opening. Tool discovery includes
  creation and closed-document tools alongside the live review tools.

- Persistent personal Events feed in the web and Desktop Workbench, with live
  unread counts, explicit read controls, Room membership events, and Artifact
  added/shared events. Artifact links check current access when opened; read
  state remains an explicit choice.
- API key coverage summaries in Admin and the server setup guide, showing which
  configured providers support each functionality and linking to key setup.
- Server defaults for image, music, and video generation, with catalogue-backed
  choices. Automatic image selection prefers Venice, OpenRouter, OpenAI, then
  Google; explicit requests and approved media jobs retain their chosen model.
- Broader native Computer Use: existing editable controls, observed accessibility
  roles, pointer buttons and modifiers, flexible drags, foreground input, typing
  pacing, and real pointer movement through the independently updated Host.

- Public rooms now support protected messages and automatic history repair through
  the existing device-assisted workflow. Membership changes resume key catch-up;
  Strict mode waits for authorized key access without falling back to plaintext.

- Venice embeddings and server model selection.
- Live audit review percentages in tool cards.

### Changed

- Move official Railway template source preparation and Marketplace publication instructions to private release custody; customer Railway deployment and adoption remain available.

- Shared Slides/Board selection repaint preserves the focused text input, so
  typing continues at the caret instead of restarting at the beginning.

- Writer builds from Nautilo-owned Docs source, replacing the stale published
  package, generated-path imports, and compatibility shim. Existing documents
  retain the Nautilo save and review lifecycle.
- Desktop source packaging defaults to ad-hoc builds without release credentials.
  Official signing and publication are maintained outside this source tree;
  contributor builds retain native helper identity and artifact checks.

- Mac Desktop replaces the old FFmpeg binaries with prebuilt LGPL FFmpeg 9.0.1,
  uses VideoToolbox for video proxies/exports, and includes complete source and
  license records in every download. Export quality presets now use target
  bitrates; saved settings and H.264/AAC MP4 output remain supported.

- New chat defaults prefer GPT 5.6 Terra; auxiliary model roles prefer GPT 5.6
  Luna when a configured provider offers them. Existing explicit choices remain.

- Provider key fields follow onboarding order, with custom gateways last;
  provider descriptions and key-creation links are clearer and up to date.
- Compose owner setup defaults to manual browser claim; protected-file owner
  creation must be selected explicitly. First-owner configuration now uses a
  permanent password and no longer accepts the unsupported
  `forcePasswordChangeOnFirstSignIn` option.
- Mobile Files now opens directly to its normal list without the All files / Shared with me tabs.
- Clearer Admin encryption-mode controls and diagnostics.
- Desktop and Server now pin OfficeCLI 1.0.148 together. Shared artifact hashes,
  version stamps, and upstream checksum records are checked for parity. The
  third-party inventory includes Cua Driver and separately downloaded security
  scanners.
- Reconciled release, architecture, contributor/agent, Mobile, and changelog
  documentation with source-owned workflows and current product boundaries.

### Removed

- Spreadsheet Lite and its FortuneSheet dependency have been retired. Default
  new server images and fresh app roots include the Wafflebase-based Sheets app
  as Nautilo's native spreadsheet editor; existing Lite documents and
  persisted app copies are not migrated or removed automatically.

### Fixed

- Server upgrades can apply the content-access receipt trigger migration through
  the restricted application database role while preserving the final trigger
  privilege revocation and immutable receipt guard.

- Server restore and automatic rollback pass database credential reconciliation
  SQL through private process input and keep it out of command logs, process
  arguments and operator error diagnostics.

- Failed Board image imports leave saved bytes and revisions untouched; pending
  images remain protected by save/close guards and crash-recovery checkpoints.
- First-party app tool retries keep a stable invocation identity, preventing
  changed arguments from being treated as a new mutation during replay.
- Board keeps note text and range-selection highlights visible while editing
  anywhere on the infinite canvas, including negative coordinates. Text undo
  and redo preserve the note instead of changing the outer board history.
- Stenographer continues processing other rooms when one room’s operation throws,
  so unavailable historical data does not block fresh journal and Reflection work.
- Writer background Tasks retain the requesting Human's live document session
  when Moxie is already busy and the new request runs on a foreground fork.
- Writer documents remain readable in Reader after an accepted review saves
  canonical data without a static HTML preview.

- Markdown editing no longer adds a gap above the workspace, checklist boxes
  align with their text, and completed checklist items are struck through in
  preview without marking unchecked nested items as complete.
- First-run setup invites Genie personalization, preserves explicit completion,
  and exposes Desktop connection details to every signed-in user. Desktop
  downloads open separately from setup.
- Venice chat and Soul generation handle provider-compatible tool schemas and
  response modes. Search no longer requires a Fireworks chat model; Deep Research
  runs in the background with configured chat providers and requires Tavily.
  Failed report synthesis is reported as a failed task.
- Music and video tools refresh after credential changes and distinguish normal
  paid generation from reference preparation while retaining exact-price approval.
- Writer includes its standalone parsing dependency, source startup reports
  missing Sheets preparation, and document creation cards open their results.
- Video projects renew saved-project access and use canonical filenames; browser
  users see Desktop requirements before unsupported editor generation.
- Claimed local Compose instances use container-loopback operator access for
  upgrades instead of retired bootstrap credentials.

- Background processor claims and execution timers honor the recipient’s
  remaining validity, including time spent loading accepted grant material.

- Background Stenographer authorization preserves another server's active
  recipient until expiry, resumes when missing Domain keys arrive, and includes
  current V2 processor work in protection health counts.

- A rejected local patch destination is reported as a path error, with guidance
  for saving Workspace reports, instead of a misleading runtime-unavailable error.
- Security audits finish their documented review plan without turning every
  unassigned inventory file into another review task. Report corrections stay
  focused, sealed reports can be delivered with disclosed sampling, and cards
  distinguish review-plan progress from report review and export.

- Desktop security Tasks retain verified authorization when a Human sends a
  message while the Genie is busy, instead of incorrectly asking for a fresh
  authorized message. Automatic wakes still cannot create local scan Tasks.
- Security audit finalization now returns the exact unfinished file request and
  continuation cursor, preventing repeated searches to guess which page remains.

- Desktop's macOS “Restart & Update” now closes the window after saving open
  work, instead of hiding it and leaving installation waiting for a manual quit.

- Native file content and filename searches now receive the shared sandbox
  configuration required by release Desktop. Missing-configuration errors explain
  recovery without internal planning references.

- Admitted Computer Use no longer inherits Relay's generic 60-second execution
  cutoff. Turn cancellation and explicit deadlines remain effective, and the
  bundled Relay Host preserves the executor's final receipt after cancellation
  instead of replacing it with a generic callback error.

- Computer Use pixel and desktop typing now return Cua's actual zero-delivery
  chunk-size guidance instead of an internal Host error when paced synthesis
  exceeds the driver's per-call budget. No product-wide text limit is added.

- Native Computer Use retains exact-window observation after settled actions and
  offers visual recovery when an inline editor cannot establish window ownership.
  Catalogue guidance distinguishes an edited filename draft from a committed rename.

- Mobile file viewer Save and Edit actions now share consistent button styling and height.
- Conversation history reconciliation from admitted Browser/Desktop devices and
  a stuck **Return to latest** after reopening a chat.
- Mobile streaming, Markdown rendering, message editing, and keyboard-open
  editing behavior. The September 9 Mobile 0.2.0 tester refresh includes
  these fixes.
- Hue bridge rediscovery and pairing recovery.

## Component release records — verified 2026-09-09

These are dated publication/ledger records, not claims about every user's
installed version or the present public CDN pointers.

| Component | Recorded release | Evidence and scope |
| --- | --- | --- |
| Desktop | 0.14.44, published 2026-09-08 | [GitHub Release](https://github.com/agentsea/nautilo/releases/tag/desktop-v0.14.44); source `76b274c79`. Later main changes are listed above. |
| Administrator CLI | 0.1.24, published 2026-09-08 | [GitHub Release](https://github.com/agentsea/nautilo/releases/tag/cli-v0.1.24); independent of the Desktop version. |
| Server | `server-image-34280039643-1`, published 2026-09-08 | [Signed internal handoff](https://github.com/agentsea/nautilo/releases/tag/server-image-34280039643-1) for source `233d391d4`; public stable promotion and target deployment are separate. |
| Mobile | 0.2.0 tester refresh, recorded 2026-09-09 | [Release note](apps/mobile/releases/0.2.0.md) and [ledger](apps/mobile/releases/ledger.json): iOS build 34 / Android code 39 from `a56fc1fbe`, available to TestFlight/Play internal testers; not public store rollout. |
| Computer Use Host | 0.1.19, published 2026-09-09 | [GitHub Release](https://github.com/agentsea/nautilo/releases/tag/computer-use-host-v0.1.19); managed Host publication is separate from the Desktop-bundled seed and client adoption. |

## Source history catch-up — May through September 2026

The previous changelog stopped at May 2. This is a curated reconstruction of
major merged changes since then.
It is not an invented sequence of product releases or an exhaustive commit log.
Individual component releases may contain different subsets.

### September: connected work, Office, recovery, and Mobile

- Added protected Connected Websites with supervised hosted runs, direct browser
  control, steering, reuse, recovery, and voice completion.
- Added complete connected-app packs and Canva results, followed by Airtable and
  Dropbox workflows.
- Moved Desktop Relay transport into a private Host; improved signed Computer
  Use contracts, native controls, coordinated reads, and browser recovery.
- Added Nautilo Office Sheets using owned Wafflebase-derived Core/Sheets source,
  with save/reopen and recovery behavior. Completed Design editing and artwork
  delivery and updated Video editing/generation workflows and reference-path
  recovery.
- Added Workspace file sharing and message timestamps, followed by Mobile
  document/media viewing and save-original actions. Recorded 0.1.2 and 0.2.0
  tester builds in the Mobile ledger.
- Made security research evidence completion, scanner failure recovery, full
  reports, and long-running audit recovery explicit and observable.
- Expanded protected conversation/Memory workflows, device admission, encryption
  coverage diagnostics, and convergence repair. These are scoped implementation
  changes, not a claim that every client supports every encryption mode.
- Improved Reflection, Memory review, Stenographer convergence, and live Writer
  background delegation. Added provider/tool cost tracking and reorganized
  Settings/Admin.
- Defaulted local deployment to the signed stable server channel, repaired
  Railway release selection, and aligned runtime build prerequisites.

### August: Mobile, hosted deployment, native automation, and data protection

- Added the Mobile Web client, paired-phone workstation access, native document
  editing/viewing, push notifications, delegated Task surfaces, and store/tester
  release records.
- Added Railway BYOC deployment, resumable owner setup/day-two operations, and
  signed standalone administrator CLI distribution with authenticated
  administration.
- Added the vendored Cua baseline and independently releasable Computer Use
  contracts/Host, plus protected signed Desktop branch qualification.
- Added authenticated Hermes/OpenCode task harnesses, improved Codex onboarding
  and recovery, and added structured SSH delegation.
- Added Silurus document previews, Design editing, durable media generation,
  and semantic Genie UI guidance.
- Introduced staged protected data/device workflows, later device-wrapped
  Namespace authority and Browser message protection; added explicit blocking,
  content reporting, and account deletion recovery.
- Retired the TUI product surface. The administrator CLI remains.

### May–July: multi-user collaboration and application foundations

- Expanded multi-user Room UX, presence, addressing, floor control, and natural
  routing; added durable asynchronous Tasks and transcript-driven context.
- Replaced bootstrap/default identity fallbacks with request identity, expanded
  capability-driven administration, and added standing approvals.
- Added Memory Library and sharing controls, mini-app runtime, and Writer-first
  Nautilo Office with inline document review.
- Added voice discovery/audition, per-Genie voices, Mobile voice, usage/cost
  dashboards, and scheduled Task management.
- Added signed macOS distribution, signed runtime model catalogues, progressive
  tool activation, and server release/remote deployment recovery.
- Consolidated Workbench into the server's single-origin build-and-serve path;
  the separate Vite dev-server path was retired.

## Historical entries

The original entries below are preserved as records of their time. Their
old unified-version and Desktop version-file instructions are superseded by
[`RELEASE.md`](RELEASE.md).

## [0.3.8] - 2026-05-02

### Added

- Workbench Rooms: room tab strip, searchable Rooms popdown, renameable Rooms, new-chat creation, pinned/restored tab state, drag-and-drop tab ordering, and per-Room composer draft isolation.
- Room history scrollback: room-scoped cursor API and Workbench scroll-up hydration so older persisted messages can be loaded beyond the initial history tail.
- Workbench **Settings → Model**: searchable default-model browser (provider groups, priority / cost / enabled badges, server-default row) replacing the native `<select>`.

### Changed

- Desktop and UI product version bumped to **0.3.8**.
- Legacy sessions are promoted into Room-backed history so historical chats appear as distinct Rooms with title, participant context, message count, and latest activity.

### Fixed

- Room isolation hardening: missing/stale Room routes no longer leave a live composer that can silently fall back into the default Room.
- Tool activity routing now carries lane provenance on `tool.start` / `tool.end` events, preventing tool cards from appearing in the wrong Room.
- Identity-verification resume now rehydrates room-scoped history instead of global latest history.
- Server session route tests now exercise actual route/query behavior instead of source-string checks.

## [0.3.7] - 2026-04-30

### Added

- `CHANGELOG.md` (this file).
- Canonical app semver `NAUTILO_APP_VERSION` (`packages/config/src/app-version.ts`, export `@nautilo/config/app-version`).
- Workbench Settings → Security: **Set / change approval PIN** (enroll vs change via `GET /api/auth/pin-enrollment` + `POST /api/auth/pin` through `apiClient`).
- `@nautilo/api-client`: `getPinEnrollment()`, `changePin({ newPin, currentPin? })` (omit `currentPin` for first-time PIN enrollment).
- Server: `GET /api/auth/pin-enrollment` — returns `{ enrolled: boolean }` for the authenticated session user.

### Changed

- Workbench Settings → Security: clearer sub-sections (**Runtime security**, **Account & password**, **Approval PIN**), **Server posture** instead of ambiguous “Details”, inline network summary, collapsible Logto password change.
- Workbench Settings → About: shows **Nautilo product version** (not Electron’s `app.getVersion()`), platform, and Electron runtime on desktop; browser build shows `(web)`.
- Desktop `app:getVersion` IPC returns product semver; `electron/preload` exposes `electronVersion` for About.
- `apps/desktop/package.json` `version` set to **0.3.7** to match product semver.

### Fixed

- Logto **account recovery codes**: “Copy all” shows success feedback, uses a clipboard fallback when `navigator.clipboard` fails, and clearer button press affordance on settings buttons.
