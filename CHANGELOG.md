# Changelog

User-visible changes and dated release records for Nautilo. Desktop, server,
CLI, Mobile, and Computer Use Host have independent release identities; there
is no single version number that proves all clients and deployments are current.
See [`RELEASE.md`](RELEASE.md) for publication and verification procedures.

## [Unreleased]

- The sign-in screen offers Join when the server has an active selected public
  invitation and enrollment is open. Join follows the server's existing `/join`
  address; personal invitation links remain available through I have an invite.

- Genies no longer discover or activate the legacy `run_shell` tool, including
  in background Tasks and on older clients. Managed command tools remain
  available where supported; existing command history remains readable.

- Long foreground agent turns refresh their context from Room history at settled
  tool boundaries while keeping the same running job. Oversized turns retain a
  recent excerpt alongside available Journal context; Stop and approvals keep
  their existing lifecycle.

- Immediate and scheduled background Tasks and nested subtasks can retain their initiating Human's
  Basic or Development access to the original paired Mac and project. Each
  command rechecks current Task, chat, account, and Desktop permissions;
  temporary Full Mac access is never inherited. Offline Tasks wait for their
  original Mac and resume the same run when it reconnects. Changing a Task
  definition clears its saved local authority and pauses it for repair.
  Delegated commands stop when their Desktop connection is lost; interrupted
  commands are not automatically replayed.

- Rooms can be marked External to keep public-room behavior while hiding them
  from discovery and automatic onboarding. Existing members and explicit
  invitations continue to work normally.

- Reloaded chat history associates parallel tool results with their exact
  command, including when an approval delays an earlier command. Older results
  without a saved call identity remain visible without guessed command details.

- Developer Workstation PIN activation shows its pending state and prevents
  duplicate submissions while checking and enabling access.

- Compatible Desktop clients support managed local commands through
  `exec_command` and `write_stdin` under existing contained Workstation access.
  Commands keep running after yielding, retain output and actual exit status,
  and provide explicit Stop and local preview actions. Compatible Desktops hide
  the legacy Genie command tools once the replacement capabilities are available;
  older clients retain their existing tools. Human Terminal remains available.
  Command cards update automatically as processes produce output or finish,
  including while collapsed, and preview links work in colored tool output.
  Stopping npm-launched commands confirms process-group cleanup on macOS
  without mistaking an already departed group for a cleanup failure.
  Desktop saves final command receipts and their retained output with OS
  encryption, so authorized chat history can recover them after a restart.
  Recovered records are read-only; uncertain cleanup stays uncertain.
  Shutdown cancels each execution once and preserves a confirmed final result
  when an earlier termination attempt was temporarily uncertain.
  Genies can recover saved final command results after a Desktop or server
  restart through read-only `write_stdin`, when the original result remains in
  the currently authorized conversation history. Recovery checks current
  membership and encryption access and never restores input or replay authority.
  Expired live receipts also recover their authorized saved final output without
  restarting the command.
  Compatible Desktop versions retain supported execution capabilities when
  reconnecting to an older server. Pure output reads retain actor permission
  checks without asking to reactivate Development access.
  Typed local Git operations are available through `local_git`, and retained
  shell output can be paged or searched through `read_shell_output`, without
  launching another shell command.
  Basic commands can use installed utilities inside the selected project without
  activating Development access. They use a private temporary home, isolated
  networking, and the existing chat, encryption, and approval checks. Continuing
  a command keeps its original project even when the selected folder changes.
  Remembered Development access is stored separately for each Human and server.
  Turning it off removes that saved proof; changed legacy state requires fresh
  confirmation, and interrupted saves remain visible as needing attention.
  Human Terminal handoff selects a Genie in the current chat and scopes consent
  to that Human, chat, Desktop, and existing terminal. Taking control revokes
  the handoff without killing the Human's job. Compatible Genies use a separate
  read/run/write tool; queued input cannot migrate to a new handoff, and input
  receipts acknowledge submission without claiming command completion.
  Routine capability refreshes preserve valid handoffs; interrupted handoffs
  return control with a visible explanation.
  Compatible Desktop clients show Basic and Development in one Agent access
  control, with saved choice separate from current readiness. Startup actions
  preserve that choice while managing other components. Temporary Full Mac
  activation remains explicit and is never remembered as a sandboxed choice.
  Eligible foreground Full Mac commands use the same managed pipe lifecycle,
  pinned to the activation selected before command approval. Revocation or
  connection loss stops those commands; later activation cannot resume an old
  approval. Full Mac does not enable agent-created PTYs or interactive input.
  Genies on compatible clients can search retained command output through
  read-only `write_stdin`, including saved results after restart. Search reports
  byte positions, continuation, missing retained output, and whether a quiet
  command may still produce a match. Searching does not consume ordinary output.
  Contained commands and filesystem grants protect the GitHub CLI account
  directory on macOS and Linux.

