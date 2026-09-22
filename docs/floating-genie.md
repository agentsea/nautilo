# Floating Genie

The small **Float Genie** icon beside the Genie portrait/name pins the selected Genie and Room to a compact
companion. The indicator beside the control means floating is enabled; it does
not mean the microphone is listening.

The companion hides while the main Workbench is active. Switch to another app,
minimize Nautilo, or work in another desktop Space and it appears without taking
keyboard focus. Clicking the companion keeps it visible. Returning to the main
Workbench hides only its surface; the bound Room and draft remain. Changing the
main Workbench's Room does not retarget it.

Each activation starts as the compact avatar bubble, retaining the last position. Within
an active session, hiding and showing preserves the chosen view.

The bubble defaults to the pinned Genie's configured avatar with a state ring.
Prompt, chat and waveform views also show her avatar. The **Bubble appearance**
menu can select the abstract orb instead; this preference affects only the
bubble. A Genie without a portrait shows her initial. **Refresh** also reloads
the portrait. The authenticated owner resolves the existing Room avatar route
and sends a display-sized PNG; the detached renderer receives no media token
or protected URL.

Use the visible expand button on the orb or waveform to open chat. The controls
menu switches between orb, waveform, prompt and chat, and docks to any screen
edge. Drag the orb, waveform, or any non-button area of the expanded header
(including the avatar and name) to move freely. Right-click or Shift+F10 opens controls from compact
views. **Open Room in Nautilo** returns to the pinned conversation, including
earlier history, task progress and approvals. **Turn off floating Genie** closes
the companion; existing durable Room work continues normally.
The **×** at the top-left of compact views (and in the expanded header) turns
off floating in one click, leaving the conversation attached in Nautilo.

The detached chat uses the Room history projection, shared virtualized transcript,
Markdown and tool-card rendering, and the existing Lexical composer. Text wraps;
Enter sends and Shift+Enter inserts a newline. Tool actions and richer Room controls
remain in the main Room; the detached cards display admitted history without
starting network observers or recovery actions.

The mic starts off. Tap **Record a voice message**, speak, then tap again to
finish and send through the existing hosted transcription endpoint. The bubble
or waveform also starts/finishes recording; while Genie is speaking, tapping it
stops her speech instead. A separate **Mute and discard recording** control
stops hardware capture and cancels pending transcription. This prototype is
turn-by-turn: automatic speech detection, wake phrases and addressee classification
are follow-on work.

The status distinguishes listening, transcription, sending and running work.
While a send is pending, the composer shows **Sending…** and a spinner;
compact views show activity without adding persistent text. Sending is not a
delivery receipt: uncertain sends retain their existing recovery message.

Room and companion history share filename presentation for complete leading
legacy attachment envelopes. Ambiguous delimiters preserve the original message.
This text-only presentation cannot distinguish an intentionally typed exact
envelope from historical adapter output; it does not establish attachment identity.

**Stop talking** (speaker ×) immediately clears local playback and suppresses later audio
from that turn, while work continues. **Stop action** separately uses the existing cancellation endpoint
for the pinned Room, including queued work. Its square button appears during work
in compact and expanded views and is always available in the controls menu.
Both controls remain available when Genie is speaking and working simultaneously.
Prompt and chat label the square **Stop action**; compact views use distinct
speaker and square icons. Stopping work does not implicitly silence playback.
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
companion Room once enabled. Navigation, hiding or collapsing does not create a
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
