# Floating Genie

The compact **Float Genie** button beside the Genie portrait/name pins the selected Genie and Room to a compact
companion. Its label changes to **Floating** while enabled; click it again to attach
the Genie back in Nautilo. The indicator means floating is enabled; it does
not mean the microphone is listening.

The companion hides while the main Workbench is active. Switch to another app,
minimize Nautilo, or work in another desktop Space and it appears without taking
keyboard focus. Clicking the companion keeps it visible. Returning to the main
Workbench hides only its surface; the bound Room and draft remain. Changing the
main Workbench's Room does not retarget it.

Each activation starts as the compact avatar bubble, retaining the last position. Within
an active session, hiding and showing preserves the chosen view.

The bubble defaults to the pinned Genie's configured avatar with a state ring.
Compact and full chat panels also show her avatar. The **Bubble appearance**
menu can select the abstract orb instead; this preference affects only the
bubble. A Genie without a portrait shows her initial. **Refresh** also reloads
the portrait. The authenticated owner resolves the existing Room avatar route
and sends a display-sized PNG; the detached renderer receives no media token
or protected URL.

Use the visible expand button on the bubble to open chat. The controls
menu switches between Voice bubble, Compact panel and Full chat, and docks to any screen
edge. Drag the bubble or any non-button area of the expanded header
(including the avatar and name) to move freely. Right-click or Shift+F10 opens controls from compact
views. **Open Room in Nautilo** returns to the pinned conversation, including
earlier history, task progress and approvals. **Turn off floating Genie** closes
the companion; existing durable Room work continues normally.
The **×** at the top-left of compact views (and in the expanded header) turns
off floating in one click, leaving the conversation attached in Nautilo.

The detached chat uses the Room history projection, shared virtualized transcript,
Markdown and tool-card rendering, and the existing Lexical composer. Text wraps;
Enter sends and Shift+Enter inserts a newline. Tool actions and richer Room controls
remain in the main Room. The companion reuses the Room-panel reducer for live
text, tool cards and send reconciliation. It receives authenticated events from
the existing Workbench socket, including while a different Room is selected;
it does not open another socket. Outgoing messages appear immediately with
**Sending…**, then reconcile with their persisted row without disappearing.
History loads preserve live arrivals. Unconfirmed sends stay visible and are
never automatically retried.

The **voice bubble** uses two taps: tap the avatar to start recording, then tap
again to transcribe and send that spoken turn. The listening ring turns green,
with a send-arrow cue in the bottom-right recording button. Transcribing and sending show a
spinner and ignore additional taps. The bubble remains draggable throughout;
it never expands automatically. Tap while Genie is speaking to interrupt her
and record a reply. Tap while she is working to record a follow-up.

Only the explicit Expand button opens full chat. Chat and compact prompt are
two sizes of the same panel: collapsing history preserves the draft and shows
a latest-message preview. Sending keeps the chosen size. The panel microphone
is dictation: finish recording to get an editable draft, then press the separate
Send arrow. A bubble spoken turn never includes the panel's unsent draft or
attachments. An unconfirmed send preserves its transcript for review and shows
an expand-to-check-chat cue; it is never automatically retried.

The bubble keeps fixed controls around the portrait: attach at top-left, expand
at top-right, Stop action at bottom-left, Stop talking at bottom-center, and
record/send at bottom-right. Tapping the avatar or record/send button performs
the same two-tap voice action; the portrait stays clear. Both Stop buttons
remain visible and are disabled when unavailable. There is no separate waveform
mode or mic/sound strip. The microphone is closed until recording starts and
stops before transcription. **Escape** or **Discard recording** in the menu
cancels capture or pending transcription. Continuous listening, wake phrases
and addressee classification remain follow-on work.

The panel has separate **Mic** and **Sound** controls; both are green when on.
Starting a recording interrupts current speech without changing sound settings.
Spoken replies default on for first floating activation, unless the Human has
already chosen a voice preference. Muting persists through view changes and
reactivation. The preference is shared with the main Desktop voice control.
Sound off stops playback and prevents future spoken replies until re-enabled,
without stopping Room work or capture. A muted bubble shows a small Sound off
badge that can re-enable replies; Sound is also in the controls menu. The pinned
Room remains unchanged when sound is off or the main Room changes.