- Server native image checks recognize the patched Sharp and libvips packages.

- Update the MCP transport and image-processing libraries to their supported
  patched releases, and retire obsolete server security decisions.

- Mobile model search keeps its field and scrollable choices above the keyboard
  on compact screens; selecting a result works on the first tap.

- Mobile personal key and cost settings retain their header and Back action above
  the safe area.

- Reflection allows up to ten minutes per poll, preserves completed batch results
  when repair runs out of time, and gives other eligible records a turn after
  timed-out work yields.
- Reflection automatically reassesses older quarantined work after an upgrade,
  clears obsolete or already-covered work, rebuilds missing search projections,
  and repairs derived records from their surviving current evidence. Retry
  cooldowns survive restarts, older failures retain their place in the queue,
  and durable diagnostics distinguish waiting, failed, repaired, and retired work.
- Members can use personal Surplus keys for supported text chat and native text
  Tasks under the administrator's funding priority and Prefer Surplus setting.
  Personal key setup excludes custom OpenAI-compatible Gateway routes.
  Saving a key checks it without a paid request and reports receipt-read access
  separately. Workbench and Mobile show the selected payer and personal costs,
  including estimates, delayed receipts, and charges that remain unknown.
  Administrator and personal costs share the summary and dashboard layout. Key
  lists render immediately while saved status loads, and personal-key settings
  clearly explain disabled server policy without treating it as a key failure.
  When personal keys are disabled, members see only the warning if no keys are
  saved, or their saved keys with Delete controls. Cleanup remains available
  without permission to spend or access to the credential encryption key.
  Uncertain personal requests stop automatic retries; transient accounting
  writes retry without repeating inference. Repaired personal Surplus keys can
  recover authenticated original receipts while retaining their original payer.
  Server key repair also resumes blocked receipts; interrupted Surplus
  Tasks retain known charges and expose unresolved recovery. Mobile key errors
  offer readable recovery guidance and refresh saved-key status after uncertain
  saves or stale validation. A safe personal Surplus refusal can continue through
  the configured model fallback chain when the same-model direct key is absent;
  exact-model Tasks retain their selected model.
  Mobile cost amounts use the same rounding and tiny-amount display as Workbench.

- Text-only chat models can use an available image-reading model automatically,
  while keeping the selected chat model. Selection uses the current model
  catalog, authorized credentials, privacy requirements and estimated cost.
  Answers identify the image-reading model; completed observations remain
  available for follow-up questions. When no supported image route is available,
  attachments show clear removal/model selection guidance. Queued images remain
  editable after a model switch, and earlier image history stays saved.
  Returning to the app keeps chat visible while access refreshes, and model
  changes avoid repeated full-catalog work and temporary raw provider IDs.
  On Mobile, tapping the image attachment button when no image route is available
  explains the restriction without opening the photo picker.
  Long Mobile drafts and attachment guidance remain scrollable on compact screens,
  with message actions kept above the software keyboard.

- Successful skips end the agent turn without another model call. Silence and
  hand-off control activity stays out of chat while rejected hand-offs remain
  recoverable and already-admitted sibling tools finish normally.

- The text editor serializes first saves of empty documents and preserves edits
  made while a save is in progress. Conflict recovery reports failed latest-version
  reads with a retry action, accepts empty latest content, and saves merged drafts
  against the displayed version.

- Add GPT-6.1 Sol and Claude Sonnet 5.5 across direct, OpenRouter, and Venice
  routes, plus Venice Claude Fable 5.1. Preserve supported reasoning effort,
  full model allowances, and provider-specific pricing through existing adapters.

- Administrators can enable Prefer Surplus for server-funded chat models on
  supported catalogue providers. Nautilo tries Surplus, then the configured
  original provider, then the configured model fallback chain. Costs retains
  each attempt’s actual or pending charge, and uncertain service fails without
  automatic replay. Turning the preference off restores direct routing.
