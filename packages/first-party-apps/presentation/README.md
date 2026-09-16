# Nautilo Slides

Native presentation mini-app using the owned `office-slides` engine and its
Core/Docs dependency closure. Nautilo owns document storage, paths, revisions,
admission and app lifecycle. This app does not switch Writer's engine or add an
upstream backend, collaboration service or authentication system.

## Run and qualify

From the repository root:

```sh
bun run slides:prepare
bun run --cwd packages/first-party-apps/presentation typecheck
bun test packages/first-party-apps/presentation/src
bun test packaging/wafflebase/slides-artifacts.test.ts
bun packages/first-party-apps/presentation/scripts/qualify-browser.ts
```

Preparation builds the owned workspace packages and assembles emitted browser,
Node, declarations, lazy assets and notices into ignored `engine/`. It records
source and artifact hashes; it never rewrites compiled engine code. The isolated
artifact regression bundles the app outside the checkout to detect accidental
workspace resolution. A prepared source installation seeds Slides enabled on
first installation; refresh preserves the Human's explicit disabled choice.
Missing or invalid artifacts cannot replace a working seed.

The browser qualification uses the real editor in the normal runtime HTML with a
clearly identified strict-CAS test bridge. It proves browser behavior, not an
authenticated server, production image or native Desktop release.

## Document contract

`new-presentation` creates `Untitled.presentation.html` in either Workspace or
Current Folder. Routing matches the embedded manifest's exact presentation /
wafflebase / `application/vnd.wafflebase.presentation+json` identity. Bare HTML and
PPTX are not claimed by extension. The container has two inert JSON scripts.

Documents require at least one slide. Invalid structure, unsupported element
types, unsafe links, remote images, stale references and any engine migration
that would discard an existing field are refused before replacing the editor.
Unknown JSON fields round-trip through the container; that does not promise that
the current engine can edit every future schema.

Store changes autosave through one strict revision/hash lane. Active text editing
holds autosave until commit; Save, close and recovery-copy actions commit the
editor first. Save conflicts preserve the local draft and offer retry, save copy
or explicit reload. Uncertain writes are reconciled against fresh authority before
retry. Desktop checkpoints recoverable drafts in a protected, target-bound local
journal. Every editable Slides launch creates its canonical document before
returning the initial editor content, including the generic Launch action.
Exact matching drafts can restore; changed bases remain visible as conflicts.
If the saved file is unavailable, reopening its original editor can show its
authorized journal and offer Save Copy. It never recreates a missing original
or overwrites a changed file without fresh validation.

Recovery after an external rename stays associated with the original path;
opening the renamed file does not discover that draft. Use the original editor's
Save Copy action. Opening Workbench still requires its server and authentication;
an already-open Desktop editor can journal through a network outage. Browser-only
sessions have no Desktop journal. An image selection interrupted before its bytes
are incorporated into the draft may need to be selected again; incomplete
recovery is marked as a conflict rather than silently saved over the original.

## Current editing surface

The compact editor provides slide navigation, add/duplicate/delete/reorder,
layouts, document themes, text, rectangle/ellipse/line insertion, embedded raster
images, basic text formatting, fill, undo/redo, speaker notes, fit/zoom and
presentation mode. Its shell uses Nautilo's Ivory/Tokyo palette tokens; switching
the shell theme does not change document content.

### Reusable slide templates

Use **Slide → Save slide as template**, name the captured slide, then open
**Design → My Templates** in any presentation. Selecting a preview inserts an
independent copy after the current slide, with its images, notes, colors and
fonts. Undo removes the insertion. Applying a theme to the presentation also
themes inserted slides. Templates containing charts currently require the same
document text scale; incompatible insertion is refused before changing the deck.

Templates are private Artifacts on the connected server, available across decks
and devices for the signed-in Human. Saving does not depend on the source deck's
name or location. Deleting a template leaves inserted copies intact. Preview
cannot manage templates. This is a reusable slide library, not a linked master
editor; later changes to a template do not propagate into existing decks.

Genie tools create, inspect and edit the same native container. Open-document
tools use host-bound authority, exact inspected versions, approval and host-owned
idempotency. Closed edits use exact SHA/revision CAS. Invalid operation batches
write nothing. Inspection continuation binds the document version and selection.
Text editing preserves supported uniform plain-text styling; richer content is
refused instead of flattened. Replacing notes is explicitly a plain-text operation.
The `update-shape` operation changes an inspected top-level shape’s frame or solid
fill through the same store used by human editing. Coordinates use the inspected
native canvas units and rotation uses radians. Omitted properties, shape styling
and connector attachments are preserved; an explicit solid fill replaces any
gradient. Group members and connector geometry are outside this operation.

## Conversion copies

PowerPoint import creates a native Workspace copy; PowerPoint and PDF export
preserve the editable original. Export warnings explain known fidelity changes.
Workspace exports combine file naming and location selection with that warning
confirmation. The default is this chat's workspace; choosing beside the original
requires create authority in its location. The server derives both destinations
from the existing permission envelope and never accepts a namespace ID or silently
falls back after a refusal. Legacy tool calls without a placement keep source
colocation. Current Folder export stays beside its source.

The `selectWorkspaceDestination` manifest option is for conversions that return
`confirmation_required` before creating their output. Both Slides exporters do
this; destination selection is part of the shared confirmation, not a separate
write or permission system.

PDF rendering requires the open editor and saves through canonical host authority.
Each page is a raster image: text cannot be selected or searched, and animation,
links and speaker notes are omitted. Unverified fonts are disclosed; missing or
undecodable images refuse export. Cancellation and source-version checks prevent
late preparations from writing into a changed document context.

Native text, images, shapes, tables, charts, themes and reusable templates are
editable in Slides. Conversion warnings describe the supported PPTX/PDF boundary;
perfect parity with another presentation viewer is not a native Slides release
requirement. Packaging, authenticated recovery/concurrency and backup/restore
acceptance are recorded separately from source checks and release publication.
