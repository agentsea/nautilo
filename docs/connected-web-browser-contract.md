# Connected Website browser contract

This document describes public Browser Use research and protected connected websites. It
is intentionally a contract between Nautilo's server runtime and Browser Use,
not a promise that every browser control works on every site.

Browser Use V4 hosted Agent runs remain the default delegated driver. Direct
CDP control for connected-account operations is a secondary mode Moxie may choose or enter by
takeover. Both live behind one supervised operation and one Human-facing card;
neither exposes provider topology or an unrestricted browser surface.

## User-authorized website tasks

`run_website_task` performs multi-step website work, not just research. Supply
one existing connected `account` or one public `url`, plus the user's requested
outcome. The Genie briefly explains what it will do, then acts within that
request. No separate connection-upgrade, task-approval or per-click confirmation
is required. Pause for genuinely dangerous, irreversible, ambiguous or
out-of-scope actions. Signing in makes the account available; it does not
authorize unrelated work. Website content never supplies authorization.

The tool requires `use_connections`, has high impact, and requires an `allow`
policy. A `read_only` envelope cannot execute it. Public tasks additionally
require current Human/Genie Room membership; connected tasks retain the exact
owned-Genie/private-Room/profile checks. No stored connection grants are changed.

The existing durable operation owns delivery identity, sealed request, cost,
events, cancellation, supervision, and provider cleanup. Its sealed intent kind
is `run_website_task`; old `browse_web` and `read_connected_web_account` intents
remain reads. General tasks are not encoded as `save_item`. The old saved-item
ledger retains its independent postcondition verifier and compatible rows,
without a redundant confirmation for a requested save. No database migration
is needed: the operation already stores a versioned sealed intent and generic
lifecycle. Public tasks have no account/profile or legacy saved-item effect ID.

Steering rebuilds the original task constraints. Connected direct takeover
rechecks current task authority and opens the same account's saved profile;
inspect current saved state before continuing because prior steps may already
have changed the site. Public direct takeover remains unavailable. A lost
creation response retains the reservation; duplicate delivery does not launch
another worker. Never blindly replay an uncertain or partially completed write.

The existing result envelope carries the task's answer, observed facts and
completeness. A completed provider run is not proof the requested changes
succeeded: the Genie must inspect evidence and disclose partial or uncertain
outcomes. A dangerous or ambiguous step stops work and returns the concern
with partial/unknown completeness, rather than fabricating success. Login,
MFA and CAPTCHA still use the protected Human intervention flow. Provider
instructions are not a deterministic semantic firewall for every website action.

## Public research and website authentication

`browse_web` is a core research tool when the hosted provider and durable runtime are ready. It accepts a public HTTP(S) URL and a research goal. A Human can request Browser Use directly; a Genie may select it for interactive search, filters, pagination, expandable content, or rendering gaps. Tavily search/extraction remains the ordinary research path. A failed extraction is not a prerequisite when the need for interaction is already clear.

Public browsing requires Nautilo invocation authority and current Human/Genie membership in the initiating room. It does not require an owned Genie, a personal two-member room, a saved website account, or a website login. Room-anchored tasks use the same authority; orphan/no-room tasks are unavailable. All clients invoke the server runtime. Workbench and Desktop share the operation card; native Mobile retains its generic tool transcript rather than claiming an embedded live-view card.

Public operations use `account_id = NULL`, a sealed `browse_web` intent with the validated target URL, and no `browserSettings.profileId`. SQL and runtime checks prohibit public profile effects and direct drivers. Existing non-null account operations retain their account authorization and encryption context. `manage_connected_web_operation` supervises both modes, with fresh private-account policy checks for account operations. Public direct takeover returns `unavailable` before cancelling or opening anything.

The shared supervisor owns events, costs, completion, wakes, and cleanup. Duplicate delivery returns the existing result/state without creating another provider run. If a create response is lost, the retained admission prevents automatic retry; its uncertainty is reported as provider unavailable, never as confirmed active work. Terminal public browsers become eligible for immediate explicit cleanup and are never reused as saved or warm account sessions. This does not claim that a completed agent run alone proves browser billing stopped.