- Personal provider keys can fund native background text Tasks, one-shot
  reminders, and recurring text schedules from your own Genie chat. Task runs
  retain their funding source through retries and Pause/Resume; changed keys
  require a fresh Task. Existing server-funded Tasks retain their behavior,
  and personal workers remain tool-free.
- The server multipart parser uses the patched Busboy 3.2.1 dependency in both
  the contributor lockfile and the shipped Docker runtime projection.

- New ordinary invitation links can be copied again from the server after a
  page reload or device change. Existing links continue to redeem, while older
  hash-only codes that were lost must be replaced. The invite browser cache is
  removed. Server admins can choose or clear the Community `/join` invitation
  in Settings. Existing members who open `/join` go straight into the app;
  visitors need an active selected invite to join.

- Admins can choose server or personal provider keys first for eligible chat.
  Members retain both permitted model catalogues; existing servers keep personal
  keys first unless an admin changes the preference.

- Members can manage personal provider keys in Settings, select a compatible
  chat model, and chat with their own Genie when personal keys are enabled by
  the server. Personal and server key controls share masked previews and
  individual replace, validate, and delete actions. Community is available for
  ordinary invitations; personal-only members can optionally personalize their
  own Genie through the server-funded Soul setup service.

- Approval replies retain the initiating Human and tool context when another
  message arrives during an interrupted turn. Checkpoint cleanup preserves the
  complete resumable snapshot, and approval prompts no longer describe a
  required review as already auto-approved.

- Voice auditions preserve their complete playable slate and sample text in live
  chat and reopened history, including voices with large language/model catalogs.

- Imported full-size Agent photos remain available in the owned photo library.
  An unindexed previous photo no longer blocks browsing or selecting a
  replacement; undo still requires an owned, available previous photo.
  Existing servers must complete the [photo protocol upgrade check](docs/agent-photo-library-upgrade.md)
  before adopting the new creation hash contract; existing media IDs stay unchanged.

- Document reads and authorization checks avoid resolving unrelated model
  metadata when checking decision-tool availability. Model credentials and
  document access are still checked against current state.

- Reopening a mini-app revalidates its runtime and reuses an unchanged response
  instead of downloading the full executable again. Authentication and host
  authority are checked on every request; session changes discard retained runtimes.
  Editors also share their initial document read when attaching to an already
  connected event stream, while actual reconnections still refresh canonical data.

- Mobile now opens notifications for the active server without restarting the
  encryption check. Notifications for another server still check that server
  before opening the conversation.

- Scheduled reminders now tell the background Genie that its final answer
  returns to the original conversation. A redundant request to message the
  requester without waiting for a reply receives corrective feedback before
  peer-message approval, so existing saved reminders can finish through their
  normal Task report-back route. Task dispatch retains the requesting Human
  through Job coalescing, and a Task wake no longer claims its synthetic input
  was a Human-authored turn when saving the reply. The scheduled run's internal
  answer stays out of live Room events and Room history, leaving one visible
  reminder from the normal wake.

- Floating Genie reuses the Room's Stop talking pill above the chat and compact
  prompt inputs. Streaming replies remain stoppable through buffering and
  sentence gaps, independently of Stop action. The floating composer now shows
  separate Mic and Sound toggles, synchronized with Desktop voice. Mic off
  finishes recording into a reviewable draft; the Send arrow stays separate.
  The voice bubble uses tap to record, then tap to send without expanding.
  Transcribing and sending show progress; pending panel drafts and attachments
  remain separate. Full and compact chat share the conversation and draft, with
  a latest-message preview when history is collapsed. The separate waveform
  mode and bubble audio strip are removed. Explicit sound preferences survive
  resizing and reactivation. Stop talking has a waveform-and-square icon distinct from Sound off. A labeled Float Genie button beside the portrait makes
  detaching discoverable and shows Floating while active.
  The floating chat now shares the Room-panel live message reducer: outgoing
  messages appear immediately, replies stream into the transcript, and history
  refreshes preserve live messages instead of replacing them.
- Keep the compact Genie and members rail visible beside document chat in group
  Rooms. Stop remains available while another job in the Room is still active,
  and document previews retain their last readable version during refresh.
- Group conversation rosters show Online, Idle, or Offline beside Humans on
  Workbench/Desktop and Mobile. Status uses authenticated chat connections and
  app activity; failed reads show unavailable. Multiple connected devices are
  combined, and Agent controls retain their existing behavior.
