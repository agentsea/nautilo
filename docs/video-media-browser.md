# Video media browser

Video uses one host-owned browser for adding project media
and generation references. The editor action is **Add media**. Simple and Advanced
use **Add references** and **Replace reference**. Sources are **Artifacts** (media
in the bound Workspace), **Media Bin** (the current project), and **Computer**.
Both thumbnail and list views show readable names and previews, support search
and media-type filters, and preserve multiple selections while browsing. A
replacement chooses one item. Generation accepts images, videos, and MP3/WAV
audio references. Audio requires
an image or video companion. References can apply to all scenes or selected
scenes, and optional **Extra instructions** describe how to use each reference.
Earlier role guidance remains visible in that single field.

Cancel, Escape, and the visible close button return to the project silently.
Opening a chooser does not create a global status banner. Errors remain actionable
and dismissible; dismissing a message does not cancel an operation. Actual import
work shows local progress. Successful additions appear in their destination.

The host lists and revalidates artifacts under the existing room/viewer/project
binding. The iframe receives selected lineage and inspected metadata only, never
unselected inventory, physical paths, preview authority, or provider credentials.
Project changes and session changes invalidate outstanding selections. Previews
remain lazy and release on close. Verified identical copies retain the existing
content grouping and accessible originals. Existing project media is reused.

Batch additions use canonical Video media admission and generation-reference
mutations. Partial native failures preserve successful items and identify the
failed items. First-source frame-rate decisions remain explicit; batches resume
after that decision. No selection starts paid generation or changes the timeline.

Qualification covers search/filter/view changes, batch selection, keyboard close
and focus, cancellation without banners, errors and dismissal, document switching,
preview disposal, mixed-media admission, existing Media Bin reuse, reference
replacement, and save/reopen. Migration 0292 extends the durable request-payload constraint to accept
optional audio references. No new production dependency is required.

## Local verification

The implementation is exercised by the Video editor and composer tests, the
host picker and MiniAppSurface tests, the serialized iframe bridge tests, and
native streaming tests. They cover batch persistence, first-source rate adoption,
partial failures, cancellation, exact artifact revision checks, and cleanup when
project or viewer changes. Browser layout checks cover 1100, 736, and 360 pixel
widths in both themes, with a fixed footer and scrollable results.

Mixed-media selection requires compatible Workbench/Video and Desktop native
builds: older Desktop code accepts image-only batches. Current Folder imports
retain their native path; the three-source browser is for Workspace projects.