Initial URL validation rejects embedded credentials and non-public addresses. Hosted navigation is constrained in the task instructions; Nautilo does not control the provider's browser network layer and does not claim redirect/DNS-rebinding firewall enforcement. No server fetch is added. Page content remains untrusted, and the provider receives a read-only goal allowing public search/filter forms but excluding messages, purchases, and account changes.

The operation card observes current owner-authorized state independently of its original tool receipt. Failed status retrieval displays unknown status with retry; it never reuses an old running claim. A provider run that has ended while durable settlement is pending displays that distinction and omits inapplicable live controls.

Only a validated provider `authentication_required` outcome presents a sign-in checkpoint. The protected Connected Websites flow owns login; the original request is preserved for resumption. Private account reading remains restricted to the owning Human's private room and is never silently borrowed by an anonymous run.

## Provider lanes

Browser Use Cloud has two different V4 products on the same infrastructure:
[Agent](https://docs.browser-use.com/cloud/agent/quickstart) accepts a natural
language task, while
[Browser](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium)
gives a client direct CDP control. The lanes have different ownership and
lifecycle rules.

| Lane | Use | Nautilo authority | Genie contract |
| --- | --- | --- | --- |
| Hosted V4 Agent | Public or protected research and user-authorized website tasks | Creates, cursor-observes, steers, and cancels a run; public mode omits the profile, account mode uses the owned saved profile | `browse_web`, `read_connected_web_account` or `run_website_task`, plus `manage_connected_web_operation`; never provider coordinates |
| Standalone V4 Browser | Human sign-in/takeover and Moxie direct control | Creates, watches, and explicitly stops the browser session | No model access to CDP or live-view capabilities |
| `agent-browser` attached to the managed browser | Deterministic Moxie-selected interaction | Starts one dedicated server-side process with an ephemeral validated CDP WSS capability | Familiar semantic browser operations routed through a sealed Connected Website binding, not a raw MCP profile |

No lane grants a Genie credentials, MFA codes, cookies, profile data, a
live-view URL, a CDP URL, or a provider API key.

## Resource ownership and lifecycle

All provider locators are server-side checkpoints. They are not browser/UI
state, model context, durable client projections, or exception text. Raw event
payloads, page contents, model reasoning, `liveUrl`, `live_view_url`, `cdpUrl`,
and resolved CDP WebSocket URLs are bearer capabilities and are redacted from
ordinary telemetry and user-visible errors.

| Resource | Creator and owner | Persistence and permitted use |
| --- | --- | --- |
| `profileId` | Nautilo server creates one Browser Use profile for the connected account owner | Browser Use persists cookies and browser state. Supply it as `browserSettings.profileId` for a hosted run or top-level `profileId` for a standalone browser. It never leaves server custody. |
| `runId` | Browser Use returns it from `POST /runs` | Nautilo polls `GET /runs/{id}/status`, reads `GET /runs/{id}` only when terminal, reads ordered events, and cancels with `POST /runs/{id}/cancel`. A cancelled run is terminal; it is not a retry instruction. |
| `sessionId` | Browser Use returns it with a hosted run | It joins sequential hosted runs. A continuation after a Human checkpoint creates a **new** run with this ID; it does not resume the old run or reuse element references. |
| `workspaceId` | Browser Use returns it with a hosted run or Nautilo creates one for a file workflow | It is the provider-side filesystem. It is not a Nautilo local path or a browser profile. |
| `browserId` | Browser Use returns it from `POST /browsers` | It identifies an ephemeral standalone browser session. Nautilo alone calls `PATCH /browsers/{id}` with `{"action":"stop"}`. Closing CDP or an automation client is not a stop operation. |
| `liveUrl` / `live_view_url` | Browser Use returns it for a standalone browser or in a hosted `browser.ready` event | Owner-gated, short-lived browser-view capability only. Never send it to a Genie or persist it as a connection credential. |
| `cdpUrl` and resolved WSS URL | Browser Use returns the HTTPS discovery capability; Nautilo resolves its WSS endpoint | Ephemeral server-only control capability. It is discarded when the dedicated direct-control process exits or control returns to the Human. |

The provider's `timeoutAt` is an observation, not a Nautilo-created deadline.
Nautilo's explicit browser timeout policy is passed at creation and the server
must record the resulting `timeoutAt`; neither a dropped connection nor a UI
closure releases the browser. Browser Use documents the required explicit
stop, including its billing/refund effect, in its
[V4 overview](https://docs.browser-use.com/cloud/llms.txt).

### Hosted V4 Agent run

1. Nautilo authorizes a single connected account and creates `POST /runs` with
   a bounded task, explicit model/cost policy, and
   `browserSettings.profileId`. Recording is off unless a separately approved
   product policy says otherwise.
2. The server stores the returned `runId`, `sessionId`, and `workspaceId`
   only in its private operation checkpoint. It reads events with the last
   accepted `after` cursor, drains `hasMore`, and atomically commits
   `nextAfter` with the corresponding normalized semantic checkpoint and
   sanitized activity-ledger entries.
3. A durable supervisor—not the initiating model tool call—polls status and
   events. It wakes the exact initiating Genie for meaningful progress,
   authentication/Human attention, suspected loop/no progress, requested
   check, ambiguity, or terminal state. Raw provider events remain untrusted.
4. Moxie may inspect, continue, check later, steer, take direct control,
   release, or stop. Session queue `interrupt` is best-effort and does not
   accept `model` or `maxCostUsd`; until live qualification proves budget
   inheritance, steering cancels/fences the run and explicitly creates a
   same-session continuation with the remaining operation budget.
   Steering holds the exclusive control claim, obtains the cancelled run's
   final cost, and deducts that spend before granting the replacement budget.
   Missing cost cannot become a fresh full budget. Terminal receipt and spend
   commit together, so retrying a failed terminal write cannot charge twice.
   The replacement's operation reference and the account's active-run
   checkpoint also rotate in one transaction; neither can name the old run
   while the other names its replacement.
5. Nautilo obtains final output only after terminal state, validates it against
   the tool schema, and collects requested bytes through provider output APIs.
6. **Stop** calls `POST /runs/{id}/cancel` and reports cancellation truthfully.
   A later retry is a new user/agent decision with a new run, never an
   automatic replay of the cancelled action.

The current adapter is the implementation seam:
[`browser-use-cloud.ts`](../packages/server/src/browser-use/browser-use-cloud.ts).
Its existing read methods establish the server-only key custody, coarse event
projection, cancellation, profile selection, browser stop, and output-import
patterns that action work must extend rather than bypass.

### Oversight and completed-browser reuse

The bundled `connected-websites` skill teaches the Genie to delegate a
finishable question with scope, evidence, and a stopping condition. Inspection
returns durable activity and available results, not a conversation with the
hosted agent or its internal reasoning. The Genie inspects quietly at routine
checkpoints, then continues, steers, takes control, or stops according to
progress toward the goal. Meaningful findings, strategy changes, blockers,
and the final answer warrant Human-facing updates; every click does not.

Routine successful browser actions and browser readiness update the durable
activity log without waking the Genie. Failures, meaningful artifacts, final
results, and explicitly requested checks retain their wake path. Queued wakes
re-read owner, conversation, epoch, and fingerprint at execution; a superseded
checkpoint exits before invoking the Genie.

Website wakes reuse the serialized system-foreground runtime, not a second
scheduler. Their trusted `connected_web_operation` metadata marks the input
as internal; routine tool lifecycle events and pre-tool narration do not
stream into chat. The exact tool-call/result rows remain durable audit data
with that origin, excluded from conversational history/search, unread counts
and summaries. Tool-free answers remain ordinary visible messages. Their
speech uses the initiating Human request's trusted voice preference, stored in
the sealed read intent; legacy operations with no preference remain text-only.
Only published tool-free text enters speech detection, so inspect/skip chatter
stays silent. The Genie must inspect and act as needed, then use targetless `skip` for an uneventful
checkpoint; the original operation card still exposes activity and Watch/Stop.
The wake does not acquire Human foreground/Desktop authority and does not
start background memory reviews for each checkpoint. This is presentation
control, not an instruction to disable supervision or hide actionable errors.
Existing rows written before this metadata contract are not rewritten.

`check_later` accepts an ISO due time and stores a distinct durable wake time.
It does not expose a free-text check condition, which has no implemented
durable semantics. Provider observation keeps running independently; a due requested check wakes the exact initiating Genie
even when no new provider event exists. Wake delivery and browser cleanup have
independent scheduling lanes, so a slow provider observation cannot block them.

Workspace-output and saved-item runs do not enter the warm text-read pool.
After output import, their account checkpoint records pending cleanup before
Nautilo resolves the exact hosted session and explicitly stops its browsers.
Only confirmed shutdown releases that checkpoint. Failed cleanup is retried
by the background pump without replaying the task. A saved-item verifier uses
a fresh model context after its writer's browser has stopped and persisted
the profile; each prior run is stopped before its reference is replaced.

A lost run-creation response is not a confirmed rejection. Both asynchronous
reads and synchronous Workspace reads retain their admission reservation when
creation is transport-uncertain, including through restart. Without a known run
or supported exact-resource reconciliation, this remains an explicit recovery
gap; releasing the reservation or blindly retrying could create another paid
run. Steering still has a post-create/pre-persistence crash window and must
not be represented as fully reconciled across every provider response loss.

Direct Stop closes input immediately but retains the exact lease and recovery
epoch until browser, private daemon, directory and ownership cleanup succeed.
Concurrent Stop calls share an attempt; later Stop can retry failed cleanup
without starting another browser or restarting Nautilo.

Human deletion waits for active/uncertain website work to finish or be stopped.
It locks operation custody, stops owned terminal warm browsers, deletes provider
profiles, then cascades website history before deleting referenced Genies and
the Human. A failed cleanup keeps the local recovery owner intact.

The activity ledger admits only validated descriptions and statuses from V4
`core.event` / `tool` / `browser_execute` events. Raw code, output, metadata,
and reasoning are excluded. Unsupported descriptions are visibly withheld.
The latest 25 entries are returned with a cursor for older entries; the page
size is not a retention limit. Cursor advancement and ledger insertion commit
atomically. These are provider-reported actions, not independent proof that a
read-only instruction prevented all changes on the website.

A successful supervised hosted text read becomes terminal immediately. Its
browser may remain warm for **five idle minutes**, without a running spinner.
A subsequent read by the same owner, account, Genie, Room, thread, and lane
atomically inherits the sealed session/workspace and starts a new run in that
session. It does not create a new browser for every turn while the previous
browser remains available. Other contexts do not inherit that conversation.

An independent cleanup lane durably claims an expired warm browser and calls
the provider's explicit stop endpoint. A cleanup claim permanently prevents
reuse; failed stops retry. Failure/cancellation becomes cleanup-eligible
immediately. Active work and Human sign-in are not subject to this idle clock.
The saved account profile survives browser shutdown. Provider retention or
expiry can still require a new browser; this is not a guarantee of indefinite
VM availability. Workspace-output and effect workflows do not yet use this
warm text-read path.

Direct takeover currently cancels and confirms the old hosted run terminal,
then opens a **fresh browser from the same saved account profile** under the
same operation card. It does not promise to preserve the hosted browser's
current tab or transient DOM. A new snapshot is required. Takeover preserves
the original read/task scope and cannot bypass the legacy saved-item verifier. Release/Stop
explicitly closes direct-control resources.

### Standalone V4 Browser and direct attachment

1. The server creates `POST /browsers` with the exact connected account
   `profileId`, explicit timeout, and recording disabled.
2. Browser Use returns `browserId`, owner-gated live view, an HTTPS CDP
   discovery capability, and `timeoutAt`. The server validates the discovery
   capability, fetches `/json/version`, and accepts only a `wss:` endpoint on
   the same capability host.
3. For a Human login, Nautilo uses the existing one-shot navigator to land the
   initial page and closes its socket before credentials are entered. For
   direct Moxie control, Nautilo supplies the validated WSS URL only
   to one dedicated `agent-browser` CLI/daemon process. It must not be shared
   with another request, user, tab session, or process.
4. Process exit, CDP disconnect, task cancellation, and UI closure are not
   browser teardown. In every completion/failure/cancellation path Nautilo
   calls `PATCH /browsers/{browserId}` with `{"action":"stop"}` and records
   the observed stopped state.

[`cdp-navigator.ts`](../packages/server/src/connected-web-accounts/cdp-navigator.ts)
is the canonical validation seam. Do not add a second CDP discovery parser or
accept an arbitrary WSS URL. The attached process receives the resolved
ephemeral URL through `AGENT_BROWSER_CDP` rather than a command-line argument,
so the capability is not exposed in process arguments. Its environment,
stdout/stderr, daemon state, and cleanup remain server-custody concerns.

## `agent-browser` boundary

Nautilo pins
[`agent-browser` v0.35.2](../packages/server/vendor/agent-browser/manifest.json).
Its source supports attaching with `--cdp` or `AGENT_BROWSER_CDP`, semantic
snapshots with element references, and the control primitives below. Source
presence is **not** evidence that a protected live site will accept the action.

Do **not** use `agent-browser -p browseruse` for Connected Websites. Its
[Browser Use provider](https://github.com/vercel-labs/agent-browser/blob/v0.35.2/cli/src/native/providers.rs)
only reads `BROWSER_USE_API_KEY` and returns
`wss://connect.browser-use.com?apiKey=...`; it accepts no saved `profileId`,
returns no Browser Use `browserId`, creates no Nautilo-owned lifecycle record,
and has no path to Browser Use's required V4 stop endpoint. It is a convenience
launcher for a fresh provider browser, not a connected-account integration.

The upstream MCP server defaults to the `core` profile. Profiles describe
available upstream commands; they are not Nautilo's approved runtime API.
Nautilo must use a dedicated CLI/daemon adapter with an explicit connected-
account command allow-list. It reuses the existing semantic `browser_*`
schemas only through a sealed operation/account/epoch route; it must not expose
`agent-browser mcp --tools all`, raw evaluation, cookies/storage, arbitrary
CDP, or provider coordinates to a Genie.

| Upstream profile | Relevant v0.35.2 command surface | Contract status |
| --- | --- | --- |
| `core` (default) | snapshot/ref, click, fill/type, press, check/uncheck, select, scroll, waits, screenshot, basic tabs, eval | Candidate for basic qualified controls only |
| `tabs` | tab/window operations, frame switching, JavaScript dialog status/accept/dismiss | Candidate only after popup/frame/dialog probes |
| `debug` | upload/download commands and diagnostics | Not a byte-transfer authority; see Files. Diagnostics are not Genie tools. |
| `mobile` | key down/up, keyboard typing/insertion, coordinate mouse move/down/up/wheel, touch/swipe | Candidate only for proven slider/canvas/map controls |
| `all` | full typed CLI parity, including element-to-element `drag` | Never an exposed Nautilo tool profile; individual commands require qualification |

The `drag` command is element-to-element. Arbitrary coordinate dragging uses
the lower-level mouse sequence and has different failure modes. Frames,
popups, dialogs, drag/drop, sliders, canvas, maps, CAPTCHA, passkeys, and MFA
must therefore be treated as distinct live probes, not as consequences of a
successful click test.

### Snapshot and reference discipline

`agent-browser` clears and rebuilds its reference map on a snapshot. A ref is
valid only for the observed DOM/frame/tab state that produced it. Take a fresh
snapshot before each semantic action after navigation, DOM mutation, popup/tab
change, frame switch, dialog handling, download/upload completion, or any
Human takeover. Never replay an old ref, selector result, coordinate, or
pending command across a hosted-run boundary or a Human checkpoint.

The adapter returns normalized action observations, not raw snapshot text,
HTML, page JavaScript, or a generic `eval` facility. It should use an exact
fresh-reference/action/observe loop and surface an outcome that the connected
website tool schema can validate.

## Files and outputs

`agent-browser upload` passes a supplied path to CDP's
`DOM.setFileInputFiles`, and its download controls configure Chrome's download
directory. Under remote CDP, those are paths on the cloud browser host, not
Nautilo bytes and not a safe bridge to the user's filesystem.

Nautilo file authority is Browser Use V4 Workspace and browser-download APIs:

1. The user explicitly authorizes one private Nautilo artifact for the
   operation. The server uploads its bytes to a Browser Use Workspace and
   attaches only the returned file ID to the intended run with
   `attachedFileIds`.
2. Attachments are run-scoped: reusing a `workspaceId` does not implicitly
   expose every earlier upload to a later run.
3. Requested outputs are listed from the Workspace and from
   `/browsers/{sessionId}/downloads`, fetched by the server through expiring
   provider URLs, validated, and imported into Nautilo's normal artifact
   custody. Provider paths/URLs do not become local paths or user-facing
   authority.

This follows Browser Use's
[Workspace contract](https://docs.browser-use.com/cloud/agent/workspaces).
There is no ambient local-file access and no `agent-browser` upload/download
fallback.

## Human checkpoint

There is no documented universal provider `authentication_required` endpoint.
The trusted Nautilo runtime recognizes login, MFA, CAPTCHA, passkey, payment,
approval, or an explicit request for Human control from validated run state and
tool outcome; the model does not construct an iframe or receive a live URL.

Nautilo's current login intervention reconnects the existing account through
its protected saved-profile login browser. The Human selects **Done** or
**Cancel**; the server makes a fresh, limited observation of the intended page
and visible credential challenges. **Done** alone is not authentication proof.
After the login browser stops and persists the profile, Workbench resumes the
original request through the normal connected-account tool path. If that
continuation cannot be delivered, the UI distinguishes saved sign-in from the
failure to resume. The Genie never requests credentials in chat.

Browser Use also documents a same-session
[Human-in-the-loop flow](https://docs.browser-use.com/cloud/agent/human-in-the-loop).
That provider capability is not a claim that Nautilo's current reconnect flow
preserves the previous hosted browser tab, nor is it an interactive side
channel into an active agent run.

## Qualification matrix and unresolved probes

Before a control becomes available, record its exact Browser Use model,
profile, site class, observed event/action evidence, cleanup result, and
whether the user had to intervene. A successful test on one site does not
generalize to another protected flow.

| Live probe | Initial path | Allowed outcome |
| --- | --- | --- |
| Read-only navigation, search, and extraction on a saved profile | Hosted V4 Agent | Hosted-V4 pass; otherwise Human takeover or unsupported |
| Fill/type/select/check/keyboard and normal submit | Hosted V4 Agent or Moxie direct | Hosted or direct pass; otherwise Human takeover/unsupported |
| Popup/new-tab, iframe, and JavaScript-dialog actions | Hosted V4 Agent or Moxie direct | Hosted or direct pass, Human takeover, or unsupported |
| Explicit Workspace input and requested browser/Workspace output | Hosted V4 Agent plus Workspace APIs | Hosted-V4 pass or unsupported; no host-path substitute |
| HTML drag/drop | Hosted V4 Agent or Moxie direct | Hosted pass, direct element-drag pass, Human takeover, or unsupported |
| Slider, canvas, map, or coordinate-only control | Hosted V4 Agent or Moxie direct | Hosted pass, direct mouse-sequence pass, Human takeover, or unsupported |
| Login, MFA, CAPTCHA, passkey, or a dangerous, irreversible, ambiguous or out-of-scope action | Human checkpoint | Human intervention or a precise stopped/partial result; never a silent direct-control fallback |

Every direct run requires all of: an authorized saved profile; a Browser
Use-created or `agentSessionId`-located browser with an explicitly stopped
lifecycle; validated same-host CDP discovery; one dedicated adapter process;
fresh observations; an exclusive control epoch; allowed-origin enforcement;
and an action/result record sufficient to explain what happened to the owner.
Otherwise the result is Human takeover or unsupported, not a blind retry.

## Version decision

`agent-browser` v0.36.0 adds experimental WebMCP and related plumbing. It does
not establish saved-profile Browser Use lifecycle ownership, safe remote file
transfer, or qualified control reliability for this stack. The pinned v0.35.2
already contains the primitives this contract needs to qualify. Do not upgrade
the Nautilo binary for Connected Websites until a separate evidence-backed
upgrade proposal demonstrates a material contract benefit and passes the
normal vendored-binary verification.

## Source record

- [Browser Use Cloud overview and V4 lifecycle](https://docs.browser-use.com/cloud/llms.txt)
- [Browser Use V4 browser/CDP documentation](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium)
- [Browser Use V4 Workspaces](https://docs.browser-use.com/cloud/agent/workspaces)
- [Browser Use V4 Human in the loop](https://docs.browser-use.com/cloud/agent/human-in-the-loop)
- [agent-browser v0.35.2 README](https://github.com/vercel-labs/agent-browser/blob/v0.35.2/README.md)
- [agent-browser v0.35.2 MCP profile source](https://github.com/vercel-labs/agent-browser/blob/v0.35.2/cli/src/mcp.rs)
- [agent-browser v0.35.2 Browser Use provider source](https://github.com/vercel-labs/agent-browser/blob/v0.35.2/cli/src/native/providers.rs)