- Preserve complete conversation text instead of cutting message middles or
  dropping old turns at a fixed percentage of model context. Preparation and
  output allocation share the selected model's context budget; oversized input
  reports context exhaustion. Existing Task and research paging remain available.
- Let Deep Research planning, research and final synthesis use the selected
  model's available output allowance unless explicitly capped. Final synthesis
  no longer retries by cutting findings. Cutoff supervisor, compression and final
  report responses fail research instead of becoming accepted findings.

- Preserve reasoning for direct GPT-6 Astra, Sol, and Luna tool calls through
  the existing Responses integration, including research and memory helpers.
  Hidden reasoning output no longer disables effort or changes their transport.

- Add Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna to the model catalog for
  Anthropic/OpenAI, OpenRouter, and Venice, with per-route capabilities,
  context/output limits, selection metadata, and cost estimates.
  Expose supported reasoning levels through the existing model controls, and
  preserve selected effort independently of reasoning visibility.
- Keep Opus 5.5 requests compatible with mandatory thinking and full output
  budgets. Main-chat responses that reach a provider output limit retain the
  partial reply and show an explicit incomplete-task error before tool execution.
- Retire the Fireworks DeepSeek V4 Flash 0731, DeepSeek V4 Pro 0813, and GLM 5.2
  catalog routes; the Fireworks replacements already in the catalog remain
  available. New Deep Research defaults use Fireworks GLM 5.3.

- Add `@everyone` to Room mention pickers and typed mentions on web, Desktop, and
  Mobile for users with the `manage_rooms` permission. It addresses current Human
  members through their existing notification preferences, supports encrypted
  messages, and leaves Genies quiet unless explicitly addressed.

- Desktop now presents the official Nautilo Community as an explicit first-run,
  Add Server, and Switch Server destination while keeping private servers and
  manual connection available. New members use a stable, revocable community
  enrollment entry. Existing Guest capability enforcement lets public members
  chat without gaining Genie invocation.
- Add direct TypeSafe and Venice Jev decision routes, alongside OpenRouter. Genies can discover text classifiers and evaluate named Choice, yes/no probability, and rubric-scoring questions in one request. TypeSafe credentials use the existing Server Controls provider setup; decision models remain separate from chat and speech.

- Server Controls → Models now selects the speech model for all Genies from the model catalog. Conversational is the catalog default; Genie voices remain independent, and changes apply to the next reply. The panel keeps Save changes visible and marks unsaved speech selections separately from the active model.
- Voice replies now stream to native iOS and Android players as audio arrives. Stop, Room changes, reconnection, and backgrounding discard stale playback; Genie voice assignments remain unchanged.

Changes on `main` after the source used for Desktop 0.14.44, plus the maintenance
changes recorded here. Inclusion does not assert a server deployment, Mobile
store update, or Desktop/Host installation.

### Added

- Server Admin → Moderation provides partial name/handle search, persistent
  member selection, and bulk kick/ban with individual results. A searchable,
  bounded joining inbox reviews each account's required joining message;
  reusing an Invite does not bypass approval. Grant-aware chat message menus
  also offer kick/ban. Ban removes the author's existing community/group Room
  messages and thread replies, preserving private conversations and other
  people's replies. Interrupted removal is retryable from the saved action.

- Local internal QA servers can use a separately configured Nautilo Gateway
  credential for signed OpenRouter chat, background, and embedding routes. The
  administrator can save the Gateway API URL beside its masked key in Server
  Admin, existing embedding identity is preserved,
  media routes still require their direct credentials, and failed Gateway
  requests are not replayed through retries or paid fallback chains.

- Desktop Float Genie pins a Genie and Room to a dockable orb, waveform, prompt
  or chat window. It hides while the Workbench is active, appears when working
  elsewhere without taking focus, and sends text through the existing Room.
  Activation starts compact, with a visible expand button and a draggable
  avatar/name header. Chat reuses Room history, transcript rendering and the
  wrapping Lexical composer. A quiet detach icon beside the Genie portrait
  replaces the large composer button. Tap-to-record hosted voice, separate
  Stop talking and Stop task controls, and native-picker attachments reuse
  the existing runtime owners. Capture starts off; automatic listening remains
  separate follow-on work.
  The configured Genie avatar appears in every view; the bubble adds a state
  ring and offers an abstract-orb alternative.
  Returning to the main Workbench hides the floating surface even when macOS
  reports stale visibility during a window or desktop Space transition.
  Native Space-change notifications also reapply visibility on repeated swipes.
  Visibility also checks the exact native main window when the panel
  retains keyboard focus. A visible × attaches Genie again in one click.
  While recording, compact views keep the active microphone visible for
  finish-and-send; Escape and the controls menu discard the recording.
  Stop action stays in a fixed position in every view, enabled throughout
  unfinished work and grayed out when idle. The bubble matches the portrait frame, activity ring,
  and separate corner controls used by its compact design.
  Its corner controls leave transparent space at the window edge so the
  circular borders render completely.
  The expanded header stays draggable without a dotted grip beside the avatar.