The status distinguishes listening, transcription, sending and running work.
While a send is pending, the composer shows **Sending…** and a spinner;
compact views show activity without adding persistent text. Sending is not a
delivery receipt: uncertain sends retain their existing recovery message.

Room and companion history share filename presentation for complete leading
legacy attachment envelopes. Ambiguous delimiters preserve the original message.
This text-only presentation cannot distinguish an intentionally typed exact
envelope from historical adapter output; it does not establish attachment identity.

Prompt and chat reuse the main Room's **Stop talking** pill above the input.
During a streaming reply it remains available through buffering and sentence
gaps, until the audio finishes playing or is stopped. Its reserved row keeps the
input and send controls in place. Every Stop talking control uses the same
waveform-and-small-square symbol; the speaker icon belongs only to Sound.
**Stop talking** immediately clears local playback and suppresses later audio
from that turn, while work continues. **Stop action** separately uses the existing cancellation endpoint
for the pinned Room, including queued work. Its square button stays visible at a
fixed position in every view, grayed out when idle. It remains enabled throughout
unfinished Room work, including gaps between tool calls, and is temporarily
disabled while cancellation is pending. It is also available in the controls menu.
Both controls remain available when Genie is speaking and working simultaneously.
Prompt and chat label the square **Stop action**; compact views use distinct
waveform-and-small-square and plain square icons. Stopping work does not implicitly silence playback.
It shows **Stopping** until the server responds; a failed request does not claim
the work stopped. A pending send does not delay the initial stop request. If that
send is unresolved, the control reports uncertainty and requests stop again when
the send settles, before admitting another companion send. Escape discards active capture first, otherwise stops current
speech, otherwise stops running Room work.

The paperclip opens the existing native file picker attached to the companion.
Filename chips show uploading, ready or failed status and can be removed before
sending. Uploads use the existing Room attachment API and server validation;
unfinished or failed uploads block sending. Attachment-only messages are supported.
The parent owns the upload queue, and it does not mix with drafts in other Rooms.

Voice playback reuses Nautilo's existing player and socket, pinned to the
companion Room while floating. Navigation, hiding or collapsing does not create a
second player or recorder. Other composers share the microphone lease: starting
one capture cancels the previous capture and pending transcription. Off, identity
changes and admission loss cancel capture and fence late results. Text remains
available after microphone or transcription failures.

## Ownership and access

The authenticated Workbench owns Room history, encryption admission and sends.
The companion is a shared Workbench renderer in a separate sandboxed Electron
window with an ephemeral session. It has no authentication tokens or general
Desktop bridge. Its narrow preload exposes only typed display/input commands;
native code checks the exact sender, main frame, owner and binding generation.
The child can load same-origin UI assets but cannot call APIs, open sockets,
create windows, download files or capture media.

One binding belongs to one active server session and Human. Logout, server
switch, revoked admission, connection loss, Workbench reload/crash and explicit
Off close it and fence pending callbacks. A successful late send may still have
created canonical Room work; the companion never retries an uncertain send.
Only layout preferences persist to disk. Messages, drafts and identity bindings
are volatile.

The runtime's existing authenticated socket publishes Room identifiers when
durable history changes. The companion owner refreshes through the same
authorized, encryption-aware Room operations used elsewhere. It does not create
another socket or accept message bodies from an alternate transport. Failed
history reads clear the cached display and direct the Human back to the Room.

The native visibility policy uses the main Workbench window and its owned
dialogs, not application-wide activation. A companion click therefore cannot
hide its own window. On macOS it uses Electron's non-activating panel type for
fullscreen Spaces. Native Space, key-window and occlusion notifications recheck
visibility, including repeated swipes that do not emit an application focus event.
Space changes reapply the window ordering rather than trusting the previous state.
A small source-built macOS helper checks the exact main window's presence for
Spaces where the panel retains keyboard focus. It reads window
metadata, never pixels or titles, and preserves the floater when another active
app has an on-screen window, including on a second display.
Dock placement is clamped to available display work areas
when displays change. Animation stops while hidden or when reduced motion is
requested.

## Development

The contributor lab under `dev/tools/genie-lab` remains a deterministic shell
regression and visual comparison harness. It shares the production surface and
geometry, but simulated voice states and local draft previews are not product
integration evidence. The production companion defaults to the selected Genie's portrait, with Nautilo's existing orb as an option.
The lab-only Persona artwork remains outside production until its redistribution
terms are established.