- Contributor-only floating Genie shell lab with four compact views, screen-edge
  docking and a Nautilo/Persona visual comparison. Voice states are simulations;
  microphone access and external runtime requests are disabled in this first lab.

- Routine Jev delegation for connected websites already under direct Genie
  control through Browser Use. It reuses the browser decision loop, verifies
  fresh observations against the exact operation and control epoch, and returns
  uncertain effects to the Genie without replay. Hosted and ordinary control
  remain available when no eligible decision model is runnable.

- Automatic Jev browser decisions through OpenRouter. Genies can delegate routine
  clicks, exact text, keyboard input and other existing browser controls using
  fresh observations, with normal permissions and usage accounting. Larger
  candidate sets use parallel screening before the final choice. Uncertainty or
  repeated lack of progress returns control to the Genie, which verifies the
  outcome. Delegation appears when an eligible model and activated credentials are available;
  ordinary browser control remains available without Jev.
- Catalog support for decision workloads and optional visual-grounding metadata,
  keeping decision models separate from chat-model selection.
- Read-only admin model catalog with providers, capabilities, and current server
  availability, including decision models without adding them to chat selectors.

- Quiet Events per Human: snooze for an hour, until tomorrow, until a chosen
  time, or until manually resumed. A crossed-out bell replaces the bell and its numbered
  badge disappears while quiet. Event history and unread state remain available;
  the preference follows your sessions on the same server without changing
  anyone else's settings or chat notifications.

### Fixed

- Screenshot messages now render inline in ordinary Room, thread, and Genie chats as
  they arrive and after reload, with authenticated downloads and full-size
  viewing. Accepted image previews replace temporary upload filename labels.
  Mixed uploads preserve rejection feedback when live delivery arrives first,
  and attachment lookup failures no longer suppress saved peer messages.
- Authenticated Guests can attach files to messages in their selected Room,
  while unresolved and blocked conversations continue to reject uploads.
- Desktop users can open Servers and connect another server even when their
  current server does not allow Genie invocation, including Guest accounts.
- Floating Genie distinguishes Sending from running work, with visible send
  progress. Speaker × stops talking; the separate square Stop action control
  remains available while the Genie speaks and works at the same time.

- Room and floating Genie messages summarize recognized legacy attachment
  envelopes as filenames after history reload. Ambiguous envelopes remain intact.
- Moderation recovery now cancels the excluded person's local queued and active
  work through the existing Job and Task lifecycle, preserving other members'
  work. Execution rechecks current access after persistence and before delayed
  starts; exact Task-run checks protect newer runs. Complete cross-process
  enforcement remains under qualification and is reported as pending.
- Artifact downloads recheck current access before and during streaming; ZIP
  export rechecks before returning the archive. Genie invocation, Task dispatch
  and approval resume now reject withdrawn access even when the Human retains
  an invocation grant.

- Relay registration now rechecks and holds current admission through connection
  publication, preventing a pending reconnect from surviving moderation removal.
  Room resumes, listings and rebuilt Namespace envelopes also reject withdrawn
  access despite retained membership.

- Committed moderation decisions now recover audit delivery on server restart,
  deduplicating the existing security log after a lost checkpoint. Recovery
  reconciles current access without repeating a removal; incomplete enforcement
  remains visibly pending.

- Moderation withdrawal now advances existing Namespace authority and excludes
  removed Humans from encrypted recipient plans while preserving Room history.
  Existing WebSocket admission rechecks also honor Server withdrawal, Relay
  credentials cannot reconnect a withdrawn Human, and live Room removal clears
  stale typing subscriptions.

- Room joins, direct member additions and Invite landing now honor persisted
  moderation bans, including parent and subthread scope. Parent membership
  repair preserves child bans, and simultaneous joins cannot survive a
  committed Room ban.

- Server Admin places the Nautilo Gateway URL and key together at the end of
  API Keys, following the separate OpenAI-compatible gateway.

- OpenRouter-compatible streaming no longer counts a provider usage receipt
  twice when the final choice frame also carries cost or cache-write metadata.

- Browser shared-room history verifies retained Human signer evidence for other
  participants. Cancelled protected turns and graceful shutdown close unpublished
  reservations and prevent late publication. Pending sends show progress, and
  authenticated Guests can reach the workspace with their existing permissions.

- Protected history remains compatible with open Browser tabs across server
  upgrades. Sequential protected tool calls no longer reuse a previously
  published stream reservation. Capabilityless tools retain their explicitly
  required PIN approval instead of falling back to ordinary confirmation.

- Speech uses Jessica when no usable voice is configured, preserving explicitly
  assigned Genie voices.

- Browser decision screening splits text-heavy candidate batches when the provider
  reports context overflow. It preserves all candidates and reports irreducible
  capacity errors without implying that a browser action was executed.

- Routine browser decisions use the owning native dropdown to select observed
  options and preserve completed delegation evidence through later verification.
  Recovery guidance returns remaining routine work to delegation after repair.

- Browser decisions distinguish different supplied text values for the same
  field, allowing repeated-entry tasks to stay in one routine delegation.

- Routine browser delegation now preserves complete goals and exact error evidence,
  distinguishes completion and visual handoffs, and detects repeated action cycles
  without treating different actions on unchanged text as automatic failures.
  The shared behavior applies to embedded and connected direct browser control.

- Desktop shell commands honor replacement folder grants without being blocked by
  superseded revocation history. Narrower restrictions and protected paths remain
  enforced. Folder changes reach outgoing messages immediately, and delayed
  startup reads no longer restore an older folder selection.

- Sol, Terra and Luna cost estimates use current standard API rates and whole-request
  long-context pricing, including cache reads and writes. Non-streaming OpenAI
  Responses preserve provider usage details for cache-write accounting.
- GPT-5.6 conversation caching keeps the stable instruction breakpoint while
  enabling reuse of conversation and tool-result prefixes. Prompt time references
  remain stable within each turn instead of invalidating caching at every step.
  Direct OpenAI preserves later runtime instructions in their conversation position,
  preventing browser handoffs from invalidating earlier cached context; fallback
  providers retain their required system-message format.
- Browser prompts retain current and previous observations while older snapshots
  remain retrievable from retained conversation history. Routine handoffs attach
  their exact reason to provider-only tool evidence where possible, preserving
  the stable prompt prefix and original receipts. Both delegated and ordinary
  browser loops benefit from the smaller history. Uncertain actions return the
  underlying browser error and require fresh observation before recovery.

- Embedded browser key and pointer actions select their guest before forwarding
  CDP input, preventing the Workbench composer from retaining keyboard focus
  during browser automation. Controlled browser surfaces keep rendering in the
  background, and viewport screenshots use Electron's native capture path
  without activating the window. Input and capture errors reach the caller.

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

- Browser navigation returns fresh controls when available; routine delegation
  reuses exact named inputs, reports missing arguments, and can gather element
  text. During an active turn, older full-page reads remain exactly retrievable
  while their contents are omitted from subsequent model prompts.

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
  when the Genie is already busy and the new request runs on a foreground fork.
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

## Component release records verified 2026-09-09

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
- `@nautilo/api-client`: `getPinEnrollment`, `changePin({ newPin, currentPin? })` (omit `currentPin` for first-time PIN enrollment).
- Server: `GET /api/auth/pin-enrollment` — returns `{ enrolled: boolean }` for the authenticated session user.

### Changed

- Workbench Settings → Security: clearer sub-sections (**Runtime security**, **Account & password**, **Approval PIN**), **Server posture** instead of ambiguous “Details”, inline network summary, collapsible Logto password change.
- Workbench Settings → About: shows **Nautilo product version** (not Electron’s `app.getVersion`), platform, and Electron runtime on desktop; browser build shows `(web)`.
- Desktop `app:getVersion` IPC returns product semver; `electron/preload` exposes `electronVersion` for About.
- `apps/desktop/package.json` `version` set to **0.3.7** to match product semver.

### Fixed

- Logto **account recovery codes**: “Copy all” shows success feedback, uses a clipboard fallback when `navigator.clipboard` fails, and clearer button press affordance on settings buttons.
