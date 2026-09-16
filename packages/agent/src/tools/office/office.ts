/**
 * `office` — D362 Tier-0 LibreOffice tool (server-side / cloud executor).
 *
 * Operates on office documents via the nwuno engine (LibreOffice headless).
 * Reads an artifact by path, runs a transform/mutation through
 * `@nautilo/loffice`, and (for write ops) saves the result. NOT a relay
 * tool — the engine is server-side, so this is reachable from cloud/mobile
 * sessions (spec R5/D-6).
 *
 * Engine URL: NAUTILO_OFFICE_PORT (set per-instance by the dev-stack `office`
 * service) → http://localhost:<port>/, default 2003.
 *
 * Zones:
 *   - "home" / "scratch" — the legacy artifact-storage providers (server-
 *     owned LocalStorageProvider). In-place read + write back to the same
 *     provider. Byte-for-byte unchanged from D362 Tier-0.
 *   - "workspace" — the namespaced workspace-artifacts store (M088B).
 *     READ resolves the input artifact via `resolveWorkspaceArtifact` using
 *     the envelope's `readableNamespaces` and reads bytes off the server-
 *     owned artifact root. WRITE ops MINT A NEW workspace artifact at `out`
 *     (logical path) — envelope-gated by `writableNamespaces[0]` — and
 *     NEVER overwrite the input artifact. In-place mutation of a live-
 *     open workspace doc is a separate, later milestone (it needs a lock
 *     guard to be safe); this milestone ships zero-clobber read + new-
 *     artifact write only.
 *
 * The factory accepts a context bag matching the catalog's ToolFactory
 * shape; `memoryAccessEnvelope` is extracted defensively so home/scratch
 * still work when no envelope is present (e.g. tests, legacy callers).
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { extname, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { LofficeClient, CoolSessionClient, readImagePixelSize, resizeImageToCm, LO_INSERT_DPI, type CoolSessionLike, type CoolSessionOptions, type UnoArgs } from "@nautilo/loffice";
import { mimeFromExtensionOr } from "@nautilo/attachments";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { getArtifactZone } from "../artifacts/storage-registry";
import {
  applyWorkspaceArtifactRowChange,
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  validateLogicalPath,
  type EnvelopeFacts,
  type WorkspaceArtifactPatchMeta,
} from "../file/artifact-store";
import { getOfficeSessionBroker, type OfficeSessionBroker, type OfficeSessionMintOptions } from "./session-broker";
import { getOfficeSessionManager } from "./session-manager";

function officeBaseUrl(): string {
  const port = process.env["NAUTILO_OFFICE_PORT"] ?? "2003";
  return process.env["NAUTILO_OFFICE_URL"] ?? `http://localhost:${port}/`;
}

function ext(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

interface OfficeToolContext {
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
}

function contextFromUnknown(ctx: unknown): OfficeToolContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const envRaw = c["memoryAccessEnvelope"];
  // Trust the envelope shape only when it looks well-formed enough to
  // be usable; otherwise pass null so the workspace branch can give a
  // concrete error instead of dereferencing undefined fields. home/scratch
  // ignore the envelope entirely.
  const envelope =
    envRaw && typeof envRaw === "object"
      ? (envRaw as MemoryAccessEnvelope)
      : null;
  return { memoryAccessEnvelope: envelope };
}

const OfficeSchema = z.object({
  command: z
    .enum([
      "info", "convert", "render", "extract", "compare",
      "find_replace", "template_fill", "insert_text", "set_cell", "set_range",
      "format_range",
      // D362 Wave J — agent-side Writer ops (inPlace-only; live coolwsd
      // session). Closes the agent-parity gap vs. the human Writer ribbon
      // (office-doc-surface.tsx). `format_text` is the keystone: find+select
      // an anchor phrase via .uno:ExecuteSearch (FIND), then fire the
      // provided format verbs. `insert_link` / `insert_comment` / 
      // `track_changes` mirror the ribbon's Insert + Review groups. The
      // existing `insert_table` op (Wave I) already serves Writer — the
      // `.uno:InsertTable {Columns, Rows}` arg shape is identical to the
      // Writer ribbon's (office-doc-surface.tsx:759), so no new command.
      "format_text", "insert_link", "insert_comment", "track_changes",
      // D362 — Writer co-creative review loop (inPlace-only; live coolwsd
      // session). Closes the agent-parity gap vs. the human Writer Review
      // group (office-writer-review-group.tsx): the 8 FF verbs that let a
      // Genie ACCEPT/REJECT tracked changes — making "suggest mode" real
      // (agent proposes tracked edits → either party accepts/rejects).
      // All FF, no args; mirrors the slide_move / arrange_shape enum→verb
      // map pattern. Grounded in phase-3-writer-editor.md §3.3.8.
      "review_changes",
      "meta_get", "meta_set",
      // D362 Wave C — agent-side Impress ops (inPlace-only; live coolwsd session).
      "slide_insert", "slide_duplicate", "slide_delete", "slide_move",
      "slide_goto", "set_layout", "set_notes", "place_textbox",
      // D362 Wave I — agent-side Impress shape + slide ops (inPlace-only).
      // Built on the `select_shape_at` keystone (audit §3.3 route 1:
      // LOK `mouse` click at twips coord via the existing `sendMouse`).
      // Shape-format / arrange verbs operate on the current selection;
      // they accept an optional `at: {x,y}` (cm) which fires
      // `select_shape_at` first.
      "select_shape_at", "format_shape", "arrange_shape",
      "slide_visibility", "insert_table", "insert_chart", "master_view",
      // D362 Wave G — Calc sheet management + freeze panes (inPlace-only;
      // live coolwsd session). Closes the standout Calc agent-parity gap
      // vs. the human tab bar (sheet add/rename/delete/switch) and adds
      // the freeze-panes toggle. Sheet verbs grounded in
      // `browser/src/control/Parts.js` (the same path the human tab bar
      // fires); freeze grounded in sc/sdi + Control.NotebookbarCalc.js.
      "sheet", "freeze_panes",
      // D362 — Calc Data-group parity (inPlace-only). Sort asc/desc +
      // AutoFilter over a range: the human Data ribbon fires these FF
      // (office-calc-groups.tsx CalcDataGroup) but the agent had no
      // equivalent. All three are SfxVoidItem (FF, no args) in
      // sc/sdi/scalc.sdi (SID_SORT_ASCENDING/DESCENDING, SID_AUTO_FILTER);
      // we select the range via .uno:GoToCell first, then fire. (Sparklines
      // stay UI-only: SID_INSERT_SPARKLINE opens SparklineDialogWrapper —
      // dialog-gated → Wave J, not a cheap FF add.)
      "calc_data",
      // D362 Wave G — Impress cheap-tail (inPlace-only; live coolwsd
      // session). Grounded FF verbs from impress-endpoint-audit §2.1
      // G12-G20. Field insert, expand/summary, master-display toggles,
      // autofit, convert, enter/leave group. Each is fire-and-forget;
      // the save + durability gate is the sync point.
      "slide_field", "slide_outline", "master_display",
      "shape_autofit", "convert_shape", "group_nav",
      // D362 — last cheap agent-parity tail (Calc borders + Impress
      // presenter / image original-size). All inPlace-only; grounded FF
      // verbs or, for borders, the Collabora preset builder. See sendLowLevelOps.
      "presentation",
      // D362 Wave K — agent image insert (inPlace-only; live coolwsd
      // session). Closes the agent-parity gap vs. the human Insert > Image
      // button (now wire-verified via the multipart proxy fix `1b5bbfb3`).
      // Transport path (b): the agent has the image bytes, the proxy
      // forwards multipart bodies, coolwsd writes the file to its jail and
      // the socket `insertfile name=… type=graphic` line drops the image
      // at the current cursor/selection. GROUNDED in
      // `EXTERNAL/collabora-online-source/browser/src/map/handler/Map.FileInserter.js`
      // (the human button's wire). NO `uno ` prefix — `insertfile` is a
      // raw socket line, not a UNO command.
      "insert_image",
    ])
    .describe("The office operation to run."),
  zone: z.enum(["home", "scratch", "workspace"]).optional().default("home")
    .describe(
      'Artifact zone. "home" (default) = user-visible; "scratch" = ephemeral; ' +
      '"workspace" = namespaced workspace-artifacts store (read + write-to-new-artifact).',
    ),
  path: z.string().optional().describe("Input artifact path, relative to the zone root."),
  out: z.string().optional().describe("Output artifact path (convert/render/mutations write here)."),
  to: z.string().optional().describe('convert target format, e.g. "pdf","xlsx" (else inferred from out extension).'),
  find: z.string().optional(),
  replace: z.string().optional(),
  regex: z.boolean().optional(),
  mapping: z.record(z.string(), z.string()).optional().describe('template_fill: {"key":"value"} — fills ${key}.'),
  text: z.string().optional(),
  atEnd: z.boolean().optional(),
  cell: z.string().optional().describe('set_cell target, e.g. "A1".'),
  value: z.union([z.string(), z.number()]).optional().describe('set_cell value; string starting "=" is a formula.'),
  sheet: z.number().optional().describe("0-based sheet index for Calc ops."),
  range: z.string().optional().describe('set_range / format_range target, e.g. "A1" or "A1:C3".'),
  rows: z.union([
    z.array(z.array(z.union([z.string(), z.number()]))),
    z.number(),
  ]).optional().describe(
    "set_range: a grid of cell values (array of rows). " +
    "insert_table: row count (number, paired with `cols`).",
  ),
  cols: z.number().optional().describe("insert_table: column count (paired with `rows` as a number)."),
  // ─── format_range (Calc cell formatting, inPlace-only) ───────────────
  // All format fields are optional; only those provided are applied. The
  // range is selected via .uno:GoToCell {ToPoint} first, then each field's
  // verb fires in order. See `sendLowLevelOps` for the grounded verbs +
  // arg shapes (every verb cited from Collabora source + sc/sdi).
  bold: z.boolean().optional().describe("format_range / format_text: bold the cell(s) / anchored run. TOGGLE — see code caveat."),
  italic: z.boolean().optional().describe("format_range / format_text: italic the cell(s) / anchored run. TOGGLE — see code caveat."),
  underline: z.boolean().optional().describe("format_range / format_text: underline the cell(s) / anchored run. TOGGLE — see code caveat."),
  numberFormat: z
    .enum(["general", "number", "currency", "percent", "date"])
    .optional()
    .describe("format_range: number-format preset (maps to .uno:NumberFormat* FF verbs)."),
  merge: z.boolean().optional().describe("format_range: toggle cell merge across the range (.uno:ToggleMergeCells, FF toggle)."),
  wrap: z.boolean().optional().describe("format_range: toggle wrap-text (.uno:WrapText, FF toggle)."),
  fontColor: z
    .string()
    .optional()
    .describe(
      'format_range (Calc): cell text color as "#rrggbb" (sent as .uno:Color { "Color.Color": long }). ' +
      'format_text (Writer): run text color as "#rrggbb" (sent as .uno:FontColor { "FontColor.Color": long } — ' +
      "Writer uses FontColor, NOT Calc's .uno:Color). The command determines which verb fires.",
    ),
  bgColor: z
    .string()
    .optional()
    .describe('format_range: cell FILL color as "#rrggbb" (sent as .uno:BackgroundColor { "BackgroundColor.Color": long }; NOT CharBackColor, which is text highlight).'),
  // ─── format_text (Writer run formatting, inPlace-only) ───────────────
  // All format fields are optional; only those provided are applied. The
  // anchor phrase is found+SELECTED via .uno:ExecuteSearch (FIND) first,
  // then each field's verb fires in order. Every verb is grounded in our
  // own shipped Writer ribbon (office-doc-surface.tsx) — the same verbs the
  // human toolbar fires, LIVE-VERIFIED.
  anchor: z
    .string()
    .optional()
    .describe(
      "format_text / insert_link / insert_comment: existing text to find+select via " +
      ".uno:ExecuteSearch (FIND) before applying the op. Required for format_text; " +
      "optional for insert_link / insert_comment (without it, the op fires at the cursor).",
    ),
  strike: z
    .boolean()
    .optional()
    .describe("format_text: strike-through the anchored run (.uno:Strikeout, FF toggle — see code caveat)."),
  highlightColor: z
    .string()
    .optional()
    .describe(
      'format_text: text highlight color as "#rrggbb" (sent as .uno:CharBackColor { "CharBackColor.Color": long }; ' +
      "Writer text highlight — NOT Calc cell fill, which uses bgColor/.uno:BackgroundColor).",
    ),
  style: z
    .string()
    .optional()
    .describe(
      'format_text: paragraph-style name e.g. "Heading 1", "Title", "Subtitle" (sent as ' +
      '.uno:StyleApply { Style: string, FamilyName: "ParagraphStyles" }).',
    ),
  fontFamily: z
    .string()
    .optional()
    .describe(
      "format_text: font family name (sent as .uno:CharFontName { 'CharFontName.FamilyName': string }).",
    ),
  fontSize: z
    .number()
    .optional()
    .describe(
      "format_text: font size in points (sent as .uno:FontHeight { 'FontHeight.Height': float }).",
    ),
  url: z
    .string()
    .optional()
    .describe(
      "insert_link: the hyperlink URL (sent as .uno:SetHyperlink { 'Hyperlink.URL': string }).",
    ),
  enabled: z
    .boolean()
    .optional()
    .describe(
      "track_changes / freeze_panes: desired state (true = on, false = off). IDEMPOTENT — the " +
      "tool reads the live command state and only toggles if it differs, so repeating the same " +
      "value is a no-op (falls back to a single toggle if state is unreadable).",
    ),
  align: z
    .enum(["left", "center", "right", "top", "middle", "bottom"])
    .optional()
    .describe(
      "format_range: cell horizontal alignment (left/center/right → .uno:AlignLeft/AlignHorizontalCenter/AlignRight, FF). " +
      "arrange_shape: shape alignment (left/center/right/top/middle/bottom → .uno:ObjectAlignLeft/AlignCenter/ObjectAlignRight/AlignUp/AlignMiddle/AlignDown, FF).",
    ),
  borders: z
    .enum(["outline", "all", "none"])
    .optional()
    .describe(
      "format_range: cell border preset (sent as .uno:SetBorderStyle with a prebuilt OuterBorder/InnerBorder " +
      "arg shape grounded in `EXTERNAL/collabora-online-source/browser/src/control/Control.Toolbar.js:39-152` " +
      "`getBorderStyleUNOCommand`. 'outline' → outer 4 borders only; 'all' → outer + inner; 'none' → clear all borders. " +
      "Color defaults to black (0); arbitrary border specs are out of scope (build-sheet §4.2).",
    ),
  meta: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("meta_set fields (title/author/subject/keywords)."),
  path2: z.string().optional().describe("compare: the second (new) document path."),
  // D362 Wave K — agent image insert (inPlace-only; live coolwsd session).
  // The DOC being edited is `path` (consistent with all other inPlace ops);
  // `imagePath` is the workspace image artifact to drop onto the current
  // cursor/selection. Resolved via `resolveWorkspaceArtifact` with
  // intent:"read" — same path `compare` uses for `path2`.
  imagePath: z
    .string()
    .optional()
    .describe(
      'insert_image: the workspace image artifact to insert (e.g. "assets/logo.png"). ' +
      "The doc being edited is `path` (the inPlace target); `imagePath` is the image. " +
      "Placement is INTENT-LEVEL: describe what you want via `at` (a named anchor " +
      "like 'center' / 'top-left' / 'bottom-right', or an explicit {x, y} cm point) " +
      "and `size` ('fit' [default] = contain on-slide preserving aspect, a fraction " +
      "of slide width, or explicit {w, h} cm). The tool parses the image's native " +
      "pixel size from its header bytes, fetches the real slide size, computes the " +
      "rect, clamps it on-slide, and returns the placed rect — you never touch twips " +
      "or native pixel sizes. `w`/`h` are accepted as a legacy explicit-cm override.",
    ),
  // ─── Impress slide ops (Wave C) ────────────────────────────────────
  // All coordinates/sizes for `place_textbox` are in **centimetres**
  // (the documented unit for this tool). The agent path converts to
  // twips before emitting the LOK `mouse` event (1 cm ≈ 566.93 twips).
  // Slide sizes for reference: 4:3 = 25.4 × 19.05 cm (14400×10800 twips),
  // 16:9 = 33.87 × 19.05 cm (19200×10800 twips).
  at: z
    .union([
      z.number(),
      z.string(),
      z.object({ x: z.number(), y: z.number() }),
    ])
    .optional()
    .describe(
      "slide_insert: 0-based position (number) to insert at. Omit for " +
      "FF `.uno:InsertPage` (inserts after the current slide). " +
      "select_shape_at / format_shape / arrange_shape: {x, y} in centimetres " +
      "for the shape-selection click (converted to twips internally; " +
      "1 cm ≈ 566.93 twips). " +
      "insert_image: a NAMED anchor string ('center' [default], 'top-left', " +
      "'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', " +
      "'bottom-right') OR an explicit {x, y} cm point for the placed image's " +
      "top-left. The tool computes the rect from the image's native aspect + " +
      "the real slide size, then anchors it. You never touch twips or native " +
      "pixel sizes — describe placement, the tool fits + places + tells you " +
      "where it landed (see the returned `placedRect`).",
    ),
  dir: z.enum(["up", "down", "first", "last"]).optional().describe(
    "slide_move: direction to move the current slide — " +
    '"up" | "down" | "first" | "last" (maps to .uno:MovePageUp/Down/First/Last).',
  ),
  index: z.number().optional().describe(
    "slide_goto: 0-based slide index to make active (sent as `setclientpart part=<n>`). " +
    "place_textbox / insert_image / slide_field: legacy alias for the target slide index (prefer `targetSlide`).",
  ),
  size: z
    .union([
      z.enum(["fit"]),
      z.number(),
      z.object({ w: z.number().optional(), h: z.number().optional() }),
    ])
    .optional()
    .describe(
      "insert_image: SEMANTIC size intent — the tool computes the rect; you " +
      "never touch twips or native pixel sizes. " +
      "'fit' [default] = contain within ≤ 0.9 of the slide preserving the " +
      "image's native aspect (aspect-correct, GUARANTEED on-slide). " +
      "A number (e.g. 0.33) = that fraction of the SLIDE WIDTH, height " +
      "derived from native aspect. " +
      "{w, h} in cm = explicit size; if only one of w/h is given the other " +
      "is derived from native aspect; both given = used as-is (may distort). " +
      "With NO params at all the image is contained + centered, " +
      "aspect-correct, on-slide. The returned `placedRect` tells you exactly " +
      "where it landed.",
    ),
  slide: z.number().optional().describe(
    "set_layout / set_notes: 0-based slide index the op targets. " +
    "set_layout sends `setclientpart` then `.uno:AssignLayout` with WhatPage=slide. " +
    "place_textbox / insert_image / slide_field: supported alias for target slide index (prefer `targetSlide`).",
  ),
  targetSlide: z.number().optional().describe(
    "place_textbox / insert_image / slide_field: explicit 0-based target slide index. " +
    "Alias-accepts `slide` / `index`; if multiple aliases are provided they must match. " +
    "insert_image sets the active part BEFORE the insertfile so the image lands on the " +
    "intended slide. slide_field creates a fresh text box on the target slide before " +
    "firing the field UNO (the field lands in the new box).",
  ),
  layoutId: z.number().optional().describe(
    "set_layout: AutoLayout enum value (e.g. 20 = Blank, 0 = Title Slide, " +
    "1 = Title+Content; see Collabora `Definitions.Menu.ts:2196-2199`).",
  ),
  x: z.number().optional().describe("place_textbox / format_shape: top-left X (place_textbox) or target X (format_shape TransformPosX), in centimetres."),
  y: z.number().optional().describe("place_textbox / format_shape: top-left Y (place_textbox) or target Y (format_shape TransformPosY), in centimetres."),
  w: z.number().optional().describe(
    "place_textbox / format_shape / insert_image: width in centimetres " +
    "(place_textbox = new text box size; format_shape / insert_image = " +
    "TransformWidth in twips; type \"unsigned long\" — see code caveat). " +
    "insert_image: legacy explicit-cm override for the placed image width " +
    "(prefer the `size` semantic API). If `h` is omitted alongside `w`, " +
    "height is derived from the image's native aspect (parsed from its " +
    "header bytes — no live echo). If neither `w`/`h` nor `size` is given, " +
    "the image is fit-to-slide preserving aspect.",
  ),
  h: z.number().optional().describe(
    "place_textbox / format_shape / insert_image: height in centimetres " +
    "(place_textbox = new text box size; format_shape / insert_image = " +
    "TransformHeight in twips; type \"unsigned long\" — see code caveat). " +
    "insert_image: legacy explicit-cm override for the placed image height " +
    "(prefer the `size` semantic API). If `w` is omitted alongside `h`, " +
    "width is derived from the image's native aspect (parsed from its " +
    "header bytes — no live echo). If neither `w`/`h` nor `size` is given, " +
    "the image is fit-to-slide preserving aspect.",
  ),
  // ─── Wave I — Impress shape formatting (format_shape, inPlace-only) ───
  // All operate on the current shape selection; pair with `at: {x,y}` to
  // select the shape first. Grounded in audit §1.4 / §1.5 / §1.6 / §1.7.
  fillColor: z
    .string()
    .optional()
    .describe('format_shape: shape fill color as "#rrggbb" (sent as .uno:FillColor { "FillColor.Color": long }, audit §1.4 G1).'),
  lineColor: z
    .string()
    .optional()
    .describe('format_shape: shape line color as "#rrggbb" (sent as .uno:XLineColor { "XLineColor.Color": long }, audit §1.4 G2).'),
  rotation: z
    .number()
    .optional()
    .describe(
      "format_shape: rotation in degrees (sent as .uno:TransformDialog " +
      "TransformRotationDeltaAngle in 1/100°; TransformRotationX/Y center = " +
      "the `at` coord in twips, or the slide origin if `at` omitted — audit §1.4 G3).",
    ),
  flipH: z.boolean().optional().describe("format_shape: flip horizontally (.uno:FlipHorizontal, FF; audit §1.4 G8)."),
  flipV: z.boolean().optional().describe("format_shape: flip vertically (.uno:FlipVertical, FF; audit §1.4 G8)."),
  originalSize: z
    .boolean()
    .optional()
    .describe(
      "format_shape: reset the selected image to its native size (.uno:OriginalSize FF; audit §1.4 G19). " +
      "Operates on the current image selection; pair with `at` to click-select the image first.",
    ),
  // ─── Wave I — arrange_shape (z-order / align / group; audit §1.5-§1.7) ─
  zorder: z
    .enum(["front", "back", "forward", "backward"])
    .optional()
    .describe(
      "arrange_shape: z-order verb — " +
      '"front"→.uno:BringToFront, "back"→.uno:SendToBack, "forward"→.uno:ObjectForwardOne, "backward"→.uno:ObjectBackOne (FF; audit §1.5 G4).',
    ),
  group: z.boolean().optional().describe("arrange_shape: group the current multi-selection (.uno:FormatGroup, FF; audit §1.6 G5)."),
  ungroup: z.boolean().optional().describe("arrange_shape: ungroup the current selection (.uno:FormatUngroup, FF; audit §1.6 G5)."),
  // ─── Wave I — slide_visibility / master_view (audit §1.1 G9, §1.11 G14) ─
  hidden: z
    .boolean()
    .optional()
    .describe("slide_visibility: true → .uno:HideSlide, false → .uno:ShowSlide (FF on current slide; audit §1.1 G9)."),
  enter: z
    .boolean()
    .optional()
    .describe("master_view: true → .uno:SlideMasterPage (enter Master View), false → .uno:CloseMasterView (FF; audit §1.11 G14)."),
  mode: z
    .enum(["current", "rehearse"])
    .optional()
    .describe(
      "presentation: 'current' → .uno:PresentationCurrentSlide (start slideshow from the current slide), " +
      "'rehearse' → .uno:RehearseTimings (enter presenter console with timer). Both FF, no args; audit §1.2 G16. " +
      "LIVE-VERIFY: embed / fullscreen behavior is unverified (same caveat as `.uno:Presentation` build-sheet §4.6).",
    ),
  // ─── Wave G — Calc sheet management + freeze panes (inPlace-only) ────
  // `index` (0-based) is reused for the sheet index across `sheet` actions.
  // `name` is the sheet name for `sheet` add/rename. `action` discriminates
  // the verb family per command (sheet add/rename/delete/switch, slide_outline
  // expand/summary, group_nav enter/leave). `kind` discriminates field/convert
  // variants. All grounded in wave-c-build-sheet §1 + impress-endpoint-audit §2.1.
  action: z
    .enum([
      "add", "rename", "delete", "switch",
      "expand", "summary",
      "enter", "leave",
      // D362 — review_changes (Writer co-creative review loop). The 8 FF
      // verbs mirror the human Review ribbon group (office-writer-review-
      // group.tsx); each maps to a grounded .uno: verb (see sendLowLevelOps).
      "accept", "reject",
      "accept_next", "reject_next",
      "accept_all", "reject_all",
      "next", "prev",
      // calc_data (Calc Data-group parity): sort the selected range or toggle
      // AutoFilter. All FF (SfxVoidItem) — see command enum comment.
      "sort_asc", "sort_desc", "autofilter",
    ])
    .optional()
    .describe(
      "sheet: 'add' | 'rename' | 'delete' | 'switch' (paired with `index` 0-based sheet position; " +
      "rename also takes `name`). " +
      "slide_outline: 'expand' → .uno:ExpandPage, 'summary' → .uno:SummaryPage (FF on current slide; audit §1.1 G13). " +
      "group_nav: 'enter' → .uno:EnterGroup, 'leave' → .uno:LeaveGroup (FF on current selection; audit §1.6 G20). " +
      "review_changes: 'accept' → .uno:AcceptTrackedChange, 'reject' → .uno:RejectTrackedChange, " +
      "'accept_next' → .uno:AcceptTrackedChangeToNext, 'reject_next' → .uno:RejectTrackedChangeToNext, " +
      "'accept_all' → .uno:AcceptAllTrackedChanges, 'reject_all' → .uno:RejectAllTrackedChanges, " +
      "'next' → .uno:NextTrackedChange, 'prev' → .uno:PreviousTrackedChange " +
      "(all FF, no args; grounded in office-writer-review-group.tsx + phase-3 §3.3.8). " +
      "calc_data: 'sort_asc' → .uno:SortAscending, 'sort_desc' → .uno:SortDescending, " +
      "'autofilter' → .uno:DataFilterAutoFilter (all FF; range selected via .uno:GoToCell first).",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "sheet add/rename: the sheet name. add: empty/omitted → Core assigns 'SheetN' (build-sheet §1). " +
      "rename: required — the new sheet name.",
    ),
  kind: z
    .enum([
      "pagenumber", "pagecount", "pagetitle", "date", "time", "author", "text",
      "bitmap", "metafile", "bezier",
    ])
    .optional()
    .describe(
      "slide_field: 'pagenumber' → .uno:InsertPageField, 'pagecount' → .uno:InsertPagesField, " +
      "'pagetitle' → .uno:InsertPageTitleField, 'date' → .uno:InsertDateFieldVar, " +
      "'time' → .uno:InsertTimeFieldVar, 'author' → .uno:InsertAuthorField, " +
      "'text' → sendTextInput(text) in active shape edit context. " +
      "Structured fields are FF; free-text uses textinput (audit §1.12 G12 + textbox follow-up). " +
      "convert_shape: 'bitmap' → .uno:ConvertIntoBitmap, 'metafile' → .uno:ConvertIntoMetaFile, " +
      "'bezier' → .uno:ChangeBezier (FF on selected shape; audit §1.4 G18).",
    ),
  displayBackground: z
    .boolean()
    .optional()
    .describe(
      "master_display: toggle 'Display master background' on the current slide " +
      "(.uno:DisplayMasterBackground FF toggle; audit §1.3 G15). TOGGLE — see code caveat.",
    ),
  displayObjects: z
    .boolean()
    .optional()
    .describe(
      "master_display: toggle 'Display master objects' on the current slide " +
      "(.uno:DisplayMasterObjects FF toggle; audit §1.3 G15). TOGGLE — see code caveat.",
    ),
  autofit: z
    .boolean()
    .optional()
    .describe(
      "shape_autofit: toggle auto-fit-to-size on the selected text box " +
      "(.uno:TextAutoFitToSize FF toggle; audit §1.13 G17). TOGGLE — see code caveat.",
    ),
  inPlace: z.boolean().optional().describe(
    "Workspace-only. Edits the doc through a live Collabora engine session so " +
    "changes appear in the human's open editor (coolwsd holds the WOPI lock; " +
    "save flows back via WOPI PutFile → revision bump + SSE). Valid with " +
    "command = find_replace | insert_text | set_cell | set_range | " +
    "format_range | format_text | insert_link | insert_comment | " +
    "track_changes | review_changes | slide_insert | slide_duplicate | " +
    "slide_delete | slide_move | slide_goto | set_layout | set_notes | " +
    "place_textbox | select_shape_at | format_shape | arrange_shape | " +
    "slide_visibility | insert_table | insert_chart | master_view | sheet | " +
    "freeze_panes | slide_field | slide_outline | master_display | " +
    "shape_autofit | convert_shape | group_nav | presentation | insert_image, and zone = workspace.",
  ),
});

type OfficeArgs = z.infer<typeof OfficeSchema>;

const WRITE_COMMANDS = new Set<OfficeArgs["command"]>([
  "convert",
  "render",
  "compare",
  "find_replace",
  "template_fill",
  "insert_text",
  "set_cell",
  "set_range",
  "meta_set",
]);

/** Minimal client surface the tool uses — lets tests inject a fake without a global module mock. */
type OfficeEngineClient = Pick<
  LofficeClient,
  | "info"
  | "convert"
  | "compare"
  | "findReplace"
  | "templateFill"
  | "insertText"
  | "setCells"
  | "setRange"
  | "getStructured"
  | "getMeta"
  | "setMeta"
>;

export interface CreateOfficeToolDeps {
  /** Override the engine client (tests inject a fake). Defaults to a real `LofficeClient`. */
  makeClient?: (baseUrl: string) => OfficeEngineClient;
  /**
   * Override the coolwsd session client factory for `inPlace: true` workspace
   * edits (tests inject a fake). Defaults to a real `CoolSessionClient`.
   * The factory receives the broker-minted `{ wsBaseUrl, docUrl, wopiSrc }`
   * triple plus the per-session timeout.
   */
  makeSession?: (opts: CoolSessionOptions) => CoolSessionLike;
  /**
   * Override the durability gate (§3.4.7). Defaults to polling the
   * physical file for a byte change after save. Tests inject a fake to
   * exercise the changed / not-confirmed branches hermetically.
   */
  gate?: DurabilityGate;
}

export function createOfficeTool(context?: unknown, deps?: CreateOfficeToolDeps) {
  const officeCtx = contextFromUnknown(context);
  const makeClient = deps?.makeClient ?? ((baseUrl: string) => new LofficeClient({ baseUrl }));
  const makeSession = deps?.makeSession ?? ((opts: CoolSessionOptions) => new CoolSessionClient(opts));
  const gate: DurabilityGate = deps?.gate ?? waitForDurableChange;
  return new DynamicStructuredTool({
    name: "office",
    description: `Operate on office documents (.docx/.xlsx/.pptx and more) headlessly via LibreOffice.

Reads an artifact from the "home"/"scratch"/"workspace" zone, runs the operation, and (for write ops) saves the result to \`out\`.

ZONES:
- "home" (default) / "scratch": legacy server-side artifact storage. Read + write go through the same provider.
- "workspace": the namespaced workspace-artifacts store. Reads resolve the input artifact by logical path under the current Room's Namespace rules. Write ops MINT A NEW workspace artifact at \`out\` — they never overwrite the input artifact.

TO EDIT A WORKSPACE DOCUMENT IN PLACE, PREFER THE \`edit_doc\` TOOL — it applies the change to the user's live document, verifies it persisted, and returns the updated content. Use \`office\`'s workspace write ops (find_replace/insert_text → new artifact) only for producing a separate output file, and use extract/convert/render/meta_get for reading.

COMMANDS:
- info: engine + supported filters (no path).
- convert <path> <out> [--to fmt]: convert format (e.g. docx→pdf, xlsx→csv).
- render <path> <out.pdf|png>: render to PDF/image.
- extract <path>: structured content as JSON. Writer → paragraphs/tables/headings; Calc → sheet rows; Impress/Draw → SLIDE GEOMETRY (doctype "slides": slideSize {widthCm,heightCm} + per-slide shapes [{name, type, xCm, yCm, wCm, hCm, z, text ≤200ch}]) — positions in the SAME cm units place_textbox/format_shape take, so extract → judge overlap/off-slide → adjust is a closed loop (spatial awareness).
- compare <path> <path2> <out>: produce a comparison document.
- find_replace <path> <out> --find --replace [--regex]
- template_fill <path> <out> --mapping {k:v}: fill \${k} placeholders (invoices, contracts…).
- insert_text <path> <out> --text [--atEnd]
- set_cell <path> <out> --cell A1 --value V [--sheet n]
- set_range <path> <out> --range A1:B2 --rows [[...]] [--sheet n]
- format_range <path> --range A1:C3 [--bold] [--italic] [--underline] [--numberFormat general|number|currency|percent|date] [--merge] [--wrap] [--fontColor #rrggbb] [--bgColor #rrggbb] [--align left|center|right] [--borders outline|all|none]   (inPlace only, zone=workspace — live Calc cell formatting; borders preset grounded in Collabora getBorderStyleUNOCommand)
- meta_get <path> / meta_set <path> <out> --meta {title,author,...}

Writer (inPlace only, zone=workspace — agent parity with the Writer ribbon):
- format_text <path> --anchor A [--bold] [--italic] [--underline] [--strike] [--fontColor #rrggbb] [--highlightColor #rrggbb] [--style "Heading 1"] [--fontFamily F] [--fontSize N]   — find+select the anchor phrase, then fire the provided Writer format verbs (.uno:Bold/Italic/Underline/Strikeout toggles, .uno:FontColor, .uno:CharBackColor, .uno:StyleApply, .uno:CharFontName, .uno:FontHeight). CAVEAT: bold/italic/underline/strike are FF TOGGLES — assumes the anchored run isn't already in that state.
- insert_link <path> --text T --url U [--anchor A]   — insert a hyperlink (.uno:SetHyperlink {Hyperlink.Text, Hyperlink.URL}); with anchor, selects the anchor first.
- insert_comment <path> --text T [--anchor A]   — insert a comment (.uno:InsertAnnotation FF). DEFERRED: the text-set arg is NOT grounded in our shipped code; the comment is inserted empty (the agent's \`text\` is accepted but not dispatched). See code comment.
- track_changes <path> --enabled bool   — IDEMPOTENT set of Writer track-changes (the "suggest mode" enabler). Reads the live .uno:TrackChanges state and toggles only if it disagrees with --enabled, so calling twice with the same value won't flip it back. Falls back to a single toggle if the state can't be read.
- insert_table <path> --rows N --cols M   — already supported (the Wave I op uses .uno:InsertTable {Columns, Rows}, the same arg shape the Writer ribbon fires). Shared with Impress.

Impress (inPlace only, zone=workspace):
- slide_insert [--at n]      — insert a slide (FF after current, or at 0-based pos).
- slide_duplicate            — duplicate the current slide.
- slide_delete               — delete the current slide.
- slide_move --dir up|down|first|last — move the current slide.
- slide_goto --index n       — make the 0-based slide N active (setclientpart).
- set_layout --slide n --layoutId id — apply an AutoLayout to slide N.
- set_notes --slide n --text T    — set the speaker-notes text on slide N (LIVE-VERIFY PENDING).
- place_textbox --x --y --w --h (cm) --text T [--targetSlide n | --slide n | --index n] — insert a text box with text, then move/size it to (x,y,w,h). Deterministic: constructs via .uno:Text?CreateDirectly:bool=true (SID_ATTR_CHAR, no mouse), fills text, then .uno:TransformDialog places it. If a target slide is provided, sets that slide first (all provided aliases must agree). Confirm with extract (slide geometry). NOTE: slide-targeting under headless is the remaining live-verify.

Image insert (inPlace only, zone=workspace — Wave K; agent parity with the human Insert > Image button):
- insert_image --path <doc> --imagePath <image> [--targetSlide n | --slide n | --index n] [--at <named-anchor|{x,y}>] [--size fit|<frac>|{w,h}] [--w Wcm] [--h Hcm]  — INTENT-LEVEL image placement. Describe what you want: 'at' is a NAMED anchor ('center' [default], 'top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right') OR an explicit {x, y} cm point; 'size' is 'fit' [default] (contain on-slide, aspect-correct, ≤ 0.9 of slide) | a fraction of slide width (e.g. 0.33, height from native aspect) | explicit {w, h} cm (one of w/h → derive the other from native aspect; both → as-is). With NO params: contain + center, aspect-correct, GUARANTEED on-slide. The tool parses the image's native pixel size from its header bytes (PNG IHDR / JPEG SOF — NO live \`graphicselection:\` echo dependency), fetches the REAL slide size from the engine (last-resort fallback = 25.4×19.05 cm, flagged in the result), computes the rect, clamps it on-slide, and applies \`.uno:TransformDialog\` (cm→twips, TransformWidth/Height as type "unsigned long" — same proven path place_textbox uses), then \`.uno:Escape\`. 'w'/'h' are accepted as a legacy explicit-cm override (prefer 'size'). The result INCLUDES the placed rect {xCm, yCm, wCm, hCm} + the slide size + the native pixels the tool used, so the agent gets immediate spatial feedback WITHOUT a separate 'extract'. Transport: getchildid → multipart POST {name, childid, file} to /cool/<WOPISrc>/insertfile → socket \`insertfile name=… type=graphic\` (grounded in Map.FileInserter.js). LIVE-VERIFY PENDING (Genie readback): the image visibly lands correctly on the live slide; confidence is HIGH because sizing is computed deterministically from bytes + slide size (not a runtime echo) — the unit tests are meaningful proof of the geometry.

Impress shapes (inPlace only, zone=workspace — Wave I; audit §3 + §1.4-§1.7, §1.10-§1.11):
- select_shape_at --at {x,y} (cm)  — select the shape at a slide coordinate (LOK mouse click at twips; the keystone for shape-format verbs). LIVE-VERIFY HEAVY.
- format_shape [--at {x,y}] [--fillColor #rrggbb] [--lineColor #rrggbb] [--x --y --w --h (cm)] [--rotation deg] [--flipH] [--flipV] [--originalSize]  — format the selected shape (or the shape at 'at'); fill/line color, position/size/rotation via .uno:TransformDialog, flips FF; originalSize → .uno:OriginalSize FF on a selected image (audit §1.4 G19).
- arrange_shape [--at {x,y}] [--zorder front|back|forward|backward] [--align left|center|right|top|middle|bottom] [--group] [--ungroup]  — z-order / align / group-ungroup on the selected shape(s) (all FF).
- slide_visibility [--slide n] --hidden bool  — hide/show the current (or Nth) slide (.uno:HideSlide / ShowSlide, FF).
- insert_table --rows N --cols M  — insert an N×M table onto the current slide (.uno:InsertTable {Columns, Rows}).
- insert_chart  — insert a default chart onto the current slide (FF .uno:InsertObjectChart; chart CONFIG is dialog-gated — out of scope). Also serves Calc — in a Calc sheet, FF .uno:InsertObjectChart inserts a default chart from the current selection (same shared op, no Calc-specific path needed).
- master_view --enter bool  — enter/exit Master View (.uno:SlideMasterPage / .uno:CloseMasterView, FF).
- presentation --mode current|rehearse  — start slideshow from the current slide (.uno:PresentationCurrentSlide) or enter presenter-console rehearse-timings mode (.uno:RehearseTimings). Both FF, no args; audit §1.2 G16. LIVE-VERIFY: embed/fullscreen behavior unverified (same caveat as .uno:Presentation build-sheet §4.6).

Calc sheets + freeze (inPlace only, zone=workspace — Wave G; closes the standout agent-parity gap vs. the human tab bar):
- sheet --action add|rename|delete|switch [--index n] [--name S]  — manage sheets. add → .uno:Insert {Name, Index: index+1} (1-based; pass \`index\` for the 0-based position; omit \`name\` to let Core assign SheetN). rename → .uno:Name {Name, Index: index+1} (requires \`name\`). delete → .uno:Remove {Index: index+1}. switch → setclientpart part=<index> (0-based).
- freeze_panes --enabled bool  — IDEMPOTENT set of Calc freeze-panes at the current cursor. Reads the live .uno:FreezePanes state and toggles only if it disagrees with --enabled (falls back to a single toggle if the state can't be read).
- calc_data --range A1:C20 --action sort_asc|sort_desc|autofilter  — Data-group parity: selects the range then fires .uno:SortAscending / .uno:SortDescending (sort by the leftmost column) or .uno:DataFilterAutoFilter (toggle header filters). All FF. (Sparklines / insert-function stay UI-only — dialog-gated, Wave J.)

Impress cheap-tail (inPlace only, zone=workspace — Wave G; audit §2.1 G12-G20):
- slide_field --kind pagenumber|pagecount|pagetitle|date|time|author|text [--text T] [--targetSlide n | --slide n | --index n]  — insert a field into a FRESH text box on the target slide. The op creates a text box via .uno:Text?CreateDirectly:bool=true (same context-establishing verb place_textbox uses), fires the field UNO (.uno:InsertPageField/InsertPagesField/InsertPageTitleField/InsertDateFieldVar/InsertTimeFieldVar/InsertAuthorField, FF) at the cursor in the new box, then .uno:Escape. For kind=text, sends raw textinput (NOT .uno:InsertText). Inserting a field into an EXISTING placeholder requires a separate select_shape_at + double-click flow (LIVE-VERIFY HEAVY, not wired here). LIVE-VERIFY PENDING (Genie readback): field lands in the saved doc on the target slide.
- slide_outline --action expand|summary  — .uno:ExpandPage / .uno:SummaryPage (FF on current slide; audit §1.1 G13).
- master_display [--displayBackground bool] [--displayObjects bool]  — toggle per-slide 'Display master background'/'Display master objects' (.uno:DisplayMasterBackground / .uno:DisplayMasterObjects, FF toggles; audit §1.3 G15). CAVEAT: state toggles — see code comment.
- shape_autofit [--at {x,y}] --autofit bool  — toggle auto-fit on the selected text box (.uno:TextAutoFitToSize, FF toggle; audit §1.13 G17). CAVEAT: state toggle.
- convert_shape [--at {x,y}] --kind bitmap|metafile|bezier  — convert the selected shape (.uno:ConvertIntoBitmap / .uno:ConvertIntoMetaFile / .uno:ChangeBezier, FF; audit §1.4 G18).
- group_nav --action enter|leave  — enter/leave a group selection (.uno:EnterGroup / .uno:LeaveGroup, FF; audit §1.6 G20).

Requires the office engine (dev-stack \`office\` profile). For zone="workspace", requires a room/namespace context (the catalog plumbs the memory-access envelope at tool-resolve time).`,
    schema: OfficeSchema,
    func: async (args: OfficeArgs) => {
      const client = makeClient(officeBaseUrl());

      if (args.command === "info") {
        try {
          const info = await client.info();
          return JSON.stringify({
            unoserver: info.unoserver,
            api: info.api,
            export_filters: Object.keys(info.export_filters).length,
            import_filters: Object.keys(info.import_filters).length,
          });
        } catch (err) {
          return `Error: office engine unreachable at ${officeBaseUrl()} — is the dev-stack 'office' profile up (bun run office:up)? ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // `inPlace` is workspace-only — reject it for home/scratch with a
      // clear error rather than silently ignoring the flag.
      if (args.inPlace === true && args.zone !== "workspace") {
        return `Error: inPlace is only supported on zone="workspace" (got zone="${args.zone}").`;
      }

      // Workspace zone — route through the artifact-store path (read +
      // write-to-new-artifact). Home/scratch fall through to the legacy
      // LocalStorageProvider path below.
      if (args.zone === "workspace") {
        return await dispatchWorkspaceOffice(args, officeCtx, client, makeSession, gate);
      }

      const provider = getArtifactZone(args.zone);
      if (!provider) return `Error: artifact zone "${args.zone}" is not initialised (server wiring bug).`;
      if (!args.path) return `Error: '${args.command}' requires 'path'.`;
      const stat = await provider.stat(args.path);
      if (!stat) return `Error: artifact not found at zone=${args.zone} path=${args.path}.`;
      if (stat.isDirectory) return `Error: ${args.path} is a directory.`;

      const inExt = ext(args.path);
      let bytes: Uint8Array;
      try {
        bytes = await provider.read(args.path);
      } catch (err) {
        return `Error: could not read ${args.path}: ${err instanceof Error ? err.message : String(err)}`;
      }

      const needOut = (): string | null => (args.out ? null : `Error: '${args.command}' requires 'out'.`);
      const writeOut = async (data: Uint8Array): Promise<string> => {
        await provider.write(args.out!, data);
        return JSON.stringify({ ok: true, command: args.command, out: args.out, zone: args.zone, bytes: data.byteLength });
      };

      try {
        switch (args.command) {
          case "convert":
          case "render": {
            const bad = needOut(); if (bad) return bad;
            const to = args.to ?? ext(args.out!);
            if (!to) return `Error: cannot infer target format; pass 'to'.`;
            return await writeOut(await client.convert(bytes, to));
          }
          case "compare": {
            const bad = needOut(); if (bad) return bad;
            if (!args.path2) return `Error: compare requires 'path2'.`;
            const s2 = await provider.stat(args.path2);
            if (!s2) return `Error: artifact not found: ${args.path2}.`;
            const bytes2 = await provider.read(args.path2);
            return await writeOut(await client.compare(bytes, bytes2, ext(args.out!)));
          }
          case "find_replace": {
            const bad = needOut(); if (bad) return bad;
            if (args.find === undefined || args.replace === undefined) return `Error: find_replace requires 'find' and 'replace'.`;
            return await writeOut(await client.findReplace(bytes, inExt, args.find, args.replace, args.regex ?? false));
          }
          case "template_fill": {
            const bad = needOut(); if (bad) return bad;
            if (!args.mapping) return `Error: template_fill requires 'mapping'.`;
            return await writeOut(await client.templateFill(bytes, inExt, args.mapping));
          }
          case "insert_text": {
            const bad = needOut(); if (bad) return bad;
            if (args.text === undefined) return `Error: insert_text requires 'text'.`;
            return await writeOut(await client.insertText(bytes, inExt, args.text, args.atEnd ?? true));
          }
          case "set_cell": {
            const bad = needOut(); if (bad) return bad;
            if (!args.cell || args.value === undefined) return `Error: set_cell requires 'cell' and 'value'.`;
            return await writeOut(await client.setCells(bytes, inExt, [{ sheet: args.sheet ?? 0, cell: args.cell, value: args.value }]));
          }
          case "set_range": {
            const bad = needOut(); if (bad) return bad;
            if (!args.range || !Array.isArray(args.rows) || args.rows.length === 0) return `Error: set_range requires 'range' and a non-empty 'rows' grid.`;
            return await writeOut(await client.setRange(bytes, inExt, args.sheet ?? 0, args.range, args.rows));
          }
          case "extract": {
            return JSON.stringify(await client.getStructured(bytes, inExt));
          }
          case "meta_get": {
            return JSON.stringify(await client.getMeta(bytes, inExt));
          }
          case "meta_set": {
            const bad = needOut(); if (bad) return bad;
            if (!args.meta) return `Error: meta_set requires 'meta'.`;
            return await writeOut(await client.setMeta(bytes, inExt, args.meta));
          }
          default:
            return `Error: unknown command.`;
        }
      } catch (err) {
        return `Error: office '${args.command}' failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

// ===========================================================================
// edit_doc — intent-level Writer edit surface (§3.4.8/§3.4.9)
//
// The DURABLE, protocol-free write path for workspace documents. Jeannie
// states an intent (append / replace_exact / …) and a path; the tool owns
// the entire coolwsd chain (session reuse, UNO verbs, save, durability
// gate, re-extract) and returns document-language results ONLY. There is
// deliberately NO `zone`, NO `inPlace`, and NO session/transport knob in
// the schema — the model cannot, and must not, reason about the engine.
// ===========================================================================

const EditDocSchema = z.object({
  operation: z
    .enum(["append", "replace_exact", "insert_after", "insert_before", "rewrite_section", "delete"])
    .describe(
      "What to do: 'append' adds text to the end of the document; " +
        "'replace_exact' replaces one exact existing phrase (given in 'anchor') with 'text'; " +
        "'insert_after'/'insert_before' place 'text' relative to the paragraph containing 'anchor'; " +
        "'rewrite_section' replaces the paragraph containing 'anchor' with 'text'; " +
        "'delete' removes the exact 'anchor' text from the document.",
    ),
  path: z.string().describe("The workspace document to edit (e.g. 'notes/plan.docx')."),
  text: z
    .string()
    .optional()
    .describe("The text to add or the replacement text. Not used by 'delete'."),
  anchor: z
    .string()
    .optional()
    .describe(
      "Existing text to locate. Required for replace_exact / insert_after / insert_before / " +
        "rewrite_section / delete. Not used by 'append'.",
    ),
});

type EditDocArgs = z.infer<typeof EditDocSchema>;

/** Flatten a structured extract into plain text for anchor matching. */
function extractPlainText(structured: unknown): string {
  if (!structured || typeof structured !== "object") return "";
  const s = structured as Record<string, unknown>;
  const parts: string[] = [];
  const pushArr = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") parts.push(item);
        else if (item && typeof item === "object" && "text" in (item as Record<string, unknown>)) {
          const t = (item as Record<string, unknown>)["text"];
          if (typeof t === "string") parts.push(t);
        }
      }
    }
  };
  pushArr(s["headings"]);
  pushArr(s["paragraphs"]);
  // Calc sheets: join cell strings row-wise.
  if (Array.isArray(s["sheets"])) {
    for (const sheet of s["sheets"] as unknown[]) {
      const rows = (sheet as Record<string, unknown>)?.["rows"];
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (Array.isArray(row)) parts.push(row.map((c) => String(c ?? "")).join("\t"));
        }
      }
    }
  }
  if (parts.length === 0) {
    // Fallback: stringify so a substring search still has something to hit.
    return JSON.stringify(structured);
  }
  return parts.join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function createEditDocTool(context?: unknown, deps?: CreateOfficeToolDeps) {
  const officeCtx = contextFromUnknown(context);
  const makeClient = deps?.makeClient ?? ((baseUrl: string) => new LofficeClient({ baseUrl }));
  const makeSession = deps?.makeSession ?? ((opts: CoolSessionOptions) => new CoolSessionClient(opts));
  const gate: DurabilityGate = deps?.gate ?? waitForDurableChange;
  return new DynamicStructuredTool({
    name: "edit_doc",
    description: `Edit a Writer/office document by intent. This is the reliable way to change a user's document. It applies the edit on the live document, WAITS until the new bytes are durably saved, and only then returns — so its result is authoritative.

Give an 'operation', the document 'path', and the 'text':
- append: add 'text' to the end of the document (never deletes existing content).
- replace_exact: replace one exact existing phrase ('anchor') with 'text'.
- insert_after / insert_before: add 'text' as a new paragraph after / before the paragraph containing 'anchor'.
- rewrite_section: replace the whole paragraph containing 'anchor' with 'text'.
- delete: remove the exact 'anchor' text from the document (no 'text' needed). Use this instead of deleting piecemeal.

All anchor ops change nothing if 'anchor' is absent or appears more than once (it tells you), so you never edit the wrong place.

You do not manage saving, sessions, retries, or formats — the tool handles the engine and retries transient transport failures internally.

TRUST THE RESULT — do not re-verify or loop:
- changed:true → the edit is DONE and already verified against the saved document. 'updatedDoc' is the real post-edit content. Do NOT run 'office extract' to double-check, and do NOT call edit_doc again for the same change.
- changed:false → the document was NOT changed; act on 'reason' instead of repeating the identical call. "text to replace was not found" → re-read the doc (office extract) and use exact wording. "appears N times" → give a longer, unique 'anchor'. "did not persist" → a rare transient; retry AT MOST once.

Use this for any request to modify a workspace document.`,
    schema: EditDocSchema,
    func: async (args: EditDocArgs) => dispatchEditDoc(args, officeCtx, makeClient(officeBaseUrl()), makeSession, gate),
  });
}

async function dispatchEditDoc(
  args: EditDocArgs,
  ctx: OfficeToolContext,
  client: OfficeEngineClient,
  makeSession: (opts: CoolSessionOptions) => CoolSessionLike,
  gate: DurabilityGate,
): Promise<string> {
  const fail = (reason: string): string =>
    JSON.stringify({ changed: false, path: args.path, reason });

  if (!ctx.memoryAccessEnvelope) {
    return fail("this document isn't available in the current workspace context.");
  }
  const factsResult = envelopeFactsForArtifacts(ctx.memoryAccessEnvelope);
  if (!factsResult.ok) return fail(factsResult.reason);
  const facts = factsResult.facts;
  if (!facts.agentId) return fail("editing requires an authenticated workspace context.");

  const validated = validateLogicalPath(args.path);
  if (!validated.ok) return fail(validated.reason);

  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts,
    intent: "read",
  });
  if (!resolution.ok) return fail(resolution.reason);
  if (!resolution.artifact) return fail(`there is no document at "${validated.path}".`);

  const broker = getOfficeSessionBroker();
  if (!broker) {
    return fail("document editing is temporarily unavailable. Please try again shortly.");
  }

  const inExt = ext(validated.path);
  const physicalPath = resolution.physicalPath;

  // Pre-extract once for anchor matching + a before/after summary basis.
  let preText = "";
  try {
    const bytes = await readFile(physicalPath);
    preText = extractPlainText(await client.getStructured(bytes, inExt));
  } catch {
    // Non-fatal: proceed without a pre-image (append doesn't need it;
    // anchor ops will still rely on the engine's own search).
  }

  // Anchor-based ops (replace_exact + positional) share a uniqueness guard:
  // the anchor must exist EXACTLY once, or we refuse rather than edit the
  // wrong place. Returns a fail-reason string, or null when OK.
  const requireUniqueAnchor = (anchor: string | undefined): string | null => {
    if (anchor === undefined || anchor.length === 0) {
      return `'${args.operation}' needs an 'anchor' — the exact existing text to locate.`;
    }
    if (preText.length > 0) {
      const n = countOccurrences(preText, anchor);
      if (n === 0) return `the anchor text was not found in the document: "${truncateForReason(anchor)}".`;
      if (n > 1) {
        return `the anchor "${truncateForReason(anchor)}" appears ${n} times; provide a longer, unique phrase so only the intended one is used.`;
      }
    }
    return null;
  };

  // A FIND (not replace) ExecuteSearch that SELECTS the anchor so a
  // subsequent cursor-move UNO acts relative to the anchor's paragraph.
  const findSelectArgs = (anchor: string): UnoArgs => ({
    "SearchItem.SearchString": { type: "string", value: anchor },
    "SearchItem.Backward": { type: "boolean", value: false },
    "SearchItem.Command": { type: "long", value: SVX_SEARCH_CMD_FIND },
    "SearchItem.SearchStartPointX": { type: "long", value: 0 },
    "SearchItem.SearchStartPointY": { type: "long", value: 0 },
  });

  // Every op except `delete` needs `text`. Guard once so the branches can
  // treat it as a definite string.
  if (args.operation !== "delete" && args.text === undefined) {
    return fail(`'${args.operation}' needs 'text' — what to add or use as the replacement.`);
  }
  const textValue = args.text ?? "";

  // Build the op sender + a human summary for the success case.
  let summary = "";
  let sendOps: (session: CoolSessionLike) => Promise<{ noMatch?: boolean; reason?: string }>;

  if (args.operation === "append") {
    summary = `Added ${textValue.length} character(s) to the end of the document.`;
    sendOps = (session) => {
      session.sendUno(".uno:GoToEndOfDoc");
      session.sendUno(".uno:InsertText", { Text: { type: "string", value: textValue } });
      // Fire-and-forget UNO ops don't ack; the transaction's save +
      // durability gate are the sync point.
      return Promise.resolve({});
    };
  } else if (args.operation === "replace_exact") {
    const bad = requireUniqueAnchor(args.anchor);
    if (bad) return fail(bad);
    const anchor = args.anchor as string;
    summary = `Replaced "${truncateForReason(anchor)}" with "${truncateForReason(textValue)}".`;
    sendOps = async (session) => {
      const searchArgs: UnoArgs = {
        "SearchItem.SearchString": { type: "string", value: anchor },
        "SearchItem.ReplaceString": { type: "string", value: textValue },
        "SearchItem.Backward": { type: "boolean", value: false },
        "SearchItem.Command": { type: "long", value: SVX_SEARCH_CMD_REPLACE_ALL },
        "SearchItem.SearchStartPointX": { type: "long", value: 0 },
        "SearchItem.SearchStartPointY": { type: "long", value: 0 },
      };
      // The pre-extract already proved the anchor exists exactly once, so
      // the engine reply is purely a fast-fail hint here.
      return await runExecuteSearch(
        session,
        searchArgs,
        "the text to replace was not found in the document.",
      );
    };
  } else if (args.operation === "delete") {
    // Remove the exact anchor text. Deterministic + unique-anchor gated,
    // same as replace_exact but with an empty replacement — no more
    // one-character-at-a-time deletes. (Whole-paragraph delete + move/copy
    // are the tracked §3.4.10 second cut.)
    const bad = requireUniqueAnchor(args.anchor);
    if (bad) return fail(bad);
    const anchor = args.anchor as string;
    summary = `Deleted "${truncateForReason(anchor)}".`;
    sendOps = async (session) => {
      const searchArgs: UnoArgs = {
        "SearchItem.SearchString": { type: "string", value: anchor },
        "SearchItem.ReplaceString": { type: "string", value: "" },
        "SearchItem.Backward": { type: "boolean", value: false },
        "SearchItem.Command": { type: "long", value: SVX_SEARCH_CMD_REPLACE_ALL },
        "SearchItem.SearchStartPointX": { type: "long", value: 0 },
        "SearchItem.SearchStartPointY": { type: "long", value: 0 },
      };
      return await runExecuteSearch(
        session,
        searchArgs,
        "the text to delete was not found in the document.",
      );
    };
  } else {
    // Positional ops: insert_after | insert_before | rewrite_section.
    // UNO slots verified against LibreOffice core (sw/sdi/swriter.sdi):
    // GoToStartOfPara (FN_START_OF_PARA), GoToEndOfPara (FN_END_OF_PARA),
    // EndOfParaSel (FN_END_OF_PARA_SEL), InsertPara (FN_INSERT_BREAK).
    // Find+select the anchor first so the cursor sits in its paragraph;
    // then fire the positional sequence (fire-and-forget — the save +
    // byte gate proves persistence, and `updatedDoc` shows placement).
    const bad = requireUniqueAnchor(args.anchor);
    if (bad) return fail(bad);
    const anchor = args.anchor as string;
    const op = args.operation;
    summary =
      op === "insert_after"
        ? `Inserted a new paragraph after "${truncateForReason(anchor)}".`
        : op === "insert_before"
          ? `Inserted a new paragraph before "${truncateForReason(anchor)}".`
          : `Rewrote the paragraph containing "${truncateForReason(anchor)}".`;
    sendOps = async (session) => {
      const hint = await runExecuteSearch(
        session,
        findSelectArgs(anchor),
        "the anchor text was not found in the document.",
      );
      if (hint.noMatch) return hint;
      const text: UnoArgs = { Text: { type: "string", value: textValue } };
      if (op === "insert_after") {
        session.sendUno(".uno:GoToEndOfPara");
        session.sendUno(".uno:InsertPara");
        session.sendUno(".uno:InsertText", text);
      } else if (op === "insert_before") {
        session.sendUno(".uno:GoToStartOfPara");
        session.sendUno(".uno:InsertText", text);
        session.sendUno(".uno:InsertPara");
      } else {
        // rewrite_section: select the whole anchor paragraph, replace it.
        session.sendUno(".uno:GoToStartOfPara");
        session.sendUno(".uno:EndOfParaSel");
        session.sendUno(".uno:InsertText", text);
      }
      return {};
    };
  }

  const artifactInternalId = resolution.artifact.id;
  const mintOpts: OfficeSessionMintOptions = {
    readableNamespaces: facts.readableNamespaces,
    writableNamespaces: facts.writableNamespaces,
    mutableNamespaces: facts.mutableNamespaces,
    ownerId: facts.userId,
    userId: facts.userId,
    agentId: facts.agentId,
  };

  const result = await runVerifiedInPlaceTransaction(
    physicalPath,
    inExt,
    { artifactInternalId, mintOpts, broker, makeSession, gate },
    sendOps,
    client,
  );

  if (result.status === "changed") {
    return JSON.stringify({
      changed: true,
      path: validated.path,
      summary,
      updatedDoc: result.updatedDoc,
      updatedDocTruncated: result.updatedDocTruncated,
      ...(result.updatedDocError ? { updatedDocError: result.updatedDocError } : {}),
    });
  }
  return fail(result.reason ?? "the document was not changed.");
}

/** Trim a phrase for inclusion in a human-readable reason string. */
function truncateForReason(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Workspace-zone dispatch — read + write-to-new-artifact (zero clobber)
// ---------------------------------------------------------------------------

async function dispatchWorkspaceOffice(
  args: OfficeArgs,
  ctx: OfficeToolContext,
  client: OfficeEngineClient,
  makeSession: (opts: CoolSessionOptions) => CoolSessionLike,
  gate: DurabilityGate,
): Promise<string> {
  if (!ctx.memoryAccessEnvelope) {
    return "Error: workspace zone requires room/namespace context (memoryAccessEnvelope missing).";
  }
  const factsResult = envelopeFactsForArtifacts(ctx.memoryAccessEnvelope);
  if (!factsResult.ok) return `Error: ${factsResult.reason}`;
  const facts = factsResult.facts;
  if (!facts.agentId) {
    return "Error: workspace artifact access requires an authenticated agent context.";
  }

  if (!args.path) return `Error: '${args.command}' requires 'path'.`;
  const inValidated = validateLogicalPath(args.path);
  if (!inValidated.ok) return `Error: ${inValidated.reason}`;

  const inResolution = await resolveWorkspaceArtifact({
    logicalPath: inValidated.path,
    facts,
    intent: "read",
  });
  if (!inResolution.ok) return `Error: ${inResolution.reason}`;
  if (!inResolution.artifact) {
    return `Error: No workspace artifact at "${inValidated.path}".`;
  }

  // `inPlace` branch: edit the resolved input artifact through a live
  // coolwsd session. coolwsd holds the WOPI lock and serializes edits;
  // save flows back via WOPI PutFile → the existing revision-bump + SSE
  // path. No new artifact is minted; `out` is NOT required. The session
  // is REUSED across tool calls by the session manager (idle-closed
  // after a window) — see `session-manager.ts`.
  if (args.inPlace === true) {
    const inExt = ext(inValidated.path);
    return await dispatchInPlaceOffice(
      args,
      {
        artifact: inResolution.artifact,
        logicalPath: inResolution.logicalPath,
        artifactId: inResolution.artifactId,
        physicalPath: inResolution.physicalPath,
        inExt,
      },
      facts,
      client,
      makeSession,
      gate,
    );
  }

  const inExt = ext(inValidated.path);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(inResolution.physicalPath);
  } catch (err) {
    return `Error: could not read workspace artifact ${inValidated.path}: ${err instanceof Error ? err.message : String(err)}`;
  }

  const isWrite = WRITE_COMMANDS.has(args.command);

  // For `compare`, resolve a second input artifact the same way (read).
  let bytes2: Uint8Array | null = null;
  if (args.command === "compare") {
    if (!args.path2) return `Error: compare requires 'path2'.`;
    const p2Validated = validateLogicalPath(args.path2);
    if (!p2Validated.ok) return `Error: path2: ${p2Validated.reason}`;
    const p2Resolution = await resolveWorkspaceArtifact({
      logicalPath: p2Validated.path,
      facts,
      intent: "read",
    });
    if (!p2Resolution.ok) return `Error: ${p2Resolution.reason}`;
    if (!p2Resolution.artifact) {
      return `Error: No workspace artifact at "${p2Validated.path}".`;
    }
    try {
      bytes2 = await readFile(p2Resolution.physicalPath);
    } catch (err) {
      return `Error: could not read workspace artifact ${p2Validated.path}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Produce output bytes via the engine. For read commands, return the
  // structured result directly without touching the artifact row.
  try {
    if (!isWrite) {
      switch (args.command) {
        case "extract":
          return JSON.stringify(await client.getStructured(bytes, inExt));
        case "meta_get":
          return JSON.stringify(await client.getMeta(bytes, inExt));
        default:
          return `Error: unknown read command '${args.command}'.`;
      }
    }
  } catch (err) {
    return `Error: office '${args.command}' failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Write commands — require `out`, mint a NEW artifact, never touch input.
  if (!args.out) return `Error: '${args.command}' requires 'out'.`;
  const outValidated = validateLogicalPath(args.out);
  if (!outValidated.ok) return `Error: out: ${outValidated.reason}`;

  let outBytes: Uint8Array;
  try {
    switch (args.command) {
      case "convert":
      case "render": {
        const to = args.to ?? ext(args.out);
        if (!to) return `Error: cannot infer target format; pass 'to'.`;
        outBytes = await client.convert(bytes, to);
        break;
      }
      case "compare": {
        if (!bytes2) return `Error: compare requires 'path2'.`;
        outBytes = await client.compare(bytes, bytes2, ext(args.out));
        break;
      }
      case "find_replace": {
        if (args.find === undefined || args.replace === undefined) return `Error: find_replace requires 'find' and 'replace'.`;
        outBytes = await client.findReplace(bytes, inExt, args.find, args.replace, args.regex ?? false);
        break;
      }
      case "template_fill": {
        if (!args.mapping) return `Error: template_fill requires 'mapping'.`;
        outBytes = await client.templateFill(bytes, inExt, args.mapping);
        break;
      }
      case "insert_text": {
        if (args.text === undefined) return `Error: insert_text requires 'text'.`;
        outBytes = await client.insertText(bytes, inExt, args.text, args.atEnd ?? true);
        break;
      }
      case "set_cell": {
        if (!args.cell || args.value === undefined) return `Error: set_cell requires 'cell' and 'value'.`;
        outBytes = await client.setCells(bytes, inExt, [{ sheet: args.sheet ?? 0, cell: args.cell, value: args.value }]);
        break;
      }
      case "set_range": {
        if (!args.range || !Array.isArray(args.rows) || args.rows.length === 0) return `Error: set_range requires 'range' and a non-empty 'rows' grid.`;
        outBytes = await client.setRange(bytes, inExt, args.sheet ?? 0, args.range, args.rows);
        break;
      }
      case "meta_set": {
        if (!args.meta) return `Error: meta_set requires 'meta'.`;
        outBytes = await client.setMeta(bytes, inExt, args.meta);
        break;
      }
      default:
        return `Error: unknown write command '${args.command}'.`;
    }
  } catch (err) {
    return `Error: office '${args.command}' failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Mint the new workspace artifact at `out`. `intent: "create"` refuses
  // if a row already exists at that logical path — zero clobber.
  if (facts.writableNamespaces.length === 0) {
    return (
      "Error: no writable namespace for new workspace artifacts. " +
      "Open a room with namespace write access before writing office outputs."
    );
  }
  const targetNamespaceId = facts.writableNamespaces[0]!;
  const outResolution = await resolveWorkspaceArtifact({
    logicalPath: outValidated.path,
    facts,
    intent: "create",
  });
  if (!outResolution.ok) return `Error: ${outResolution.reason}`;
  // `intent: "create"` always returns artifact === null on success.
  const outPhysical = outResolution.physicalPath;

  try {
    await mkdir(dirname(outPhysical), { recursive: true });
  } catch (err) {
    return `Error: could not prepare artifact storage dir: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    await writeFile(outPhysical, outBytes);
  } catch (err) {
    return `Error: writing workspace artifact ${outValidated.path} failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const mimeType = mimeFromExtensionOr(outResolution.logicalPath);
  const meta: WorkspaceArtifactPatchMeta = {
    mode: "create",
    artifactId: outResolution.artifactId,
    logicalPath: outResolution.logicalPath,
    namespaceId: targetNamespaceId,
    storageUri: outResolution.storageUri,
    mimeType,
  };
  let rowApplyResult: Awaited<ReturnType<typeof applyWorkspaceArtifactRowChange>> | undefined;
  try {
    rowApplyResult = await applyWorkspaceArtifactRowChange(
      meta,
      outBytes.byteLength,
      facts.userId,
      facts.agentId,
      { kind: "agent", agentId: facts.agentId },
    );
  } catch (err) {
    return `Error: indexing workspace artifact ${outValidated.path} failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return JSON.stringify({
    ok: true,
    command: args.command,
    zone: "workspace",
    out: outResolution.logicalPath,
    artifactId: outResolution.artifactId,
    ...(rowApplyResult && typeof rowApplyResult === "object" && "internalId" in rowApplyResult
      ? { artifactInternalId: rowApplyResult.internalId }
      : {}),
    bytes: outBytes.byteLength,
    inputArtifactId: inResolution.artifactId,
    inputPath: inResolution.logicalPath,
    mimeType,
  });
}

// ---------------------------------------------------------------------------
// In-place workspace edit through a live coolwsd session (Milestone B)
// ---------------------------------------------------------------------------

/** Commands that may be routed through the live coolwsd session. */
const INPLACE_COMMANDS = new Set<OfficeArgs["command"]>([
  "find_replace",
  "insert_text",
  "set_cell",
  "set_range",
  // D362 Wave C — Calc cell formatting (inPlace-only; live coolwsd session).
  // Selects the range via .uno:GoToCell, then fires each provided field's
  // grounded UNO verb (see `sendLowLevelOps`).
  "format_range",
  // D362 Wave J — agent-side Writer ops (inPlace-only; live coolwsd session).
  // Closes the agent-parity gap vs. the human Writer ribbon.
  //   - format_text: find+select an anchor via .uno:ExecuteSearch (FIND),
  //     then fire the provided Writer format verbs (.uno:Bold/Italic/
  //     Underline/Strikeout, .uno:FontColor, .uno:CharBackColor,
  //     .uno:StyleApply, .uno:CharFontName, .uno:FontHeight).
  //   - insert_link: .uno:SetHyperlink {Hyperlink.Text, Hyperlink.URL};
  //     optional anchor selects first.
  //   - insert_comment: .uno:InsertAnnotation FF (text-set DEFERRED — see
  //     sendLowLevelOps comment); optional anchor selects first.
  //   - track_changes: .uno:TrackChanges — IDEMPOTENT set via getCommandState
  //     read-then-toggle (see setToggleState); falls back to a blind toggle
  //     when state is unreadable.
  "format_text",
  "insert_link",
  "insert_comment",
  "track_changes",
  // D362 — Writer co-creative review loop (inPlace-only). Closes the
  // agent-parity gap vs. the human Writer Review group: the 8 FF verbs
  // (accept/reject + navigate + bulk) that let a Genie REVIEW tracked
  // changes. Grounded in office-writer-review-group.tsx + phase-3 §3.3.8.
  //   - accept / reject → .uno:AcceptTrackedChange / .uno:RejectTrackedChange
  //   - accept_next / reject_next → .uno:AcceptTrackedChangeToNext / .uno:RejectTrackedChangeToNext
  //   - accept_all / reject_all → .uno:AcceptAllTrackedChanges / .uno:RejectAllTrackedChanges
  //   - next / prev → .uno:NextTrackedChange / .uno:PreviousTrackedChange
  // Idempotent set-to-enabled for track_changes is still DEFERRED (see the
  // track_changes comment) — the review loop is the primary win regardless.
  "review_changes",
  // Wave C — agent-side Impress ops. All operate through the live
  // coolwsd session; none mint a new artifact (`out` is NOT required).
  "slide_insert",
  "slide_duplicate",
  "slide_delete",
  "slide_move",
  "slide_goto",
  "set_layout",
  "set_notes",
  "place_textbox",
  // Wave I — agent-side Impress shape + slide ops (audit §3 + §1.4-§1.7,
  // §1.10-§1.11). All inPlace-only; built on the `select_shape_at`
  // keystone (LOK `mouse` click at twips via the existing `sendMouse`).
  "select_shape_at",
  "format_shape",
  "arrange_shape",
  "slide_visibility",
  "insert_table",
  "insert_chart",
  "master_view",
  // Wave G — Calc sheet management + freeze panes (inPlace-only; live
  // coolwsd session). Closes the standout Calc agent-parity gap vs. the
  // human tab bar. Sheet verbs grounded in Parts.js (same path the human
  // tab bar fires); freeze grounded in sc/sdi + NotebookbarCalc.js.
  "sheet",
  "freeze_panes",
  // Calc Data-group parity: sort asc/desc + AutoFilter over a range (FF).
  "calc_data",
  // Wave G — Impress cheap-tail (inPlace-only; audit §2.1 G12-G20).
  // All FF; the save + durability gate is the sync point.
  "slide_field",
  "slide_outline",
  "master_display",
  "shape_autofit",
  "convert_shape",
  "group_nav",
  // Last cheap agent-parity tail (inPlace-only; audit §1.2 G16 + §1.4 G19
  // + build-sheet §1 borders). All FF except borders which sends a preset
  // arg build. See sendLowLevelOps for grounding.
  "presentation",
  // Wave K — agent image insert (inPlace-only; live coolwsd session).
  // GROUNDED in Map.FileInserter.js (the human Insert > Image button's
  // wire). Sequence: getchildid → multipart POST {name, childid, file} →
  // socket `insertfile name=… type=graphic`. NO new artifact; standard
  // save + durability gate. See sendLowLevelOps for the wire citations.
  "insert_image",
]);

/**
 * Twips per centimetre. LibreOffice internally stores document
 * coordinates in twips (1 inch = 1440 twips, 1 inch = 2.54 cm →
 * 1 cm = 1440/2.54 ≈ 566.93 twips). The `place_textbox` op accepts
 * centimetres from the agent and converts here before emitting the
 * LOK `mouse` event. Slide sizes for reference:
 *   - 4:3  → 14400 × 10800 twips (25.4 × 19.05 cm)
 *   - 16:9 → 19200 × 10800 twips (33.87 × 19.05 cm)
 */
const TWIPS_PER_CM = 1440 / 2.54;
/** LOK left-button mask for `mouse` events. */
const LOK_BUTTON_LEFT = 1;
/** LOK no-modifier mask for `mouse` events. */
const LOK_MODIFIER_NONE = 0;

/** Parse a cell ref ("A1", "$B$2") into 1-based {col,row}; null if malformed. */
function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  const letters = m?.[1];
  const digits = m?.[2];
  if (!letters || !digits) return null;
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number.parseInt(digits, 10);
  return col >= 1 && row >= 1 ? { col, row } : null;
}

/** 1-based column number → spreadsheet letters (1→A, 27→AA). */
function colToLetters(col: number): string {
  let s = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/** SearchItem.Command values (SvxSearchCmd): FIND selects the match; REPLACE_ALL replaces. */
const SVX_SEARCH_CMD_FIND = 0;
const SVX_SEARCH_CMD_REPLACE_ALL = 3;

/** Cap on the serialized post-edit extract returned to the model. */
const UPDATED_DOC_BUDGET = 4000;

/**
 * How long to wait for the saved bytes to change on disk after the save
 * is fired (§3.4.7 durability gate — the SOLE success signal, since we
 * do not trust coolwsd's save ack). coolwsd's WOPI PutFile lands within
 * a second or two of the `save` command; 20s is generous headroom
 * without hanging a tool call.
 */
const DURABILITY_GATE_TIMEOUT_MS = 20_000;
const DURABILITY_GATE_POLL_MS = 120;
/**
 * How often to RE-FORCE the WOPI storage upload while waiting for the
 * durable byte change. coolwsd defers the force=false upload after a plain
 * `save`; re-firing `savetostorage force=1` pushes it the moment Core's
 * save has written the new content.
 */
const DURABILITY_UPLOAD_NUDGE_MS = 1_500;

/**
 * A transient transport failure is one where the SESSION died before or
 * while establishing — nothing was mutated, so a fresh-session retry is
 * safe (idempotent). We deliberately do NOT auto-retry failures that
 * happen after mutations were sent (a re-send could double-apply a
 * non-idempotent op like append) — those are reported cleanly instead.
 */
function isTransientTransport(message: string): boolean {
  return (
    /socket closed before load|connect failed|connect timeout|not connected|socket not open|closing before load/i.test(
      message,
    )
  );
}

/** sha256 + size snapshot of a file, or null if unreadable/absent. */
async function fileSnapshot(
  physicalPath: string,
): Promise<{ size: number; hash: string } | null> {
  try {
    const bytes = await readFile(physicalPath);
    return {
      size: bytes.byteLength,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * Poll the physical file until its bytes differ from the pre-edit
 * snapshot, or the timeout elapses. Returns true iff a change was
 * observed. This is the DURABILITY GATE: coolwsd's WOPI PutFile writes
 * the bytes to this exact path on every save (the autosave debounce in
 * `wopi.ts` only defers the DB revision bump + SSE, never the byte
 * write), so a byte change here is proof the save persisted — immune to
 * the debounce and independent of coolwsd's WS ack ordering.
 */
async function waitForDurableChange(
  physicalPath: string,
  pre: { size: number; hash: string } | null,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cur = await fileSnapshot(physicalPath);
    if (cur && (!pre || cur.hash !== pre.hash)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, DURABILITY_GATE_POLL_MS));
  }
}

/**
 * Outcome of a verified in-place transaction. `status` is document-
 * language only — no WOPI/UNO/session/revision terms leak to the model.
 */
type VerifiedTxnStatus =
  | "changed" // bytes persisted + re-extracted
  | "no_match" // the op found nothing to act on (e.g. text to replace absent)
  | "not_confirmed" // save issued but no durable byte change before timeout
  | "transport_error"; // session could not be established (after one retry)

interface VerifiedTxnResult {
  status: VerifiedTxnStatus;
  updatedDoc: string | null;
  updatedDocTruncated: boolean;
  updatedDocError?: string;
  /** Human-readable, document-language reason for a non-`changed` status. */
  reason?: string;
}

/**
 * Injectable durability gate — the office tool's `deps` bag can override
 * this so hermetic tests exercise the retry/branch logic without a real
 * coolwsd. Defaults to the physical-file poll above.
 */
export type DurabilityGate = (
  physicalPath: string,
  pre: { size: number; hash: string } | null,
  timeoutMs: number,
) => Promise<boolean>;

/**
 * Run one VERIFIED in-place edit transaction against a live coolwsd
 * session (§3.4.7). The chain:
 *   1. snapshot the on-disk bytes (pre-image),
 *   2. acquire a reusable session (retry ONCE on a transient transport
 *      failure — see `isTransientTransport`; safe because nothing has
 *      been mutated yet),
 *   3. run `sendOps` (the caller's UNO verbs; may report `noMatch`),
 *   4. `save()`,
 *   5. GATE: wait for the bytes on disk to change (durable proof),
 *   6. re-extract the saved doc for `updatedDoc`.
 *
 * Returns a document-language `VerifiedTxnResult`. Never throws for an
 * expected failure — the caller maps `status` onto the tool result.
 */
async function runVerifiedInPlaceTransaction(
  physicalPath: string,
  inExt: string,
  wiring: {
    artifactInternalId: string;
    mintOpts: OfficeSessionMintOptions;
    broker: OfficeSessionBroker;
    makeSession: (opts: CoolSessionOptions) => CoolSessionLike;
    gate: DurabilityGate;
  },
  sendOps: (session: CoolSessionLike) => Promise<{ noMatch?: boolean; reason?: string }>,
  client: OfficeEngineClient,
): Promise<VerifiedTxnResult> {
  const pre = await fileSnapshot(physicalPath);
  const manager = getOfficeSessionManager();

  // ── acquire (retry once on transient transport failure) ──────────────
  // Acquire is pre-mutation, so a fresh-session retry is always safe (no
  // op has been applied yet). We only retry when the failure looks like a
  // transient transport death — a non-transient mint error (e.g. a
  // permission/wiring failure) is returned immediately.
  let session: CoolSessionLike | null = null;
  let lastAcquireErr = "";
  for (let attempt = 0; attempt < 2 && !session; attempt++) {
    const acquired = await manager.acquire(
      wiring.artifactInternalId,
      () => wiring.broker.mintSession(wiring.artifactInternalId, wiring.mintOpts),
      wiring.makeSession,
    );
    if ("isAlive" in acquired) {
      session = acquired;
      break;
    }
    lastAcquireErr = acquired.error;
    // Drop any half-open cached entry before a possible retry.
    manager.invalidate(wiring.artifactInternalId);
    if (!isTransientTransport(lastAcquireErr)) break;
  }
  if (!session) {
    // The raw cause (`lastAcquireErr`) carries transport/protocol detail
    // the model must never see, so it is used only for the retry decision
    // above and deliberately NOT surfaced in the reason.
    return {
      status: "transport_error",
      updatedDoc: null,
      updatedDocTruncated: false,
      reason: "the document could not be opened for editing right now; please try again.",
    };
  }

  // ── mutate ─────────────────────────────────────────────────────────
  try {
    const opResult = await sendOps(session);
    if (opResult.noMatch) {
      return {
        status: "no_match",
        updatedDoc: null,
        updatedDocTruncated: false,
        reason: opResult.reason ?? "nothing matched the requested edit",
      };
    }
  } catch (err) {
    // Post-mutation failure: invalidate the session so it is never
    // reused, and report cleanly. We do NOT auto-retry here — a re-send
    // could double-apply a non-idempotent op (e.g. append).
    manager.invalidate(wiring.artifactInternalId);
    const msg = err instanceof Error ? err.message : String(err);
    // A search-not-found reject is a logical no-match, not a transport
    // failure — surface it as such.
    if (/search string not found/i.test(msg)) {
      return {
        status: "no_match",
        updatedDoc: null,
        updatedDocTruncated: false,
        reason: "the text to change was not found in the document",
      };
    }
    return {
      status: "not_confirmed",
      updatedDoc: null,
      updatedDocTruncated: false,
      reason: "the edit could not be confirmed as saved; please try again",
    };
  }

  // ── save + FORCED storage upload + durability gate ───────────────────
  // CRITICAL: we do NOT await a save ACK. coolwsd does not reliably emit
  // `.uno:Save` / `ModifiedStatus=false`, so awaiting it times out even
  // when the write succeeded. Instead we treat the BYTES CHANGING ON DISK
  // as the sole source of truth.
  //
  // But a plain `save` only flushes the Kit to coolwsd's local temp; the
  // WOPI upload runs with force=false and coolwsd defers it under its
  // upload throttle / conflict handling — observed live lagging ~40s to
  // the idle autosave, which blew past the gate and reported landed edits
  // as failures. So we ALSO force the storage upload (`savetostorage
  // force=1`) and RE-FIRE it while polling: it uploads the last saved temp,
  // so it only changes the on-disk bytes once Core's save has written the
  // new content — which is exactly when the gate should trip.
  session.requestSave();
  session.saveToStorage();
  const uploadNudge = setInterval(() => {
    try {
      session.saveToStorage();
    } catch {
      // session may have been torn down; the gate will time out cleanly.
    }
  }, DURABILITY_UPLOAD_NUDGE_MS);
  let durable: boolean;
  try {
    durable = await wiring.gate(physicalPath, pre, DURABILITY_GATE_TIMEOUT_MS);
  } finally {
    clearInterval(uploadNudge);
  }
  if (!durable) {
    // Nothing landed within the window — the session may be wedged, so
    // drop it (next call re-mints a fresh one).
    manager.invalidate(wiring.artifactInternalId);
    return {
      status: "not_confirmed",
      updatedDoc: null,
      updatedDocTruncated: false,
      reason: "the edit did not persist to the document; please try again",
    };
  }

  // ── re-extract the SAVED bytes (the proof the model inspects) ─────────
  let updatedDoc: string | null = null;
  let updatedDocTruncated = false;
  let updatedDocError: string | undefined;
  try {
    const savedBytes = await readFile(physicalPath);
    const serialized = JSON.stringify(await client.getStructured(savedBytes, inExt));
    if (serialized.length > UPDATED_DOC_BUDGET) {
      updatedDoc = serialized.slice(0, UPDATED_DOC_BUDGET);
      updatedDocTruncated = true;
    } else {
      updatedDoc = serialized;
    }
  } catch (err) {
    updatedDocError = err instanceof Error ? err.message : String(err);
  }

  return {
    status: "changed",
    updatedDoc,
    updatedDocTruncated,
    ...(updatedDocError ? { updatedDocError } : {}),
  };
}

/**
 * Edit a workspace doc in place via a live Collabora session. The flow:
 *   1. mint a WOPI session for the resolved input artifact (internal id),
 *      ACQUIRE a reusable `CoolSessionLike` from the session manager
 *      (cache hit + `isAlive()` → reuse; else mint+connect+cache),
 *   2. send the UNO command(s) for the op,
 *   3. `save()` (coolwsd → WOPI PutFile → revision bump + SSE),
 *   4. re-extract the doc via the headless path and include as
 *      `updatedDoc` in the result.
 *
 * The session is NOT closed here — the manager owns its lifecycle
 * (idle-close after a window; LRU eviction at cap). On ANY error from
 * uno/save, the manager invalidates (close+evict) the session before
 * returning the error string, so a half-broken session is never cached.
 *
 * `out` is NOT required — the input artifact is the one being edited.
 * No new artifact row is minted, so `applyWorkspaceArtifactRowChange`
 * is never called.
 */
async function dispatchInPlaceOffice(
  args: OfficeArgs,
  input: {
    artifact: { id: string } & Record<string, unknown>;
    logicalPath: string;
    artifactId: string;
    physicalPath: string;
    inExt: string;
  },
  facts: EnvelopeFacts,
  client: OfficeEngineClient,
  makeSession: (opts: CoolSessionOptions) => CoolSessionLike,
  gate: DurabilityGate,
): Promise<string> {
  if (!INPLACE_COMMANDS.has(args.command)) {
    return `Error: inPlace is only supported for find_replace | insert_text | set_cell | set_range | format_range | format_text | insert_link | insert_comment | track_changes | review_changes | slide_insert | slide_duplicate | slide_delete | slide_move | slide_goto | set_layout | set_notes | place_textbox | select_shape_at | format_shape | arrange_shape | slide_visibility | insert_table | insert_chart | master_view | sheet | freeze_panes | slide_field | slide_outline | master_display | shape_autofit | convert_shape | group_nav | presentation | insert_image (got '${args.command}').`;
  }

  const broker = getOfficeSessionBroker();
  if (!broker) {
    return "Error: inPlace office editing is not wired (server boot did not install the office-session broker).";
  }

  // Per-command arg validation up-front so we surface a clear error before
  // touching the engine.
  if (args.command === "find_replace") {
    if (args.find === undefined || args.replace === undefined) {
      return `Error: find_replace requires 'find' and 'replace'.`;
    }
  } else if (args.command === "insert_text") {
    if (args.text === undefined) return `Error: insert_text requires 'text'.`;
  } else if (args.command === "set_cell") {
    if (!args.cell || args.value === undefined) {
      return `Error: set_cell requires 'cell' and 'value'.`;
    }
  } else if (args.command === "set_range") {
    if (!args.range || !Array.isArray(args.rows) || args.rows.length === 0) {
      return `Error: set_range requires 'range' (e.g. "A1") and a non-empty 'rows' grid.`;
    }
    if (parseCellRef((args.range.split(":")[0] ?? "").trim()) === null) {
      return `Error: set_range 'range' must start with a cell like "A1" (got '${args.range}').`;
    }
  } else if (args.command === "format_range") {
    // `range` is required; every other field is optional. Validate the
    // hex colors + range shape up-front so we surface a clear error before
    // touching the engine. At least ONE format field must be provided
    // (a no-op format_range is almost certainly a caller bug).
    if (!args.range) {
      return `Error: format_range requires 'range' (e.g. "A1" or "A1:C3").`;
    }
    if (parseCellRef((args.range.split(":")[0] ?? "").trim()) === null) {
      return `Error: format_range 'range' must start with a cell like "A1" (got '${args.range}').`;
    }
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    if (args.fontColor !== undefined && !hexRe.test(args.fontColor)) {
      return `Error: format_range 'fontColor' must be "#rrggbb" (got '${args.fontColor}').`;
    }
    if (args.bgColor !== undefined && !hexRe.test(args.bgColor)) {
      return `Error: format_range 'bgColor' must be "#rrggbb" (got '${args.bgColor}').`;
    }
    if (args.align !== undefined && args.align !== "left" && args.align !== "center" && args.align !== "right") {
      // `align` enum also includes top/middle/bottom for arrange_shape;
      // format_range is CELL alignment only.
      return `Error: format_range 'align' must be "left" | "center" | "right" (got '${args.align}').`;
    }
    const anyFormat =
      args.bold !== undefined ||
      args.italic !== undefined ||
      args.underline !== undefined ||
      args.numberFormat !== undefined ||
      args.merge !== undefined ||
      args.wrap !== undefined ||
      args.fontColor !== undefined ||
      args.bgColor !== undefined ||
      args.align !== undefined ||
      args.borders !== undefined;
    if (!anyFormat) {
      return `Error: format_range requires at least one format field (bold/italic/underline/numberFormat/merge/wrap/fontColor/bgColor/align/borders).`;
    }
  } else if (args.command === "slide_insert") {
    if (args.at !== undefined && (typeof args.at !== "number" || !Number.isInteger(args.at) || args.at < 0)) {
      return `Error: slide_insert 'at' must be a non-negative integer 0-based slide position (got ${JSON.stringify(args.at)}).`;
    }
  } else if (args.command === "slide_move") {
    if (args.dir !== "up" && args.dir !== "down" && args.dir !== "first" && args.dir !== "last") {
      return `Error: slide_move requires 'dir' of "up" | "down" | "first" | "last" (got ${JSON.stringify(args.dir)}).`;
    }
  } else if (args.command === "slide_goto") {
    if (args.index === undefined || !Number.isInteger(args.index) || args.index < 0) {
      return `Error: slide_goto requires 'index' (non-negative integer 0-based slide index, got ${JSON.stringify(args.index)}).`;
    }
  } else if (args.command === "set_layout") {
    if (args.slide === undefined || !Number.isInteger(args.slide) || args.slide < 0) {
      return `Error: set_layout requires 'slide' (non-negative integer 0-based slide index, got ${JSON.stringify(args.slide)}).`;
    }
    if (args.layoutId === undefined || !Number.isInteger(args.layoutId) || args.layoutId < 0) {
      return `Error: set_layout requires 'layoutId' (non-negative integer AutoLayout enum, got ${JSON.stringify(args.layoutId)}).`;
    }
  } else if (args.command === "set_notes") {
    if (args.slide === undefined || !Number.isInteger(args.slide) || args.slide < 0) {
      return `Error: set_notes requires 'slide' (non-negative integer 0-based slide index, got ${JSON.stringify(args.slide)}).`;
    }
    if (args.text === undefined) {
      return `Error: set_notes requires 'text' (the notes text to set).`;
    }
  } else if (args.command === "place_textbox") {
    for (const name of ["x", "y", "w", "h"] as const) {
      const v = args[name];
      if (v === undefined || !Number.isFinite(v)) {
        return `Error: place_textbox requires '${name}' (centimetres, got ${JSON.stringify(v)}).`;
      }
    }
    const target = resolvePlaceTextboxSlideTarget(args);
    if (!target.ok) return target.error;
    if (args.text === undefined) {
      return `Error: place_textbox requires 'text' (the text box contents).`;
    }
  } else if (args.command === "select_shape_at") {
    // Keystone (audit §3.3 route 1): a LOK `mouse` click at the twips
    // coord selects the shape under it. `at` must be {x, y} in cm.
    if (
      args.at === undefined ||
      typeof args.at !== "object" ||
      typeof args.at.x !== "number" ||
      typeof args.at.y !== "number" ||
      !Number.isFinite(args.at.x) ||
      !Number.isFinite(args.at.y)
    ) {
      return `Error: select_shape_at requires 'at' as {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
    }
  } else if (args.command === "format_shape") {
    // Optional `at` selects the shape first; at least one format field
    // is required (a no-op format_shape is a caller bug).
    if (args.at !== undefined) {
      if (
        typeof args.at !== "object" ||
        typeof args.at.x !== "number" ||
        typeof args.at.y !== "number" ||
        !Number.isFinite(args.at.x) ||
        !Number.isFinite(args.at.y)
      ) {
        return `Error: format_shape 'at' must be {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
      }
    }
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    if (args.fillColor !== undefined && !hexRe.test(args.fillColor)) {
      return `Error: format_shape 'fillColor' must be "#rrggbb" (got '${args.fillColor}').`;
    }
    if (args.lineColor !== undefined && !hexRe.test(args.lineColor)) {
      return `Error: format_shape 'lineColor' must be "#rrggbb" (got '${args.lineColor}').`;
    }
    for (const name of ["x", "y", "w", "h"] as const) {
      const v = args[name];
      if (v !== undefined && !Number.isFinite(v)) {
        return `Error: format_shape '${name}' must be a finite number of centimetres (got ${JSON.stringify(v)}).`;
      }
    }
    if (args.rotation !== undefined && !Number.isFinite(args.rotation)) {
      return `Error: format_shape 'rotation' must be a finite number of degrees (got ${JSON.stringify(args.rotation)}).`;
    }
    const anyFormat =
      args.fillColor !== undefined ||
      args.lineColor !== undefined ||
      args.x !== undefined ||
      args.y !== undefined ||
      args.w !== undefined ||
      args.h !== undefined ||
      args.rotation !== undefined ||
      args.flipH !== undefined ||
      args.flipV !== undefined ||
      args.originalSize !== undefined;
    if (!anyFormat) {
      return `Error: format_shape requires at least one format field (fillColor/lineColor/x/y/w/h/rotation/flipH/flipV/originalSize).`;
    }
  } else if (args.command === "arrange_shape") {
    if (args.at !== undefined) {
      if (
        typeof args.at !== "object" ||
        typeof args.at.x !== "number" ||
        typeof args.at.y !== "number" ||
        !Number.isFinite(args.at.x) ||
        !Number.isFinite(args.at.y)
      ) {
        return `Error: arrange_shape 'at' must be {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
      }
    }
    const anyArrange =
      args.zorder !== undefined ||
      args.align !== undefined ||
      args.group !== undefined ||
      args.ungroup !== undefined;
    if (!anyArrange) {
      return `Error: arrange_shape requires at least one of zorder / align / group / ungroup.`;
    }
  } else if (args.command === "slide_visibility") {
    if (args.hidden !== true && args.hidden !== false) {
      return `Error: slide_visibility requires 'hidden' (boolean — true to hide, false to show).`;
    }
    if (args.slide !== undefined && (!Number.isInteger(args.slide) || args.slide < 0)) {
      return `Error: slide_visibility 'slide' must be a non-negative integer 0-based slide index (got ${JSON.stringify(args.slide)}).`;
    }
  } else if (args.command === "insert_table") {
    if (typeof args.rows !== "number" || !Number.isInteger(args.rows) || args.rows < 1) {
      return `Error: insert_table requires 'rows' (positive integer row count, got ${JSON.stringify(args.rows)}).`;
    }
    if (args.cols === undefined || !Number.isInteger(args.cols) || args.cols < 1) {
      return `Error: insert_table requires 'cols' (positive integer column count, got ${JSON.stringify(args.cols)}).`;
    }
  } else if (args.command === "insert_chart") {
    // FF `.uno:InsertObjectChart` — no args. Chart CONFIG (type/series/titles)
    // is DIALOG-gated (audit H7) and out of scope.
  } else if (args.command === "master_view") {
    if (args.enter !== true && args.enter !== false) {
      return `Error: master_view requires 'enter' (boolean — true to enter Master View, false to close it).`;
    }
  } else if (args.command === "sheet") {
    // Wave G — Calc sheet management. Validate action + required fields
    // per action. `index` is 0-based sheet position; the UNO args use
    // 1-based Index (we add 1 in sendLowLevelOps). add/rename/delete
    // require `index`; rename also requires `name`. switch requires
    // `index` (switched via setclientpart part=<index>, 0-based).
    if (args.action !== "add" && args.action !== "rename" && args.action !== "delete" && args.action !== "switch") {
      return `Error: sheet requires 'action' of "add" | "rename" | "delete" | "switch" (got ${JSON.stringify(args.action)}).`;
    }
    if (args.index === undefined || !Number.isInteger(args.index) || args.index < 0) {
      return `Error: sheet requires 'index' (non-negative integer 0-based sheet position, got ${JSON.stringify(args.index)}).`;
    }
    if (args.action === "rename") {
      // Empty rename is a caller bug — Core would set the sheet name to "".
      if (args.name === undefined || args.name.length === 0) {
        return `Error: sheet rename requires 'name' (the new sheet name).`;
      }
    }
  } else if (args.command === "freeze_panes") {
    // FF toggle — same caveat as track_changes / format_range bold. We
    // require `enabled` (bool intent) so a no-op call is rejected, then
    // fire the FF toggle regardless (no state-read). See sendLowLevelOps
    // comment for the toggle-vs-set caveat.
    if (args.enabled !== true && args.enabled !== false) {
      return `Error: freeze_panes requires 'enabled' (boolean — true to freeze, false to unfreeze). NOTE: .uno:FreezePanes is a TOGGLE — see code caveat.`;
    }
  } else if (args.command === "calc_data") {
    if (args.action !== "sort_asc" && args.action !== "sort_desc" && args.action !== "autofilter") {
      return `Error: calc_data requires 'action' of "sort_asc" | "sort_desc" | "autofilter".`;
    }
    if (!args.range || parseCellRef((args.range.split(":")[0] ?? "").trim()) === null) {
      return `Error: calc_data requires 'range' (the cells to sort / filter, e.g. "A1:C20").`;
    }
  } else if (args.command === "slide_field") {
    // GROUNDED audit §1.12 G12 — structured field kinds are FF inserts at
    // the cursor in a text box; free-text uses the active-edit textinput
    // path. The agent must already be in text-edit mode on a shape (use
    // place_textbox / select_shape_at + double-click first); slide_field
    // does NOT enter text-edit mode itself.
    if (
      args.kind !== "pagenumber" && args.kind !== "pagecount" &&
      args.kind !== "pagetitle" && args.kind !== "date" &&
      args.kind !== "time" && args.kind !== "author" &&
      args.kind !== "text"
    ) {
      return `Error: slide_field requires 'kind' of "pagenumber" | "pagecount" | "pagetitle" | "date" | "time" | "author" | "text" (got ${JSON.stringify(args.kind)}).`;
    }
    if (args.kind === "text" && args.text === undefined) {
      return `Error: slide_field kind='text' requires 'text' (the literal text to insert).`;
    }
    // Bug 2 fix: slide_field accepts the same target-slide aliases as
    // place_textbox (`targetSlide` / `slide` / `index`). The dispatcher
    // creates a fresh text box on the target slide before firing the field
    // UNO — without an active text-edit context the field UNO silently
    // no-ops (live-verify 2026-07-06: `ok:true`, no field in extract).
    const fieldTarget = resolvePlaceTextboxSlideTarget(args);
    if (!fieldTarget.ok) return fieldTarget.error;
  } else if (args.command === "slide_outline") {
    // GROUNDED audit §1.1 G13 — expand/summary, FF on the current slide.
    if (args.action !== "expand" && args.action !== "summary") {
      return `Error: slide_outline requires 'action' of "expand" | "summary" (got ${JSON.stringify(args.action)}).`;
    }
  } else if (args.command === "master_display") {
    // GROUNDED audit §1.3 G15 — per-slide toggles. At least one of
    // displayBackground / displayObjects must be provided (a no-op
    // master_display is a caller bug). Both are FF toggles — same caveat
    // as format_range bold (we fire only when caller asks for true; omit
    // on false/undefined so we don't toggle a state we didn't read).
    if (args.displayBackground === undefined && args.displayObjects === undefined) {
      return `Error: master_display requires at least one of 'displayBackground' or 'displayObjects' (boolean).`;
    }
  } else if (args.command === "shape_autofit") {
    // GROUNDED audit §1.13 G17 — autofit toggle on the selected text box.
    // Optional `at` selects the shape first (same pattern as format_shape).
    if (args.at !== undefined) {
      if (
        typeof args.at !== "object" ||
        typeof args.at.x !== "number" ||
        typeof args.at.y !== "number" ||
        !Number.isFinite(args.at.x) ||
        !Number.isFinite(args.at.y)
      ) {
        return `Error: shape_autofit 'at' must be {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
      }
    }
    if (args.autofit !== true && args.autofit !== false) {
      return `Error: shape_autofit requires 'autofit' (boolean — true to enable auto-fit, false to disable). NOTE: .uno:TextAutoFitToSize is a TOGGLE — see code caveat.`;
    }
  } else if (args.command === "convert_shape") {
    // GROUNDED audit §1.4 G18 — convert selected shape to bitmap /
    // metafile / bezier curves. Optional `at` selects the shape first.
    if (args.at !== undefined) {
      if (
        typeof args.at !== "object" ||
        typeof args.at.x !== "number" ||
        typeof args.at.y !== "number" ||
        !Number.isFinite(args.at.x) ||
        !Number.isFinite(args.at.y)
      ) {
        return `Error: convert_shape 'at' must be {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
      }
    }
    if (args.kind !== "bitmap" && args.kind !== "metafile" && args.kind !== "bezier") {
      return `Error: convert_shape requires 'kind' of "bitmap" | "metafile" | "bezier" (got ${JSON.stringify(args.kind)}).`;
    }
  } else if (args.command === "group_nav") {
    // GROUNDED audit §1.6 G20 — enter/leave group, FF on the current
    // selection. Optional `at` selects the shape first.
    if (args.at !== undefined) {
      if (
        typeof args.at !== "object" ||
        typeof args.at.x !== "number" ||
        typeof args.at.y !== "number" ||
        !Number.isFinite(args.at.x) ||
        !Number.isFinite(args.at.y)
      ) {
        return `Error: group_nav 'at' must be {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
      }
    }
    if (args.action !== "enter" && args.action !== "leave") {
      return `Error: group_nav requires 'action' of "enter" | "leave" (got ${JSON.stringify(args.action)}).`;
    }
  } else if (args.command === "presentation") {
    // GROUNDED audit §1.2 G16 — two FF presenter verbs. `mode` discriminates:
    //   current  → .uno:PresentationCurrentSlide (start slideshow from current slide)
    //   rehearse → .uno:RehearseTimings          (enter presenter console with timer)
    // Both FF, no args. LIVE-VERIFY: embed/fullscreen behavior is unverified
    // (same caveat as `.uno:Presentation` build-sheet §4.6) — flagged in code.
    if (args.mode !== "current" && args.mode !== "rehearse") {
      return `Error: presentation requires 'mode' of "current" | "rehearse" (got ${JSON.stringify(args.mode)}).`;
    }
  } else if (args.command === "insert_image") {
    // Wave K — agent image insert. `imagePath` is required (the image
    // artifact); the doc being edited is `path` (the inPlace target,
    // already resolved by dispatchWorkspaceOffice). Validate the logical
    // path shape up-front so we surface a clear error before touching the
    // engine; the bytes are loaded after the validation block.
    if (!args.imagePath || args.imagePath.length === 0) {
      return `Error: insert_image requires 'imagePath' (the workspace image artifact to insert, e.g. "assets/logo.png").`;
    }
    // Bug 1 fix: insert_image MUST set the target slide as the active part
    // before the insertfile socket trigger, mirroring place_textbox. Without
    // it, the image lands at the kit's current cursor / active-part context
    // — which under headless is whichever slide was last visited (typically
    // slide 0), NOT the slide the agent intended. The agent's `extract`
    // readback then sees no new shape on the target slide and the op reads
    // as a silent no-op (`ok:true`, no shape). Reuse the place_textbox
    // alias resolver so `targetSlide` / `slide` / `index` all work and
    // conflict-detect identically. Re-resolved in the dispatch block (the
    // resolver is a pure function of `args`).
    const imageTarget = resolvePlaceTextboxSlideTarget(args);
    if (!imageTarget.ok) return imageTarget.error;
    // Validate the semantic placement API. `at` accepts a named anchor
    // string OR an explicit {x, y} cm point (a bare number is rejected —
    // it's only for slide_insert). `size` accepts "fit" | a fraction
    // number | an explicit {w?, h?} cm object.
    if (args.at !== undefined) {
      if (typeof args.at === "string") {
        const anchors = [
          "center", "top-left", "top", "top-right",
          "left", "right", "bottom-left", "bottom", "bottom-right",
        ];
        if (!anchors.includes(args.at)) {
          return `Error: insert_image 'at' must be a named anchor (${anchors.join(" | ")}) or {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
        }
      } else if (typeof args.at === "object" && args.at !== null) {
        if (
          !Number.isFinite(args.at.x) || !Number.isFinite(args.at.y)
        ) {
          return `Error: insert_image 'at' must be {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
        }
      } else {
        return `Error: insert_image 'at' must be a named anchor string or {x, y} in centimetres (got ${JSON.stringify(args.at)}).`;
      }
    }
    if (args.size !== undefined) {
      if (typeof args.size === "string") {
        if (args.size !== "fit") {
          return `Error: insert_image 'size' must be "fit" | a fraction (number) | {w, h} in centimetres (got ${JSON.stringify(args.size)}).`;
        }
      } else if (typeof args.size === "number") {
        if (!Number.isFinite(args.size) || args.size <= 0) {
          return `Error: insert_image 'size' fraction must be a positive finite number (got ${JSON.stringify(args.size)}).`;
        }
      } else if (typeof args.size === "object" && args.size !== null) {
        if (args.size.w !== undefined && (!Number.isFinite(args.size.w) || args.size.w <= 0)) {
          return `Error: insert_image 'size.w' must be a positive finite number of centimetres (got ${JSON.stringify(args.size.w)}).`;
        }
        if (args.size.h !== undefined && (!Number.isFinite(args.size.h) || args.size.h <= 0)) {
          return `Error: insert_image 'size.h' must be a positive finite number of centimetres (got ${JSON.stringify(args.size.h)}).`;
        }
        if (args.size.w === undefined && args.size.h === undefined) {
          return `Error: insert_image 'size' object needs at least one of w/h (got ${JSON.stringify(args.size)}).`;
        }
      } else {
        return `Error: insert_image 'size' must be "fit" | a fraction (number) | {w, h} in centimetres (got ${JSON.stringify(args.size)}).`;
      }
    }
  } else if (args.command === "format_text") {
    // `anchor` is required (the phrase to find+select via .uno:ExecuteSearch);
    // every other field is optional. Validate hex colors up-front so we
    // surface a clear error before touching the engine. At least ONE format
    // field must be provided (a no-op format_text is a caller bug).
    if (!args.anchor || args.anchor.length === 0) {
      return `Error: format_text requires 'anchor' (the exact existing phrase to find+select via .uno:ExecuteSearch).`;
    }
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    if (args.fontColor !== undefined && !hexRe.test(args.fontColor)) {
      return `Error: format_text 'fontColor' must be "#rrggbb" (got '${args.fontColor}').`;
    }
    if (args.highlightColor !== undefined && !hexRe.test(args.highlightColor)) {
      return `Error: format_text 'highlightColor' must be "#rrggbb" (got '${args.highlightColor}').`;
    }
    if (args.fontSize !== undefined && (!Number.isFinite(args.fontSize) || args.fontSize <= 0)) {
      return `Error: format_text 'fontSize' must be a positive finite number of points (got ${JSON.stringify(args.fontSize)}).`;
    }
    const anyFormat =
      args.bold !== undefined ||
      args.italic !== undefined ||
      args.underline !== undefined ||
      args.strike !== undefined ||
      args.fontColor !== undefined ||
      args.highlightColor !== undefined ||
      args.style !== undefined ||
      args.fontFamily !== undefined ||
      args.fontSize !== undefined;
    if (!anyFormat) {
      return `Error: format_text requires at least one format field (bold/italic/underline/strike/fontColor/highlightColor/style/fontFamily/fontSize).`;
    }
  } else if (args.command === "insert_link") {
    if (args.text === undefined || args.text.length === 0) {
      return `Error: insert_link requires 'text' (the link display text).`;
    }
    if (args.url === undefined || args.url.length === 0) {
      return `Error: insert_link requires 'url' (the hyperlink URL).`;
    }
  } else if (args.command === "insert_comment") {
    if (args.text === undefined) {
      return `Error: insert_comment requires 'text' (the comment contents).`;
    }
  } else if (args.command === "track_changes") {
    if (args.enabled !== true && args.enabled !== false) {
      return `Error: track_changes requires 'enabled' (boolean — true to enable, false to disable). NOTE: .uno:TrackChanges is a TOGGLE — see code caveat.`;
    }
  } else if (args.command === "review_changes") {
    // D362 — Writer co-creative review loop. GROUNDED in the human Writer
    // Review group (office-writer-review-group.tsx): the 8 FF verbs that let
    // a Genie ACCEPT/REJECT tracked changes (parity with the human Review
    // ribbon). `action` discriminates the verb; all are FF, no args.
    //   accept / reject / accept_next / reject_next / accept_all / reject_all / next / prev
    if (
      args.action !== "accept" && args.action !== "reject" &&
      args.action !== "accept_next" && args.action !== "reject_next" &&
      args.action !== "accept_all" && args.action !== "reject_all" &&
      args.action !== "next" && args.action !== "prev"
    ) {
      return `Error: review_changes requires 'action' of "accept" | "reject" | "accept_next" | "reject_next" | "accept_all" | "reject_all" | "next" | "prev" (got ${JSON.stringify(args.action)}).`;
    }
  }

  // WOPI token mint requires the artifact's INTERNAL row id (the `id`
  // column, NOT the external `artifactId`). The workbench surface uses
  // the same convention when calling /api/office/wopi-token.
  const artifactInternalId = input.artifact.id;
  const mintOpts: OfficeSessionMintOptions = {
    readableNamespaces: facts.readableNamespaces,
    writableNamespaces: facts.writableNamespaces,
    mutableNamespaces: facts.mutableNamespaces,
    ownerId: facts.userId,
    userId: facts.userId,
    agentId: facts.agentId,
  };

  // Wave K — `insert_image` needs the image artifact's bytes loaded
  // BEFORE the transaction (so a missing/unreadable image fails fast
  // without minting a session). Resolve `imagePath` via the same
  // `resolveWorkspaceArtifact` path `compare` uses for `path2`, then read
  // the bytes + remember the filename for the multipart POST. The bytes
  // ride the closure into `sendLowLevelOps`.
  let imageBytes: Uint8Array | null = null;
  let imageFilename: string | null = null;
  // The DETERMINISTIC placement the dispatch computes BEFORE the
  // transaction — parsed native pixels + real slide size + intent → a
  // clamped on-slide rect. Computed here (not in `sendLowLevelOps`) so
  // the dispatch can include the placed rect in the result JSON without
  // threading it back through `runVerifiedInPlaceTransaction`. Null for
  // every non-`insert_image` op.
  let imagePlacement: ImagePlacement | null = null;
  if (args.command === "insert_image") {
    const imgValidated = validateLogicalPath(args.imagePath ?? "");
    if (!imgValidated.ok) return `Error: imagePath: ${imgValidated.reason}`;
    const imgResolution = await resolveWorkspaceArtifact({
      logicalPath: imgValidated.path,
      facts,
      intent: "read",
    });
    if (!imgResolution.ok) return `Error: ${imgResolution.reason}`;
    if (!imgResolution.artifact) {
      return `Error: No workspace artifact at "${imgValidated.path}".`;
    }
    try {
      const buf = await readFile(imgResolution.physicalPath);
      imageBytes = new Uint8Array(buf);
    } catch (err) {
      return `Error: could not read workspace image artifact ${imgValidated.path}: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Use the basename of the resolved logical path as the multipart
    // filename — coolwsd writes the upload to its jail under the `name`
    // handle, then routes the file part's filename into the engine.
    imageFilename = imgResolution.logicalPath.split("/").pop() ?? imgResolution.logicalPath;
    // Compute the placement rect DETERMINISTICALLY — no live echo needed.
    //   1. Parse the image's native pixel size from its header bytes
    //      (PNG IHDR / JPEG SOF — `readImagePixelSize` in
    //      `@nautilo/loffice`). Returns null for unknown formats; the
    //      compute falls back to the slide aspect.
    //   2. Fetch the REAL slide size via the engine (`getStructured` →
    //      `doctype: "slides"` + `slideSize {widthCm, heightCm}`). Falls
    //      back to the hardcoded 25.4×19.05 default + a
    //      `slideSizeSource: "fallback"` flag if the read fails (so the
    //      agent knows the slide dims may be wrong).
    //   3. Pure compute: `computeImagePlacementRect` — aspect-correct,
    //      clamped to the slide, anchor-respecting. This is the value
    //      `sendLowLevelOps` applies via `.uno:TransformDialog` AND the
    //      value the result returns as `placedRect`.
    const nativePixels = readImagePixelSize(imageBytes);
    let slideSizeCm: { w: number; h: number };
    let slideSizeSource: "engine" | "fallback";
    // Bug 2 fix: hoist the engine-reported slide COUNT out of the try
    // block so the bounds-check below can use it. `getStructured` for
    // Impress decks emits `slides: [...]` (infra/nwuno/server.py:354-393);
    // `slides.length` is the authoritative slide count, reuse it for the
    // target-slide bounds check (no extra round-trip — the dispatch
    // already fetches `getStructured` for the slide size). `null` =
    // engine didn't report a count (fallback path or non-array `slides`)
    // — the bounds check is SKIPPED in that case (don't block a
    // legitimate insert on a malformed readback).
    let slideCount: number | null = null;
    try {
      const docBytes = await readFile(input.physicalPath);
      const structured = await client.getStructured(docBytes, input.inExt);
      // `getStructured` returns `Record<string, unknown>`; for Impress decks
      // the engine emits `{ doctype: "slides", slideSize: {widthCm, heightCm}, slides: [...] }`
      // (infra/nwuno/server.py:354-393). Narrow defensively — any non-
      // numeric / non-positive value falls through to the hardcoded
      // fallback + a `slideSizeSource: "fallback"` flag.
      const ss = structured["slideSize"] as
        | { widthCm?: unknown; heightCm?: unknown }
        | undefined;
      const sw = ss?.widthCm;
      const sh = ss?.heightCm;
      if (typeof sw === "number" && typeof sh === "number" && Number.isFinite(sw) && Number.isFinite(sh) && sw > 0 && sh > 0) {
        slideSizeCm = { w: sw, h: sh };
        slideSizeSource = "engine";
      } else {
        slideSizeCm = { w: DEFAULT_SLIDE_W_CM, h: DEFAULT_SLIDE_H_CM };
        slideSizeSource = "fallback";
      }
      const slidesArr = structured["slides"];
      if (Array.isArray(slidesArr)) slideCount = slidesArr.length;
    } catch {
      slideSizeCm = { w: DEFAULT_SLIDE_W_CM, h: DEFAULT_SLIDE_H_CM };
      slideSizeSource = "fallback";
    }
    // Bug 2 fix: bounds-check the resolved target slide against the
    // engine-reported slide COUNT. The shared `setClientPart` helper
    // clamps silently to the last part, so without this gate an
    // out-of-range `targetSlide` (e.g. 5/6 on a 5-slide deck, indices
    // 0-4) silently lands on the last slide instead of erroring. The
    // check fires BEFORE the session is minted, so an out-of-range
    // target never touches the engine. Only enforced when the engine
    // reported a real count (`slideCount !== null`).
    const imgTargetPre = resolvePlaceTextboxSlideTarget(args);
    if (!imgTargetPre.ok) return imgTargetPre.error;
    if (imgTargetPre.slide !== undefined && slideCount !== null && imgTargetPre.slide >= slideCount) {
      return `Error: insert_image 'targetSlide' ${imgTargetPre.slide} is out of range; deck has ${slideCount} slide${slideCount === 1 ? "" : "s"} (0-based, indices 0..${slideCount - 1}).`;
    }
    // The validator already rejected `at: number` and malformed `size`
    // for insert_image, so narrow to the compute function's input shape.
    const atArg = (typeof args.at === "string" || (typeof args.at === "object" && args.at !== null))
      ? (args.at as string | { x: number; y: number })
      : undefined;
    imagePlacement = computeImagePlacementRect(
      nativePixels,
      slideSizeCm,
      { at: atArg, size: args.size, w: args.w, h: args.h },
      slideSizeSource,
    );
    // SIZING-VIA-BYTES: coolwsd inserts a raster at its INTRINSIC pixel
    // size and cannot resize it afterward (`.uno:TransformDialog`
    // `TransformWidth`/`TransformHeight` are dropped/corrupted — see
    // the `sendLowLevelOps` insert_image branch + the
    // `office.ts:3107` U2 caveat). So resample the image BYTES so the
    // intrinsic pixel size equals the target cm rect at the engine's
    // insert DPI (`LO_INSERT_DPI`), and the insert lands at the target
    // cm without any post-insert transform. `resizeImageToCm` returns
    // the ORIGINAL bytes on any jimp failure (defensive — the insert
    // never crashes), so a non-resized image lands at native size;
    // the orchestrator's live calibration surfaces a consistent
    // mismatch as a `k != 1` factor (see `LO_INSERT_DPI` doc).
    //
    // LIVE-CALIBRATION PENDING (orchestrator): insert with an explicit
    // `{w,h}` (say 8×3cm) + `extract` → if landed cm ≈ target cm,
    // `LO_INSERT_DPI = 96` is correct; if landed = k × target, the
    // real engine insert DPI = 96 × k — tune `LO_INSERT_DPI` (one-line
    // edit in `packages/loffice/src/image-resize.ts`) and re-probe.
    imageBytes = await resizeImageToCm(
      imageBytes,
      imagePlacement.placedRect.wCm,
      imagePlacement.placedRect.hCm,
      LO_INSERT_DPI,
    );
  }

  const result = await runVerifiedInPlaceTransaction(
    input.physicalPath,
    input.inExt,
    { artifactInternalId, mintOpts, broker, makeSession, gate },
    (session) => sendLowLevelOps(session, args, { imageBytes, imageFilename, imagePlacement }),
    client,
  );

  return JSON.stringify({
    ok: result.status === "changed",
    changed: result.status === "changed",
    command: args.command,
    zone: "workspace",
    inPlace: true,
    path: input.logicalPath,
    artifactId: input.artifactId,
    updatedDoc: result.updatedDoc,
    updatedDocTruncated: result.updatedDocTruncated,
    ...(result.updatedDocError ? { updatedDocError: result.updatedDocError } : {}),
    // The authoritative placed rect for `insert_image` — the agent gets
    // immediate spatial feedback WITHOUT a separate `extract`. Null for
    // every other op (the field is omitted then).
    ...(imagePlacement ? {
      placedRect: imagePlacement.placedRect,
      slideSize: imagePlacement.slideSizeCm,
      nativePixels: imagePlacement.nativePixels,
      anchor: imagePlacement.anchor,
      sizeMode: imagePlacement.sizeMode,
      slideSizeSource: imagePlacement.slideSizeSource,
    } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

/**
 * How long to wait for `.uno:ExecuteSearch`'s search-result reply before
 * proceeding anyway. The reply (`searchresultselection:`/`searchnotfound:`)
 * is a FAST-FAIL HINT, not the success contract — it has been observed to
 * simply not arrive (live 2026-07-04: 15s ack timeout aborted the
 * transaction before save, while the search itself was fine). The durable
 * byte gate + post-edit extract are the real proof, so a missing reply
 * must never fail the edit.
 */
const EXECUTE_SEARCH_HINT_TIMEOUT_MS = 2_500;

/**
 * How long to wait for the `.uno:Escape` settle ack after `insertfile`
 * (Bug 1 fix) before proceeding anyway. The ack is a SETTLE HINT, not the
 * success contract: it proves the kit has drained its command queue up to
 * and including the `insertfile` (both are forwarded to the kit on the
 * same queue — `ClientSession.cpp:1386-1478`), so the subsequent save
 * serializes AFTER the insert and the durable byte gate verifies the
 * outcome. If the ack times out (the kit's `unocommandresult:` for
 * `.uno:Escape` is not reliably emitted), we PROCEED — the save gate is
 * the final sync, same discipline as `runExecuteSearch`.
 */
const INSERT_SETTLE_HINT_TIMEOUT_MS = 2_500;

/**
 * Documented fallback slide size for when the real slide-size readback is
 * unavailable (4:3 standard Impress, 25.4 × 19.05 cm = 14400 × 10800 twips
 * — the same value the schema comment at the `at`/`x`/`y` fields
 * documents). The dispatch fetches the REAL slide size via the engine
 * (`get_structured` → `slideSize {widthCm, heightCm}`); this constant is
 * only used as a last-resort fallback when that read fails, and the
 * result flags `slideSizeSource: "fallback"` so the caller knows.
 */
const DEFAULT_SLIDE_W_CM = 25.4;
const DEFAULT_SLIDE_H_CM = 19.05;
/**
 * Fraction of the slide the `size: "fit"` path targets (≤ 1 → the image
 * never overflows the slide). Tunable — 0.9 leaves a 5% margin on each
 * axis for a centered fit. The clamp step (below) is the belt-and-
 * suspenders guarantee the rect stays on-slide even when an explicit
 * `{w, h}` overshoots.
 */
const FIT_TO_SLIDE_FRACTION = 0.9;

/** Named anchor strings accepted by `insert_image` `at`. */
const IMAGE_ANCHORS = [
  "center", "top-left", "top", "top-right",
  "left", "right", "bottom-left", "bottom", "bottom-right",
] as const;
type ImageAnchor = (typeof IMAGE_ANCHORS)[number];

/**
 * Result of the pure placement compute — the authoritative rect the
 * dispatch applied via `.uno:TransformDialog`, plus the inputs the agent
 * can cross-check against `extract`. `slideSizeSource` flags whether the
 * slide size came from the live engine readback ("engine") or the
 * hardcoded fallback ("fallback" — the read failed; the geometry is still
 * deterministic but the slide dims may be wrong, so the agent should
 * re-fetch if precise placement matters).
 */
export interface ImagePlacement {
  placedRect: { xCm: number; yCm: number; wCm: number; hCm: number };
  slideSizeCm: { widthCm: number; heightCm: number };
  nativePixels: { w: number; h: number } | null;
  anchor: ImageAnchor | "explicit";
  sizeMode:
    | "fit"
    | `fraction:${number}`
    | "explicit:both"
    | "explicit:w-derived"
    | "explicit:h-derived"
    | "fallback-slide-aspect";
  slideSizeSource: "engine" | "fallback";
}

/**
 * Compute the final on-slide rect (in centimetres) for an `insert_image`
 * placement, deterministically, from:
 *   - the image's NATIVE pixel size (parsed from its header bytes by
 *     `readImagePixelSize` — NO coolwsd `graphicselection:` echo needed),
 *   - the REAL slide size in cm (fetched via `get_structured` by the
 *     dispatch, or the hardcoded fallback),
 *   - the agent's INTENT-LEVEL args: `at` (a named anchor OR an explicit
 *     `{x, y}` cm point) and `size` ("fit" | a fraction of slide width |
 *     an explicit `{w, h}` cm object). Legacy `w`/`h` cm overrides are
 *     folded into `size` by the caller.
 *
 * The function is PURE — it does not touch the session or the engine.
 * This makes the geometry unit-testable: a test can hand it a 28×15.75 cm
 * slide + a portrait/landscape/square native and assert the rect is on-
 * slide, aspect-correct, and anchored where asked. That proof is the
 * whole point of the redesign — sizing no longer depends on a flaky live
 * echo.
 *
 * Sizing logic (priority):
 *   1. `size: {w, h}` both given → use as-is (may distort; that's the
 *      caller's call).
 *   2. `size: {w}` or `size: {h}` one given → derive the other from
 *      native aspect (preserve aspect). If native aspect is unknown,
 *      derive from the SLIDE aspect (deterministic fallback — the image
 *      fills the given dim and matches the slide's proportions).
 *   3. `size: <fraction>` (number) → width = fraction × slideW; height
 *      = width / native aspect (or slide aspect if native unknown).
 *   4. `size: "fit"` or undefined (default) → contain within
 *      `FIT_TO_SLIDE_FRACTION × slide` preserving native aspect. If
 *      native aspect unknown, fill the safe area (FIT_FRACTION × slide
 *      on both axes).
 *
 * Position logic:
 *   - `at: <named anchor>` → anchor the rect per the table below.
 *   - `at: {x, y}` → top-left at that point.
 *   - `at` omitted → default "center".
 *
 * Clamp (the GUARANTEE the rect never exceeds the slide):
 *   1. If w > slideW, scale (w, h) down by slideW/w (preserves aspect).
 *   2. If h > slideH, scale (w, h) down by slideH/h.
 *   3. Position by anchor, then clamp (x, y) to [0, slide − dim] so the
 *      rect stays fully on-slide regardless of the input.
 */
export function computeImagePlacementRect(
  nativePixels: { w: number; h: number } | null,
  slideCm: { w: number; h: number },
  intent: {
    at?: string | { x: number; y: number } | undefined;
    size?: "fit" | number | { w?: number | undefined; h?: number | undefined } | undefined;
    w?: number | undefined;
    h?: number | undefined;
  },
  slideSizeSource: "engine" | "fallback" = "engine",
): ImagePlacement {
  const slideW = slideCm.w;
  const slideH = slideCm.h;
  const aspect = nativePixels && nativePixels.w > 0 && nativePixels.h > 0
    ? nativePixels.w / nativePixels.h
    : null;
  // Slide aspect is the deterministic fallback when the image header
  // didn't yield a native size (e.g. an unsupported format). Using the
  // slide aspect keeps the rect proportional to the slide rather than
  // squashing it.
  const slideAspect = slideW > 0 && slideH > 0 ? slideW / slideH : 1;
  const effAspect = aspect ?? slideAspect;

  // Normalize `at` → either a named anchor or an explicit {x, y}.
  let anchor: ImageAnchor | "explicit";
  let explicitPos: { x: number; y: number } | null = null;
  if (intent.at === undefined || intent.at === null) {
    anchor = "center";
  } else if (typeof intent.at === "string") {
    anchor = (IMAGE_ANCHORS as readonly string[]).includes(intent.at)
      ? (intent.at as ImageAnchor)
      : "center";
  } else {
    anchor = "explicit";
    explicitPos = { x: intent.at.x, y: intent.at.y };
  }

  // Normalize `size` → fold legacy `w`/`h` into an explicit {w, h} size.
  let sizeMode: ImagePlacement["sizeMode"];
  let wCm: number;
  let hCm: number;

  // Resolve an explicit {w, h} size (cases 1, 2) — from `size: {w,h}` OR
  // legacy `w`/`h` args.
  const explicitSize =
    typeof intent.size === "object" && intent.size !== null
      ? intent.size
      : (intent.w !== undefined || intent.h !== undefined)
        ? { w: intent.w, h: intent.h }
        : null;

  if (explicitSize !== null) {
    const ew = explicitSize.w;
    const eh = explicitSize.h;
    if (ew !== undefined && eh !== undefined) {
      wCm = ew;
      hCm = eh;
      sizeMode = "explicit:both";
    } else if (ew !== undefined) {
      wCm = ew;
      hCm = ew / effAspect;
      sizeMode = aspect !== null ? "explicit:w-derived" : "fallback-slide-aspect";
    } else if (eh !== undefined) {
      hCm = eh;
      wCm = eh * effAspect;
      sizeMode = aspect !== null ? "explicit:h-derived" : "fallback-slide-aspect";
    } else {
      // {w: undefined, h: undefined} — validation rejects this, but
      // defend: fall through to fit.
      wCm = FIT_TO_SLIDE_FRACTION * slideW;
      hCm = wCm / effAspect;
      if (hCm > FIT_TO_SLIDE_FRACTION * slideH) {
        hCm = FIT_TO_SLIDE_FRACTION * slideH;
        wCm = hCm * effAspect;
      }
      sizeMode = "fit";
    }
  } else if (typeof intent.size === "number") {
    // Case 3: fraction of slide width.
    wCm = intent.size * slideW;
    hCm = wCm / effAspect;
    sizeMode = `fraction:${intent.size}`;
  } else {
    // Case 4: "fit" or default. Contain within FIT_TO_SLIDE_FRACTION ×
    // slide preserving aspect.
    wCm = FIT_TO_SLIDE_FRACTION * slideW;
    hCm = wCm / effAspect;
    if (hCm > FIT_TO_SLIDE_FRACTION * slideH) {
      hCm = FIT_TO_SLIDE_FRACTION * slideH;
      wCm = hCm * effAspect;
    }
    sizeMode = "fit";
  }

  // Clamp w/h to the slide (preserves aspect by scaling both dims equally).
  if (wCm > slideW && slideW > 0) {
    const s = slideW / wCm;
    wCm *= s;
    hCm *= s;
  }
  if (hCm > slideH && slideH > 0) {
    const s = slideH / hCm;
    wCm *= s;
    hCm *= s;
  }
  // Defensive: never let a rounding / bad-input case push w/h below 0.
  if (!Number.isFinite(wCm) || wCm < 0) wCm = 0;
  if (!Number.isFinite(hCm) || hCm < 0) hCm = 0;

  // Position by anchor (or explicit {x, y}).
  let xCm: number;
  let yCm: number;
  if (explicitPos !== null) {
    xCm = explicitPos.x;
    yCm = explicitPos.y;
  } else {
    switch (anchor) {
      case "center":        xCm = (slideW - wCm) / 2; yCm = (slideH - hCm) / 2; break;
      case "top-left":      xCm = 0;                  yCm = 0;                  break;
      case "top":           xCm = (slideW - wCm) / 2; yCm = 0;                  break;
      case "top-right":     xCm = slideW - wCm;       yCm = 0;                  break;
      case "left":          xCm = 0;                  yCm = (slideH - hCm) / 2; break;
      case "right":         xCm = slideW - wCm;       yCm = (slideH - hCm) / 2; break;
      case "bottom-left":   xCm = 0;                  yCm = slideH - hCm;       break;
      case "bottom":        xCm = (slideW - wCm) / 2; yCm = slideH - hCm;       break;
      case "bottom-right":  xCm = slideW - wCm;       yCm = slideH - hCm;       break;
      default:              xCm = (slideW - wCm) / 2; yCm = (slideH - hCm) / 2; break;
    }
  }
  // Clamp position so the rect stays fully on-slide.
  if (slideW > 0) {
    if (xCm < 0) xCm = 0;
    if (xCm > slideW - wCm) xCm = slideW - wCm;
  } else {
    xCm = 0;
  }
  if (slideH > 0) {
    if (yCm < 0) yCm = 0;
    if (yCm > slideH - hCm) yCm = slideH - hCm;
  } else {
    yCm = 0;
  }
  // A final defensive floor — a clamp against a zero slide could leave
  // x/y negative if wCm > slideW; the earlier w/h clamp already shrunk
  // wCm ≤ slideW, so this is just belt-and-suspenders.
  if (!Number.isFinite(xCm) || xCm < 0) xCm = 0;
  if (!Number.isFinite(yCm) || yCm < 0) yCm = 0;

  return {
    placedRect: { xCm, yCm, wCm, hCm },
    slideSizeCm: { widthCm: slideW, heightCm: slideH },
    nativePixels: nativePixels && aspect !== null ? nativePixels : null,
    anchor,
    sizeMode,
    slideSizeSource,
  };
}

/**
 * Fire `.uno:ExecuteSearch` and wait briefly for its reply as a hint:
 *   - `searchnotfound:` → definitive no-match (skip save; report cleanly),
 *   - `searchresultselection:` → definitive match,
 *   - timeout → PROCEED (the command was sent; coolwsd processes a
 *     session's messages in order, so the subsequent save serializes
 *     after it and the gate verifies the outcome).
 * Only non-timeout transport errors propagate.
 */
async function runExecuteSearch(
  session: CoolSessionLike,
  searchArgs: UnoArgs,
  notFoundReason: string,
): Promise<{ noMatch?: boolean; reason?: string }> {
  try {
    await session.sendUnoAndWait(".uno:ExecuteSearch", searchArgs, EXECUTE_SEARCH_HINT_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/search string not found/i.test(msg)) {
      return { noMatch: true, reason: notFoundReason };
    }
    if (!/timed out/i.test(msg)) throw err;
    // Timeout: the reply is unreliable — proceed to save + durability gate.
  }
  return {};
}

/**
 * The low-level UNO verbs for the legacy `inPlace` commands. UNO acks are
 * never load-bearing here: cursor-move / text-input ops apply silently,
 * and ExecuteSearch's reply is only a fast-fail hint (see
 * `runExecuteSearch`). The transaction's save + durable byte gate is the
 * sync/verification point.
 */
/**
 * Idempotent SET for an FF state-toggle `.uno:` command (TrackChanges,
 * FreezePanes). Reads the live command state via cool-session's
 * `getCommandState` and fires the toggle ONLY when the current state disagrees
 * with `want` — so calling with the same intent twice is a no-op, not a flip.
 * If the state is unreadable — the session lacks `getCommandState`, or the
 * engine hasn't pushed a `commandstatechanged` for this command yet and the
 * read times out (→ null) — we degrade to a single blind toggle (the previous
 * best-effort behavior), which still lands the common OFF→ON case. The engine
 * `commandstatechanged` values are cached as `true`/`false` or
 * `"enabled"`/`"disabled"` (cool-session.ts); normalize all "on" forms.
 */
async function setToggleState(
  session: CoolSessionLike,
  command: string,
  want: boolean,
): Promise<void> {
  const cur = (await session.getCommandState?.(command, 2000)) ?? null;
  if (cur === null) {
    session.sendUno(command);
    return;
  }
  const isOn = cur === true || cur === "true" || cur === "enabled";
  if (isOn !== want) session.sendUno(command);
}

function resolvePlaceTextboxSlideTarget(
  args: Pick<OfficeArgs, "targetSlide" | "slide" | "index">,
): { ok: true; slide: number | undefined } | { ok: false; error: string } {
  const rawTargets: Array<["targetSlide" | "slide" | "index", unknown]> = [
    ["targetSlide", args.targetSlide],
    ["slide", args.slide],
    ["index", args.index],
  ];
  const provided = rawTargets.filter((entry): entry is ["targetSlide" | "slide" | "index", number] => entry[1] !== undefined);
  if (provided.length === 0) return { ok: true, slide: undefined };
  for (const [key, value] of provided) {
    if (!Number.isInteger(value) || value < 0) {
      return {
        ok: false,
        error: `Error: place_textbox '${key}' must be a non-negative integer 0-based slide index (got ${JSON.stringify(value)}).`,
      };
    }
  }
  const unique = new Set(provided.map(([, value]) => value));
  if (unique.size > 1) {
    const detail = provided.map(([key, value]) => `${key}=${value}`).join(", ");
    return {
      ok: false,
      error: `Error: place_textbox got conflicting slide targets (${detail}). Provide only one of 'targetSlide' | 'slide' | 'index', or make them equal.`,
    };
  }
  return { ok: true, slide: provided[0]?.[1] };
}

/**
 * Extra pre-resolved inputs passed from `dispatchInPlaceOffice` into
 * `sendLowLevelOps` for ops that need bytes the workspace flow already
 * loaded. Currently only `insert_image` (the image artifact's bytes +
 * filename + the DETERMINISTICALLY computed placement rect); null/absent
 * for every other op.
 */
interface SendLowLevelOpsExtra {
  imageBytes?: Uint8Array | null;
  imageFilename?: string | null;
  imagePlacement?: ImagePlacement | null;
}

async function sendLowLevelOps(
  session: CoolSessionLike,
  args: OfficeArgs,
  extra?: SendLowLevelOpsExtra | null,
): Promise<{ noMatch?: boolean; reason?: string }> {
  if (args.command === "find_replace") {
    const searchArgs: UnoArgs = {
      "SearchItem.SearchString": { type: "string", value: args.find },
      "SearchItem.ReplaceString": { type: "string", value: args.replace },
      "SearchItem.Backward": { type: "boolean", value: false },
      "SearchItem.Command": { type: "long", value: SVX_SEARCH_CMD_REPLACE_ALL },
      "SearchItem.SearchStartPointX": { type: "long", value: 0 },
      "SearchItem.SearchStartPointY": { type: "long", value: 0 },
    };
    const hint = await runExecuteSearch(
      session,
      searchArgs,
      "the text to replace was not found in the document",
    );
    if (hint.noMatch) return hint;
  } else if (args.command === "insert_text") {
    if (args.atEnd ?? true) session.sendUno(".uno:GoToEndOfDoc");
    session.sendUno(".uno:InsertText", { Text: { type: "string", value: args.text } });
  } else if (args.command === "set_cell") {
    session.sendUno(".uno:GoToCell", { ToPoint: { type: "string", value: args.cell } });
    session.sendUno(".uno:EnterString", { StringName: { type: "string", value: String(args.value) } });
  } else if (args.command === "set_range") {
    // Multi-entry: write each cell of the `rows` grid, addressed from the
    // range's top-left corner (GoToCell + EnterString per cell, same verified
    // path as set_cell). Operates on the current sheet.
    const start = parseCellRef((args.range ?? "").split(":")[0] ?? "");
    // `rows` is a union (array for set_range, number for insert_table);
    // set_range validation guarantees an array here, but narrow for TS.
    const grid = Array.isArray(args.rows) ? args.rows : [];
    if (start) {
      for (let r = 0; r < grid.length; r++) {
        const row = grid[r] ?? [];
        for (let c = 0; c < row.length; c++) {
          const addr = `${colToLetters(start.col + c)}${start.row + r}`;
          session.sendUno(".uno:GoToCell", { ToPoint: { type: "string", value: addr } });
          session.sendUno(".uno:EnterString", { StringName: { type: "string", value: String(row[c]) } });
        }
      }
    }
  } else if (args.command === "format_range") {
    // Select the range via .uno:GoToCell {ToPoint} (grounded §3.1,
    // sc/sdi/scalc.sdi:2706-2707; live use already proven by set_cell),
    // then fire each provided field's UNO verb in order. Every verb below
    // is grounded in Collabora source + sc/sdi — see the inline citations.
    //
    // CAVEAT — Bold/Italic/Underline are TOGGLES (.uno:Bold/Italic/Underline
    // are FF SfxBoolItem toggles, reused Writer group §3.3.5). format_range
    // does NOT read current cell state before sending: it assumes the field
    // is being applied to freshly-written / unformatted cells (the common
    // agent path: set_range to write the table, then format_range to style
    // it). If the cell is already bold, sending `.uno:Bold` will TOGGLE it
    // OFF. There is no clean UNO "set bold to ON" verb that takes a bool —
    // the slot is a SfxBoolItem toggle. Solving toggle-vs-set would need a
    // state-read round-trip (`.uno:Bold` commandstatechanged) which is out
    // of scope here. Documented for the caller; not solved.
    session.sendUno(".uno:GoToCell", { ToPoint: { type: "string", value: args.range ?? "" } });
    if (args.bold === true) {
      // FF toggle, reused Writer group §3.3.5 (Bold = SID_ATTR_CHAR_WEIGHT,
      // svx/sdi/svx.sdi). Apply only when caller asks for bold (true); omit
      // on false/undefined so we don't toggle a state we didn't read.
      session.sendUno(".uno:Bold");
    }
    if (args.italic === true) {
      session.sendUno(".uno:Italic");
    }
    if (args.underline === true) {
      session.sendUno(".uno:Underline");
    }
    if (args.numberFormat !== undefined) {
      // Grounded in wave-c-build-sheet §1 (all SfxVoidItem, FF, no args):
      //   general  → .uno:NumberFormatStandard  (sc/sdi/scalc.sdi:4031)
      //   number   → .uno:NumberFormatDecimal    (sc/sdi/scalc.sdi:3959)
      //   currency → .uno:NumberFormatCurrency   (sc/sdi/scalc.sdi:3905; FF
      //              applies default currency — the SfxUInt32Item format-key
      //              arg is NOT sent, matching Collabora's toolbar path)
      //   percent  → .uno:NumberFormatPercent    (sc/sdi/scalc.sdi:3995)
      //   date     → .uno:NumberFormatDate       (sc/sdi/scalc.sdi:3923)
      const nfMap = {
        general: ".uno:NumberFormatStandard",
        number: ".uno:NumberFormatDecimal",
        currency: ".uno:NumberFormatCurrency",
        percent: ".uno:NumberFormatPercent",
        date: ".uno:NumberFormatDate",
      } as const;
      session.sendUno(nfMap[args.numberFormat]);
    }
    if (args.merge === true) {
      // Grounded §1: sc/sdi/scalc.sdi:3597-3598; Control.NotebookbarCalc.js:755.
      // FF toggles merge on the current selection. MoveContents is the only
      // slot arg and is rarely set from UI — omitted (FF) here.
      session.sendUno(".uno:ToggleMergeCells");
    }
    if (args.wrap === true) {
      // Grounded §1: sc/sdi/scalc.sdi:6293; Control.NotebookbarCalc.js:732-733. FF toggle.
      session.sendUno(".uno:WrapText");
    }
    if (args.fontColor !== undefined) {
      // GROUNDED for Calc cell context: the canonical Calc cell font-color
      // verb is `.uno:Color` (SID_ATTR_CHAR_COLOR, svx/sdi/svx.sdi:1554),
      // dispatched from Control.NotebookbarCalc.js:612 and sent by
      // Widget.ColorPickerButton.js:113-122 with arg name `<cmd>.Color` =
      // `Color.Color` (type long, value 0xRRGGBB). Control.Toolbar.js:728
      // confirms `.uno:Color` is the spreadsheet Font Color verb (the
      // `.uno:FontColor` override applies only to text/Writer docs).
      // NOTE: the build sheet §1 "reused Writer group" lists FontColor, but
      // `.uno:FontColor` maps to a Writer-only slot (SID_ATTR_CHAR_COLOR2,
      // sw/sdi/swriter.sdi:1323) that is NOT declared in sc/sdi — sending
      // it to a Calc cell would be a no-op. Used the grounded `.uno:Color`.
      const value = parseInt(args.fontColor.slice(1), 16);
      session.sendUno(".uno:Color", { "Color.Color": { type: "long", value } });
    }
    if (args.bgColor !== undefined) {
      // GROUNDED for Calc cell FILL: `.uno:BackgroundColor`
      // (SID_BACKGROUND_COLOR, svx/sdi/svx.sdi:456), dispatched from
      // Control.NotebookbarCalc.js:603 (Home tab "Background Color" toolitem)
      // and sent by Widget.ColorPickerButton.js:113-122 with arg name
      // `BackgroundColor.Color` (type long, value 0xRRGGBB). This is the
      // cell FILL — NOT `.uno:CharBackColor`, which is text highlight
      // (Writer) and does not fill a Calc cell.
      const value = parseInt(args.bgColor.slice(1), 16);
      session.sendUno(".uno:BackgroundColor", { "BackgroundColor.Color": { type: "long", value } });
    }
    if (args.align !== undefined) {
      // GROUNDED for Calc cell horizontal alignment (FF, SfxVoidItem, no
      // args). These are CELL-alignment verbs (SID_ALIGNLEFT / SID_ALIGNCENTERHOR
      // / SID_ALIGNRIGHT), NOT the Writer paragraph-alignment LeftPara /
      // CenterPara / RightPara verbs. Calc cells do not have paragraphs.
      //   left   → .uno:AlignLeft              (sc/sdi/scalc.sdi:213;
      //                                         Control.NotebookbarCalc.js:705)
      //   center → .uno:AlignHorizontalCenter  (sc/sdi/scalc.sdi:195;
      //                                         Control.NotebookbarCalc.js:712)
      //   right  → .uno:AlignRight             (sc/sdi/scalc.sdi:231;
      //                                         Control.NotebookbarCalc.js:719)
      const alignMap = {
        left: ".uno:AlignLeft",
        center: ".uno:AlignHorizontalCenter",
        right: ".uno:AlignRight",
      } as const;
      // Validation above restricted `align` to left/center/right for
      // format_range; narrow for TS so the 6-value enum (arrange_shape)
      // doesn't widen the index type.
      const alignKey = args.align as "left" | "center" | "right";
      session.sendUno(alignMap[alignKey]);
    }
    if (args.borders !== undefined) {
      // GROUNDED in `EXTERNAL/collabora-online-source/browser/src/control/
      // Control.Toolbar.js:39-152` (`getBorderStyleUNOCommand` — the same
      // preset builder the human Calc border-toolbar dropdown fires). The
      // 6 funParams order is [top, bottom, left, right, horiz, vert]
      // (SvxBoxInfoItemValidFlags 0x01..0x20). `_setBorders(left, right,
      // bottom, top, horiz, vert, color)` permutes to BorderLine2 order:
      // OuterBorder = [left, right, bottom, top], InnerBorder = [horiz, vert].
      // Width 1 = "on", 0 = "off"; color 0 = black (preset has no color arg).
      //   outline → _setBorders(1,1,1,1,0,0) → outer-only, valid=0x0f
      //   all     → _setBorders(1,1,1,1,1,1) → outer+inner, valid=0x3f
      //   none    → _setBorders(0,0,0,0,0,0) → widths 0, valid=0 → falls to
      //              0x7f (clear-all sentinel per lines 59-62)
      // Arbitrary border specs (color/width per side) are out of scope
      // (build-sheet §4.2) — only the three presets are exposed.
      session.sendUno(".uno:SetBorderStyle", borderPresetArgs(args.borders));
    }
  } else if (args.command === "slide_insert") {
    // Grounded: `browser/src/control/Parts.js:348,351-352` + `sd/sdi/sdraw.sdi:1659-1660`.
    // FF inserts after the current slide; `InsertPos` (int16, 0-based) inserts at pos.
    if (args.at !== undefined) {
      session.sendUno(".uno:InsertPage", { InsertPos: { type: "int16", value: args.at } });
    } else {
      session.sendUno(".uno:InsertPage");
    }
  } else if (args.command === "slide_duplicate") {
    // Grounded: `browser/src/control/Parts.js:406-409` + `sd/sdi/sdraw.sdi:783-784`.
    // FF duplicates the current slide (Collabora UI never sends InsertPos here).
    session.sendUno(".uno:DuplicatePage");
  } else if (args.command === "slide_delete") {
    // Grounded: `browser/src/control/Parts.js:419` + `sd/sdi/sdraw.sdi:661`. No args.
    session.sendUno(".uno:DeletePage");
  } else if (args.command === "slide_move") {
    // Grounded: `sd/sdi/sdraw.sdi:4079-4130`. All four are FF, no args.
    const map = { up: ".uno:MovePageUp", down: ".uno:MovePageDown", first: ".uno:MovePageFirst", last: ".uno:MovePageLast" } as const;
    session.sendUno(map[args.dir ?? "up"]);
  } else if (args.command === "slide_goto") {
    // Grounded: `browser/src/control/Parts.js:88` — `setclientpart part=<n>`
    // is a coolwsd socket message (NOT a UNO command); 0-based slide index.
    session.setClientPart(args.index ?? 0);
  } else if (args.command === "set_layout") {
    // Grounded: `browser/src/control/Toolbar.js:325-328` + `sd/sdi/sdraw.sdi:2137-2138`.
    // First select the target slide (`setclientpart`), then assign the layout.
    session.setClientPart(args.slide ?? 0);
    session.sendUno(".uno:AssignLayout", {
      WhatPage: { type: "unsigned short", value: args.slide ?? 0 },
      WhatLayout: { type: "unsigned short", value: args.layoutId ?? 0 },
    });
  } else if (args.command === "set_notes") {
    // Grounded follow-up to the textbox fix: NotesMode enters the notes edit
    // context, text must be committed through the active-edit textinput path,
    // then Escape exits/commits. `.uno:InsertText` does not reliably route
    // into draw/impress text-edit contexts.
    session.setClientPart(args.slide ?? 0);
    session.sendUno(".uno:NotesMode");
    session.sendTextInput(args.text ?? "");
    session.sendUno(".uno:Escape");
  } else if (args.command === "place_textbox") {
    // DETERMINISTIC insert — NO synthesized mouse. The old drag-emulation
    // (`.uno:DrawText` + LOK `mouse` buttondown→move→buttonup) silently
    // no-op'd headless: the box never landed on the slide (live-diagnosed
    // 2026-07-05 — extract + LibreOffice both showed nothing).
    //
    // GROUNDED in Collabora's OWN toolbar path, which fires ZERO mouse
    // events: the "Insert Text Box" button dispatches
    // `.uno:Text?CreateDirectly:bool=true` (docdispatcher.ts:291-293
    // `inserttextbox`). The verb MUST be `.uno:Text` (SID_ATTR_CHAR) — the
    // core's CreateDirectly-for-LOK branch is the SID_ATTR_CHAR/SID_TEXTEDIT
    // case (`sd/source/ui/view/drviewse.cxx:243-266`: reads FN_PARAM_1 and
    // constructs the text box immediately at default pos/size, in text-edit
    // mode, WITHOUT interactive drawing). NOTE: `.uno:DrawText` (SID_DRAW_TEXT)
    // is a DIFFERENT switch case that does interactive rectangle drawing and
    // does NOT honor this arg — using it was the original silent-no-op bug.
    //
    // Sequence: (1) construct the box directly; (2) fill text while in edit
    // mode; (3) `.uno:Escape` leaves text-edit (shape stays selected);
    // (4) `.uno:TransformDialog` moves/sizes it to the requested cm — the
    // SAME proven transform path `format_shape` uses, so exact placement is
    // deterministic regardless of the default. The save + on-disk byte gate
    // is the sync point; confirm via the `extract` slide-geometry readback.
    const targetSlide = resolvePlaceTextboxSlideTarget(args);
    if (!targetSlide.ok) return { reason: targetSlide.error };
    const xTw = Math.round((args.x ?? 0) * TWIPS_PER_CM);
    const yTw = Math.round((args.y ?? 0) * TWIPS_PER_CM);
    const wTw = Math.round((args.w ?? 0) * TWIPS_PER_CM);
    const hTw = Math.round((args.h ?? 0) * TWIPS_PER_CM);
    if (targetSlide.slide !== undefined) {
      session.setClientPart(targetSlide.slide);
    }
    session.sendUno(".uno:Text?CreateDirectly:bool=true");
    // Type via the active-edit `textinput` path (NOT .uno:InsertText, which does
    // not route into a draw text-box outliner — leaving it empty, and a new
    // empty text frame is auto-culled on end-edit: svx svdedxv.cxx:1797, which
    // is why boxes vanished). Committing text also keeps the box (HasText()).
    session.sendTextInput(args.text ?? "");
    session.sendUno(".uno:Escape");
    // TransformWidth/Height are `SfxUInt32Item` (svx/sdi/svx.sdi:12204,12223),
    // so the UNO wire type is `unsigned long` — NOT `long` (which is the
    // signed `SfxInt32Item` type used for TransformPosX/Y at svx.sdi:12166,
    // 12185). The browser's own LineWidth (`SfxUInt32Item`) is sent as
    // `type: 'unsigned long'` (`Definitions.Menu.ts:161`,
    // `Control.Toolbar.js:75`). Sending `long` here was the Bug 3 cause:
    // coolwsd drops args whose declared type doesn't match the SDI item, so
    // the size args silently no-op'd (live-verify 2026-07-06: width appeared
    // to apply because the box's text-driven default width happened to land
    // near the requested w; height did not, because the default text-box
    // height is font-size-driven and unrelated to the requested h).
    // LIVE-VERIFY PENDING (Genie readback): confirm both w AND h now land
    // within tolerance via `extract` slide-geometry readback.
    session.sendUno(".uno:TransformDialog", {
      TransformPosX: { type: "long", value: xTw },
      TransformPosY: { type: "long", value: yTw },
      TransformWidth: { type: "unsigned long", value: wTw },
      TransformHeight: { type: "unsigned long", value: hTw },
    });
  } else if (args.command === "select_shape_at") {
    // KEYSTONE (audit §3.3 route 1): a LOK `mouse` click at the twips
    // coord selects the shape under it. The wire format + twips coords
    // are grounded at `CanvasTileLayer.js:2667-2669` + `CursorHandler.ts:62-63`
    // (same path `place_textbox` already rides). The selection-confirm
    // `graphicselection:` message is NOT awaited — like `place_textbox`,
    // the save + durability gate is the sync point.
    //
    // LIVE-VERIFY HEAVY: coordinate mapping (cm → twips via
    // TWIPS_PER_CM) AND the assumption that a bare click (no drag)
    // selects the shape under it (vs. starting a marquee selection) are
    // unverified live for the agent path. Mirrors the user click model.
    const at = args.at as { x: number; y: number };
    const xTw = Math.round(at.x * TWIPS_PER_CM);
    const yTw = Math.round(at.y * TWIPS_PER_CM);
    session.sendMouse("buttondown", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
    session.sendMouse("buttonup", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
  } else if (args.command === "format_shape") {
    // Optional `at` selects the shape first (audit §3.3 route 1). Then
    // fire each provided field's grounded UNO verb (audit §1.4 G1-G3, G8).
    if (args.at !== undefined) {
      const at = args.at as { x: number; y: number };
      const xTw = Math.round(at.x * TWIPS_PER_CM);
      const yTw = Math.round(at.y * TWIPS_PER_CM);
      // LIVE-VERIFY HEAVY: same caveat as select_shape_at.
      session.sendMouse("buttondown", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
      session.sendMouse("buttonup", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
    }
    if (args.fillColor !== undefined) {
      // GROUNDED audit §1.4 G1: `.uno:FillColor` (SID_ATTR_FILL_COLOR,
      // svx/sdi/svx.sdi:2845), sent with `FillColor.Color` (type long,
      // value 0xRRGGBB) — same ColorPicker arg shape as Calc
      // `BackgroundColor` (Widget.ColorPickerButton.js:113-135).
      const value = parseInt(args.fillColor.slice(1), 16);
      session.sendUno(".uno:FillColor", { "FillColor.Color": { type: "long", value } });
    }
    if (args.lineColor !== undefined) {
      // GROUNDED audit §1.4 G2: `.uno:XLineColor` (SID_ATTR_LINE_COLOR,
      // svx/sdi/svx.sdi:9275), sent with `XLineColor.Color` (type long,
      // value 0xRRGGBB) — Widget.ColorPickerButton.js:113-135.
      const value = parseInt(args.lineColor.slice(1), 16);
      session.sendUno(".uno:XLineColor", { "XLineColor.Color": { type: "long", value } });
    }
    // Position / size / rotation all flow through `.uno:TransformDialog`
    // (SID_ATTR_TRANSFORM, svx/sdi/svx.sdi:8976-8977). Despite the name,
    // sending ARGS suppresses the dialog — Collabora's own drag + rotate
    // handlers send exactly this arg shape (audit §1.4 G3):
    //   - ShapeHandlesSection.ts:789-800 — pos args (TransformPosX/Y)
    //   - ShapeHandleRotationSubSection.ts:100-115 — rotation args
    //     (TransformRotationDeltaAngle / X / Y, angle in 1/100°, center twips)
    // Build ONE TransformDialog call carrying whichever args are provided.
    const transformArgs: UnoArgs = {};
    let hasTransform = false;
    if (args.x !== undefined) {
      transformArgs["TransformPosX"] = { type: "long", value: Math.round(args.x * TWIPS_PER_CM) };
      hasTransform = true;
    }
    if (args.y !== undefined) {
      transformArgs["TransformPosY"] = { type: "long", value: Math.round(args.y * TWIPS_PER_CM) };
      hasTransform = true;
    }
    // ⚠️ UNGROUNDED live (audit U2): SDI declares TransformWidth/Height
    // (svx/sdi/svx.sdi:8977) but Collabora only exercises pos + rotation.
    // Wired per task spec; LIVE-VERIFY the size-only-args path before
    // relying on it for production flows.
    if (args.w !== undefined) {
      transformArgs["TransformWidth"] = { type: "long", value: Math.round(args.w * TWIPS_PER_CM) };
      hasTransform = true;
    }
    if (args.h !== undefined) {
      transformArgs["TransformHeight"] = { type: "long", value: Math.round(args.h * TWIPS_PER_CM) };
      hasTransform = true;
    }
    if (args.rotation !== undefined) {
      // Rotation center: use the `at` coord (twips) if provided, else
      // the slide origin. The shape's true center is unknown without a
      // state-read round-trip; the click point is on the shape, so it
      // is a reasonable proxy. Documented caveat — not a contract.
      const cx = args.at !== undefined ? Math.round((args.at as { x: number; y: number }).x * TWIPS_PER_CM) : 0;
      const cy = args.at !== undefined ? Math.round((args.at as { x: number; y: number }).y * TWIPS_PER_CM) : 0;
      transformArgs["TransformRotationDeltaAngle"] = { type: "long", value: Math.round(args.rotation * 100) };
      transformArgs["TransformRotationX"] = { type: "long", value: cx };
      transformArgs["TransformRotationY"] = { type: "long", value: cy };
      hasTransform = true;
    }
    if (hasTransform) {
      session.sendUno(".uno:TransformDialog", transformArgs);
    }
    if (args.flipH === true) {
      // GROUNDED audit §1.4 G8: `.uno:FlipHorizontal` (SID_FLIP_HORIZONTAL,
      // svx/sdi/svx.sdi:12840), FF; Control.NotebookbarImpress.js:2483.
      session.sendUno(".uno:FlipHorizontal");
    }
    if (args.flipV === true) {
      // GROUNDED audit §1.4 G8: `.uno:FlipVertical` (SID_FLIP_VERTICAL,
      // svx/sdi/svx.sdi:12859), FF; Control.NotebookbarImpress.js:2495.
      session.sendUno(".uno:FlipVertical");
    }
    if (args.originalSize === true) {
      // GROUNDED audit §1.4 G19: `.uno:OriginalSize` (SID_ORIGINAL_SIZE,
      // sd/sdi/sdraw.sdi:2455), FF on the selected image. Resets the image
      // to its native pixel size. Pair with `at` to click-select the image
      // first; without `at`, operates on the current selection.
      session.sendUno(".uno:OriginalSize");
    }
  } else if (args.command === "arrange_shape") {
    // Optional `at` selects the shape first (audit §3.3 route 1). Then
    // fire each provided field's grounded FF UNO verb (audit §1.5-§1.7
    // G4-G6). All operate on the current selection and are fire-and-
    // forget (no args).
    if (args.at !== undefined) {
      const at = args.at as { x: number; y: number };
      const xTw = Math.round(at.x * TWIPS_PER_CM);
      const yTw = Math.round(at.y * TWIPS_PER_CM);
      // LIVE-VERIFY HEAVY: same caveat as select_shape_at.
      session.sendMouse("buttondown", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
      session.sendMouse("buttonup", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
    }
    if (args.zorder !== undefined) {
      // GROUNDED audit §1.5 G4 — all FF, no args:
      //   front    → .uno:BringToFront       (svx/sdi/svx.sdi:964; NotebookbarImpress.js:2421)
      //   back     → .uno:SendToBack          (svx/sdi/svx.sdi:7795; NotebookbarImpress.js:2427)
      //   forward  → .uno:ObjectForwardOne    (svx/sdi/svx.sdi:6124; NotebookbarImpress.js:2440)
      //   backward → .uno:ObjectBackOne       (svx/sdi/svx.sdi:6106; NotebookbarImpress.js:2447)
      const zorderMap = {
        front: ".uno:BringToFront",
        back: ".uno:SendToBack",
        forward: ".uno:ObjectForwardOne",
        backward: ".uno:ObjectBackOne",
      } as const;
      session.sendUno(zorderMap[args.zorder]);
    }
    if (args.align !== undefined) {
      // GROUNDED audit §1.7 G6 — all FF, no args:
      //   left   → .uno:ObjectAlignLeft   (svx/sdi/svx.sdi:176;  NotebookbarImpress.js:2354)
      //   center → .uno:AlignCenter       (svx/sdi/svx.sdi:140;  NotebookbarImpress.js:2361)
      //   right  → .uno:ObjectAlignRight  (svx/sdi/svx.sdi:231;  NotebookbarImpress.js:2368)
      //   top    → .uno:AlignUp           (svx/sdi/svx.sdi:249;  NotebookbarImpress.js:2381)
      //   middle → .uno:AlignMiddle       (svx/sdi/svx.sdi:213;  NotebookbarImpress.js:2387)
      //   bottom → .uno:AlignDown         (svx/sdi/svx.sdi:158;  NotebookbarImpress.js:2394)
      const alignMap = {
        left: ".uno:ObjectAlignLeft",
        center: ".uno:AlignCenter",
        right: ".uno:ObjectAlignRight",
        top: ".uno:AlignUp",
        middle: ".uno:AlignMiddle",
        bottom: ".uno:AlignDown",
      } as const;
      session.sendUno(alignMap[args.align]);
    }
    if (args.group === true) {
      // GROUNDED audit §1.6 G5: `.uno:FormatGroup` (SID_GROUP,
      // svx/sdi/svx.sdi:3449), FF on multi-selection;
      // Control.NotebookbarImpress.js:2675.
      session.sendUno(".uno:FormatGroup");
    }
    if (args.ungroup === true) {
      // GROUNDED audit §1.6 G5: `.uno:FormatUngroup` (SID_UNGROUP,
      // svx/sdi/svx.sdi:3561), FF; Util.ButtonType.ts:209.
      session.sendUno(".uno:FormatUngroup");
    }
  } else if (args.command === "slide_visibility") {
    // GROUNDED audit §1.1 G9: `.uno:HideSlide` / `.uno:ShowSlide` (FF,
    // sd/sdi/sdraw.sdi:1488, 1505; browser/src/control/Parts.js:567, 579).
    // Operates on the current slide; if `slide` is provided, switch to it
    // first via `setclientpart` (grounded Parts.js:88 — same path as
    // `slide_goto`).
    if (args.slide !== undefined) {
      session.setClientPart(args.slide);
    }
    session.sendUno(args.hidden === true ? ".uno:HideSlide" : ".uno:ShowSlide");
  } else if (args.command === "insert_table") {
    // GROUNDED audit §1.10 G10: `.uno:InsertTable` with
    // `{ Columns: long, Rows: long }` (SID_INSERT_TABLE,
    // svx/sdi/svx.sdi:5124-5125); arg shape exercised by Collabora's grid
    // picker (Control.Toolbar.js:292-298; Control.JSDialogBuilder.js:2089).
    // Inserts an N×M table onto the current slide.
    session.sendUno(".uno:InsertTable", {
      Columns: { type: "long", value: args.cols ?? 0 },
      Rows: { type: "long", value: args.rows as number },
    });
  } else if (args.command === "insert_chart") {
    // GROUNDED audit §1.10 G11: `.uno:InsertObjectChart` (SID_INSERT_DIAGRAM,
    // svx/sdi/svx.sdi:5068-5069); FF in Impress inserts a DEFAULT chart onto
    // the current slide and enters chart-edit mode
    // (Control.NotebookbarImpress.js:1260, 1525). Chart CONFIG (type/series/
    // titles/axes/legend) is DIALOG-gated (audit H7) — out of scope here.
    //
    // SHARED with Calc: in a Calc sheet, FF `.uno:InsertObjectChart` inserts
    // a default chart from the current cell selection (the same verb the
    // human Calc Insert → Chart ribbon fires). No Calc-specific path needed
    // — the shared op already serves both apps (audit §1.10 G11 + the
    // insert_table precedent). The agent should set_cell / set_range first
    // to populate a selection, then call insert_chart.
    session.sendUno(".uno:InsertObjectChart");
  } else if (args.command === "master_view") {
    // GROUNDED audit §1.11 G14: `.uno:SlideMasterPage` (SID_SLIDE_MASTER_MODE,
    // sd/sdi/sdraw.sdi:3142; Control.NotebookbarImpress.js:657;
    // Map.StateChanges.js:30, 60) toggles Master View. `.uno:CloseMasterView`
    // (SID_CLOSE_MASTER_VIEW, sd/sdi/sdraw.sdi:3625;
    // Control.NotebookbarImpress.js:1947) is the paired close verb. Both FF.
    session.sendUno(args.enter === true ? ".uno:SlideMasterPage" : ".uno:CloseMasterView");
  } else if (args.command === "format_text") {
    // D362 Wave J — Writer run formatting (inPlace-only). Mirrors the human
    // Writer ribbon (office-doc-surface.tsx): find+SELECT the anchor phrase
    // via .uno:ExecuteSearch (FIND — same call shape `edit_doc`'s
    // replace_exact uses for FIND+SELECT, see `findSelectArgs` in
    // dispatchEditDoc), then fire each provided field's grounded Writer UNO
    // verb in order. Every verb below is grounded in our OWN shipped Writer
    // ribbon — the same verbs the human toolbar fires, LIVE-VERIFIED.
    //
    // CAVEAT — Bold/Italic/Underline/Strikeout are FF TOGGLES (SfxBoolItem
    // toggles, sw/sdi/swriter.sdi; ribbon office-doc-surface.tsx:669-680
    // fires them FF). format_text does NOT read current run state before
    // sending: it assumes the anchored run isn't already in that state. If
    // the run is already bold, sending `.uno:Bold` will TOGGLE it OFF. There
    // is no clean UNO "set bold to ON" verb that takes a bool — the slot is
    // a SfxBoolItem toggle. Solving toggle-vs-set would need a state-read
    // round-trip (`.uno:Bold` commandstatechanged) which is out of scope
    // here. Documented for the caller; not solved.
    const hint = await runExecuteSearch(
      session,
      {
        "SearchItem.SearchString": { type: "string", value: args.anchor ?? "" },
        "SearchItem.Backward": { type: "boolean", value: false },
        "SearchItem.Command": { type: "long", value: SVX_SEARCH_CMD_FIND },
        "SearchItem.SearchStartPointX": { type: "long", value: 0 },
        "SearchItem.SearchStartPointY": { type: "long", value: 0 },
      },
      "the anchor text was not found in the document.",
    );
    if (hint.noMatch) return hint;
    if (args.bold === true) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:669):
      // .uno:Bold FF toggle. Apply only when caller asks for bold (true);
      // omit on false/undefined so we don't toggle a state we didn't read.
      session.sendUno(".uno:Bold");
    }
    if (args.italic === true) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:672): .uno:Italic FF toggle.
      session.sendUno(".uno:Italic");
    }
    if (args.underline === true) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:675): .uno:Underline FF toggle.
      session.sendUno(".uno:Underline");
    }
    if (args.strike === true) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:678):
      // .uno:Strikeout FF toggle (SID_ATTR_CHAR_STRIKEOUT, sw/sdi/swriter.sdi).
      session.sendUno(".uno:Strikeout");
    }
    if (args.fontColor !== undefined) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:696):
      // `.uno:FontColor` { "FontColor.Color": long, value 0xRRGGBB } —
      // Writer USES FontColor (SID_ATTR_CHAR_COLOR2, sw/sdi/swriter.sdi:1323),
      // NOT Calc's `.uno:Color` (which format_range sends for cell text).
      // Same ColorPicker arg shape as Calc (Widget.ColorPickerButton.js:113-122).
      const value = parseInt(args.fontColor.slice(1), 16);
      session.sendUno(".uno:FontColor", { "FontColor.Color": { type: "long", value } });
    }
    if (args.highlightColor !== undefined) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:704):
      // `.uno:CharBackColor` { "CharBackColor.Color": long, value 0xRRGGBB } —
      // Writer text highlight (SID_ATTR_CHAR_BACK_COLOR, sw/sdi/swriter.sdi).
      // NOT `.uno:BackgroundColor` (which format_range sends for Calc cell FILL).
      const value = parseInt(args.highlightColor.slice(1), 16);
      session.sendUno(".uno:CharBackColor", { "CharBackColor.Color": { type: "long", value } });
    }
    if (args.style !== undefined) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:620-623):
      // `.uno:StyleApply` { Style: string, FamilyName: "ParagraphStyles" }.
      // Arg shape from Collabora Control.TopToolbar applyStyle
      // (phase-3-writer-editor.md §3.3.5-B).
      session.sendUno(".uno:StyleApply", {
        Style: { type: "string", value: args.style },
        FamilyName: { type: "string", value: "ParagraphStyles" },
      });
    }
    if (args.fontFamily !== undefined) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:642-644):
      // `.uno:CharFontName` { "CharFontName.FamilyName": string }. Arg shape
      // from Collabora Toolbar.js applyFont (§3.3.5-B).
      session.sendUno(".uno:CharFontName", {
        "CharFontName.FamilyName": { type: "string", value: args.fontFamily },
      });
    }
    if (args.fontSize !== undefined) {
      // GROUNDED in our Writer ribbon (office-doc-surface.tsx:659-661):
      // `.uno:FontHeight` { "FontHeight.Height": float }. Arg shape from
      // Collabora Toolbar.js applyFontSize (§3.3.5-B). The ribbon sends the
      // size as a float-as-string; we send a numeric float (the loframe
      // serializer accepts either).
      session.sendUno(".uno:FontHeight", {
        "FontHeight.Height": { type: "float", value: args.fontSize },
      });
    }
  } else if (args.command === "insert_link") {
    // D362 Wave J — Writer hyperlink insert (inPlace-only). GROUNDED in our
    // Writer ribbon (office-doc-surface.tsx:771-774): `.uno:SetHyperlink`
    // { "Hyperlink.Text": string, "Hyperlink.URL": string } (arg shape from
    // Collabora Map.WOPI.js / Control.Toolbar.js, §3.3.5-D). Optional
    // `anchor` find+selects first so the selection becomes the link text;
    // without `anchor`, the link is inserted at the cursor with `text` as
    // the display text.
    if (args.anchor !== undefined && args.anchor.length > 0) {
      const hint = await runExecuteSearch(
        session,
        {
          "SearchItem.SearchString": { type: "string", value: args.anchor },
          "SearchItem.Backward": { type: "boolean", value: false },
          "SearchItem.Command": { type: "long", value: SVX_SEARCH_CMD_FIND },
          "SearchItem.SearchStartPointX": { type: "long", value: 0 },
          "SearchItem.SearchStartPointY": { type: "long", value: 0 },
        },
        "the anchor text was not found in the document.",
      );
      if (hint.noMatch) return hint;
    }
    session.sendUno(".uno:SetHyperlink", {
      "Hyperlink.Text": { type: "string", value: args.text ?? "" },
      "Hyperlink.URL": { type: "string", value: args.url ?? "" },
    });
  } else if (args.command === "insert_comment") {
    // D362 Wave J — Writer comment insert (inPlace-only). GROUNDED in our
    // Writer ribbon (office-doc-surface.tsx:777): `.uno:InsertAnnotation` is
    // fired FF (no args) — the ribbon inserts the annotation and the user
    // types into the in-place editor. Optional `anchor` find+selects first.
    //
    // DEFERRAL (operator pre-approved in the task spec): the `text` arg for
    // setting the comment contents from UNO is NOT grounded in our shipped
    // code (the ribbon never sends it) — we fire `.uno:InsertAnnotation` FF
    // and accept `text` WITHOUT dispatching it. The comment is inserted
    // EMPTY. To set the text, we would need to ground an arg shape (probe
    // `.uno:InsertAnnotation` with a `Text` / `Comment.Text` arg against
    // sw/sdi, OR send `.uno:InsertText` after the annotation editor
    // focuses — but that focus-state is unverified live). NOT GUESSED here
    // per the project rule (freehanded arg shapes burned days). The agent's
    // `text` is currently a no-op payload; tracked as a follow-up.
    if (args.anchor !== undefined && args.anchor.length > 0) {
      const hint = await runExecuteSearch(
        session,
        {
          "SearchItem.SearchString": { type: "string", value: args.anchor },
          "SearchItem.Backward": { type: "boolean", value: false },
          "SearchItem.Command": { type: "long", value: SVX_SEARCH_CMD_FIND },
          "SearchItem.SearchStartPointX": { type: "long", value: 0 },
          "SearchItem.SearchStartPointY": { type: "long", value: 0 },
        },
        "the anchor text was not found in the document.",
      );
      if (hint.noMatch) return hint;
    }
    session.sendUno(".uno:InsertAnnotation");
  } else if (args.command === "track_changes") {
    // D362 — Writer track-changes IDEMPOTENT SET (inPlace-only). GROUNDED in
    // our Writer Review group (office-writer-review-group.tsx:71): the human
    // toolbar fires `.uno:TrackChanges` FF — a STATE TOGGLE that lights via
    // commandstatechanged (like Bold), NOT a set-on/set-off verb. Now that
    // cool-session exposes `getCommandState`, we read the current record-state
    // and fire the toggle ONLY when it disagrees with `enabled` — so the
    // "suggest mode" enabler is a true set (calling it twice with enabled:true
    // does not flip tracking back OFF). If state is unreadable (fresh session
    // / no push / timeout → null), we degrade to a single blind toggle
    // (best-effort, old behavior) so the common OFF→ON path still works.
    await setToggleState(session, ".uno:TrackChanges", args.enabled === true);
  } else if (args.command === "review_changes") {
    // D362 — Writer co-creative review loop (inPlace-only). GROUNDED in the
    // human Writer Review group (office-writer-review-group.tsx): the 8 FF
    // verbs that let a Genie ACCEPT/REJECT tracked changes — making "suggest
    // mode" REAL (agent proposes tracked edits → either party accepts/
    // rejects). Mirrors the slide_move / arrange_shape enum→verb map
    // pattern. phase-3-writer-editor.md §3.3.8 confirms every verb below.
    // All FF, no args.
    //   accept       → .uno:AcceptTrackedChange          (office-writer-review-group.tsx:89)
    //   reject       → .uno:RejectTrackedChange          (office-writer-review-group.tsx:95)
    //   accept_next  → .uno:AcceptTrackedChangeToNext    (office-writer-review-group.tsx:101)
    //   reject_next  → .uno:RejectTrackedChangeToNext    (office-writer-review-group.tsx:107)
    //   accept_all   → .uno:AcceptAllTrackedChanges      (office-writer-review-group.tsx:113)
    //   reject_all   → .uno:RejectAllTrackedChanges      (office-writer-review-group.tsx:119)
    //   next         → .uno:NextTrackedChange            (office-writer-review-group.tsx:83)
    //   prev         → .uno:PreviousTrackedChange        (office-writer-review-group.tsx:77)
    const reviewMap = {
      accept: ".uno:AcceptTrackedChange",
      reject: ".uno:RejectTrackedChange",
      accept_next: ".uno:AcceptTrackedChangeToNext",
      reject_next: ".uno:RejectTrackedChangeToNext",
      accept_all: ".uno:AcceptAllTrackedChanges",
      reject_all: ".uno:RejectAllTrackedChanges",
      next: ".uno:NextTrackedChange",
      prev: ".uno:PreviousTrackedChange",
    } as const;
    session.sendUno(reviewMap[args.action as keyof typeof reviewMap]);
  } else if (args.command === "sheet") {
    // Wave G — Calc sheet management (inPlace-only). GROUNDED in
    // `browser/src/control/Parts.js:357-368, 423-430, 470-481` + the build
    // sheet §1 (LIVE-VERIFIED: the human sheet-tab bar fires these exact
    // verbs). `index` is 0-based from the agent; the UNO `Index` arg is
    // 1-based (nPos+1) per build-sheet §1, so we add 1 here. `Name` is
    // sent for add (empty → Core assigns SheetN) and rename (required).
    // switch rides the existing `setClientPart(n)` helper (the same
    // `setclientpart part=<n>` socket message `slide_goto` uses — grounded
    // Parts.js:88).
    if (args.action === "add") {
      session.sendUno(".uno:Insert", {
        Name: { type: "string", value: args.name ?? "" },
        Index: { type: "long", value: (args.index ?? 0) + 1 },
      });
    } else if (args.action === "rename") {
      session.sendUno(".uno:Name", {
        Name: { type: "string", value: args.name ?? "" },
        Index: { type: "long", value: (args.index ?? 0) + 1 },
      });
    } else if (args.action === "delete") {
      session.sendUno(".uno:Remove", {
        Index: { type: "long", value: (args.index ?? 0) + 1 },
      });
    } else if (args.action === "switch") {
      session.setClientPart(args.index ?? 0);
    }
  } else if (args.command === "freeze_panes") {
    // Wave G — Calc freeze panes IDEMPOTENT SET (inPlace-only). GROUNDED in
    // `sc/sdi/scalc.sdi:1978` + `Control.NotebookbarCalc.js:1477-1478`:
    // `.uno:FreezePanes` is an FF SfxBoolItem STATE TOGGLE (freezes at the
    // current cursor / selection; second toggle unfreezes). Same idempotent
    // read-then-toggle as track_changes: fire only when the current state
    // disagrees with `enabled`; degrade to a single blind toggle if the
    // state is unreadable (best-effort).
    await setToggleState(session, ".uno:FreezePanes", args.enabled === true);
  } else if (args.command === "calc_data") {
    // Calc Data-group parity (inPlace-only). Select the range, then fire the
    // FF verb the human Data ribbon fires (office-calc-groups.tsx). All three
    // are SfxVoidItem in sc/sdi/scalc.sdi: SID_SORT_ASCENDING (5310) /
    // SID_SORT_DESCENDING (5328) / SID_AUTO_FILTER (1019). Sort acts on the
    // leftmost column of the selection; AutoFilter toggles the header dropdowns.
    session.sendUno(".uno:GoToCell", { ToPoint: { type: "string", value: args.range ?? "" } });
    if (args.action === "sort_asc") {
      session.sendUno(".uno:SortAscending");
    } else if (args.action === "sort_desc") {
      session.sendUno(".uno:SortDescending");
    } else {
      session.sendUno(".uno:DataFilterAutoFilter");
    }
  } else if (args.command === "slide_field") {
    // Wave G — Impress field insert (inPlace-only). GROUNDED audit §1.12
    // G12: structured fields are FF inserts at the cursor in a text box;
    // free-text uses textinput. The field UNOs are:
    //   pagenumber → .uno:InsertPageField        (sd/sdi/sdraw.sdi:1710; NotebookbarImpress.js:1672)
    //   pagecount  → .uno:InsertPagesField       (sd/sdi/sdraw.sdi:1744; NotebookbarImpress.js:1679)
    //   pagetitle  → .uno:InsertPageTitleField   (sd/sdi/sdraw.sdi:1727; NotebookbarImpress.js:1705)
    //   date       → .uno:InsertDateFieldVar     (sd/sdi/sdraw.sdi:1591; NotebookbarImpress.js:1664)
    //   time       → .uno:InsertTimeFieldVar     (sd/sdi/sdraw.sdi:1795; NotebookbarImpress.js:1698)
    //   author     → .uno:InsertAuthorField      (sd/sdi/sdraw.sdi:1557)
    //
    // ── Bug 2 fix: establish a text-edit context BEFORE the field UNO ──
    // The previous version fired the field UNO with NO edit context
    // established, hoping the caller had pre-entered text-edit on a shape.
    // Under the agent path nothing does that headlessly (no grounded UNO
    // verb to enter text-edit on an EXISTING shape — audit §3.2), so the
    // field UNO silently no-op'd: live-verify 2026-07-06 returned
    // `ok:true` but `extract` saw no new field on slide 1.
    //
    // The fix mirrors place_textbox (the WORKING context-establishing op):
    //   1. setClientPart(targetSlide) if provided — same as place_textbox.
    //   2. `.uno:Text?CreateDirectly:bool=true` — construct a fresh text
    //      box AND enter its text-edit mode (grounded at
    //      `drviewse.cxx:243-266` CreateDirectly-for-LOK; same verb
    //      place_textbox uses to create+enter-edit in one step).
    //   3. Fire the field UNO (or `textinput` for kind=text) AT the
    //      cursor in the just-created box.
    //   4. `.uno:Escape` leaves text-edit (shape stays; field committed).
    // The field lands in a NEW text box at the default position. Inserting
    // a field into an EXISTING placeholder (select_shape_at + double-click
    // to enter text-edit) is a separate LIVE-VERIFY HEAVY flow not wired
    // here — see `select_shape_at` for the click primitive.
    //
    // LIVE-VERIFY PENDING (Genie readback): confirm the field lands in the
    //   saved doc on the target slide via `extract` slide-geometry readback
    //   (the field renders as text in the new shape). The unit test
    //   asserts the wire SEQUENCE only: setClientPart → Text?CreateDirectly
    //   → field UNO (or textinput) → Escape.
    const fieldTarget = resolvePlaceTextboxSlideTarget(args);
    if (!fieldTarget.ok) return { reason: fieldTarget.error };
    if (fieldTarget.slide !== undefined) {
      session.setClientPart(fieldTarget.slide);
    }
    session.sendUno(".uno:Text?CreateDirectly:bool=true");
    if (args.kind === "text") {
      // Free-text: type into the just-created box's outliner via the
      // active-edit `textinput` path (NOT .uno:InsertText — same reason
      // as place_textbox: it doesn't route into a draw outliner).
      session.sendTextInput(args.text ?? "");
    } else {
      const fieldMap = {
        pagenumber: ".uno:InsertPageField",
        pagecount: ".uno:InsertPagesField",
        pagetitle: ".uno:InsertPageTitleField",
        date: ".uno:InsertDateFieldVar",
        time: ".uno:InsertTimeFieldVar",
        author: ".uno:InsertAuthorField",
      } as const;
      session.sendUno(fieldMap[args.kind as "pagenumber" | "pagecount" | "pagetitle" | "date" | "time" | "author"]);
    }
    session.sendUno(".uno:Escape");
  } else if (args.command === "slide_outline") {
    // Wave G — Impress expand / summary (inPlace-only). GROUNDED audit
    // §1.1 G13: both FF, operate on the current slide.
    //   expand  → .uno:ExpandPage   (sd/sdi/sdraw.sdi:871)
    //   summary → .uno:SummaryPage  (sd/sdi/sdraw.sdi:3248)
    session.sendUno(args.action === "summary" ? ".uno:SummaryPage" : ".uno:ExpandPage");
  } else if (args.command === "master_display") {
    // Wave G — Impress per-slide master-display toggles (inPlace-only).
    // GROUNDED audit §1.3 G15:
    //   displayBackground → .uno:DisplayMasterBackground (sd/sdi/sdraw.sdi:3675; SfxBoolItem)
    //   displayObjects    → .uno:DisplayMasterObjects    (sd/sdi/sdraw.sdi:3691; SfxBoolItem)
    //
    // CAVEAT — these are FF STATE TOGGLES (same family as Bold / WrapText).
    // We fire only when caller asks for true; omit on false/undefined so
    // we don't toggle a state we didn't read. Solving toggle-vs-set would
    // need a state-read round-trip (out of scope). Documented; not solved.
    if (args.displayBackground === true) {
      session.sendUno(".uno:DisplayMasterBackground");
    }
    if (args.displayObjects === true) {
      session.sendUno(".uno:DisplayMasterObjects");
    }
  } else if (args.command === "shape_autofit") {
    // Wave G — Impress auto-fit toggle on the selected text box
    // (inPlace-only). Optional `at` selects the shape first (same LOK
    // click pattern as format_shape / arrange_shape). GROUNDED audit
    // §1.13 G17: `.uno:TextAutoFitToSize` (sd/sdi/sdraw.sdi:3350;
    // SfxBoolItem FF toggle).
    //
    // CAVEAT — same FF TOGGLE family as Bold / DisplayMasterBackground.
    // We fire only when caller asks for true (autofit=true); omit on
    // false/undefined so we don't toggle a state we didn't read.
    if (args.at !== undefined) {
      const at = args.at as { x: number; y: number };
      const xTw = Math.round(at.x * TWIPS_PER_CM);
      const yTw = Math.round(at.y * TWIPS_PER_CM);
      session.sendMouse("buttondown", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
      session.sendMouse("buttonup", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
    }
    if (args.autofit === true) {
      session.sendUno(".uno:TextAutoFitToSize");
    }
  } else if (args.command === "convert_shape") {
    // Wave G — Impress convert selected shape (inPlace-only). Optional
    // `at` selects the shape first. GROUNDED audit §1.4 G18 — all FF:
    //   bitmap  → .uno:ConvertIntoBitmap
    //   metafile → .uno:ConvertIntoMetaFile
    //   bezier  → .uno:ChangeBezier
    if (args.at !== undefined) {
      const at = args.at as { x: number; y: number };
      const xTw = Math.round(at.x * TWIPS_PER_CM);
      const yTw = Math.round(at.y * TWIPS_PER_CM);
      session.sendMouse("buttondown", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
      session.sendMouse("buttonup", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
    }
    const convertMap = {
      bitmap: ".uno:ConvertIntoBitmap",
      metafile: ".uno:ConvertIntoMetaFile",
      bezier: ".uno:ChangeBezier",
    } as const;
    session.sendUno(convertMap[args.kind as "bitmap" | "metafile" | "bezier"]);
  } else if (args.command === "group_nav") {
    // Wave G — Impress enter/leave group (inPlace-only). Optional `at`
    // selects the shape first. GROUNDED audit §1.6 G20 — both FF:
    //   enter → .uno:EnterGroup
    //   leave → .uno:LeaveGroup
    if (args.at !== undefined) {
      const at = args.at as { x: number; y: number };
      const xTw = Math.round(at.x * TWIPS_PER_CM);
      const yTw = Math.round(at.y * TWIPS_PER_CM);
      session.sendMouse("buttondown", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
      session.sendMouse("buttonup", xTw, yTw, LOK_BUTTON_LEFT, LOK_MODIFIER_NONE);
    }
    session.sendUno(args.action === "leave" ? ".uno:LeaveGroup" : ".uno:EnterGroup");
  } else if (args.command === "presentation") {
    // Last cheap tail — Impress presenter verbs (inPlace-only). GROUNDED
    // audit §1.2 G16 — both FF, no args:
    //   current  → .uno:PresentationCurrentSlide (sd/sdi/sdraw.sdi:2707;
    //              SID_PRESENTATION_CURRENT_SLIDE)
    //   rehearse → .uno:RehearseTimings          (sd/sdi/sdraw.sdi:2864;
    //              SID_REHEARSE_TIMINGS)
    //
    // LIVE-VERIFY: embed / fullscreen behavior is unverified — the same
    // caveat as `.uno:Presentation` (build-sheet §4.6). The presenter
    // console may open a sibling window / iframe overlay / coolwsd-routed
    // presenter URL; we fire the verb and let the engine handle the
    // surface. Live-probe before relying on this for production flows.
    session.sendUno(args.mode === "rehearse" ? ".uno:RehearseTimings" : ".uno:PresentationCurrentSlide");
  } else if (args.command === "insert_image") {
    // Wave K — agent image insert (inPlace-only; live coolwsd session).
    // GROUNDED in the human Insert > Image button's wire —
    // `EXTERNAL/collabora-online-source/browser/src/map/handler/Map.FileInserter.js`:
    //   1. `app.socket.sendMessage('getchildid')` (line 50) → engine replies
    //      `getchildid: id=<id>` (CanvasTileLayer.js:848-850 +
    //      _onGetChildIdMsg:1611-1613, id parsed from `id=` token by
    //      ServerCommand.ts:97-99).
    //   2. Multipart POST {name, childid, file} to `<serviceRoot>/cool/
    //      <WOPISrc>/insertfile` (lines 260-285; URL assembled by
    //      `getWopiUrl` + `makeHttpUrlWopiSrc` global.js:1806-1789).
    //   3. Socket `insertfile name=<name> type=graphic` (line 244) tells
    //      coolwsd to insert the uploaded file. NOT a UNO command — no
    //      `uno ` prefix.
    // The agent has the file bytes (loaded by `dispatchInPlaceOffice`
    // from the resolved `imagePath` workspace artifact); the cool-session
    // `postInsertFile` helper does the server-side multipart fetch through
    // the same loopback the office reverse-proxy forwards (wire-verified
    // `1b5bbfb3`). coolwsd 400s a wrong childid
    // (`ClientRequestDispatcher.cpp:2279-2296`); the postInsertFile reject
    // surfaces the HTTP status so the caller can distinguish failure modes.
    //
    // ── Intent-level placement (deterministic, no live echo) ──────────
    // The agent describes WHAT she wants via `at` (a NAMED anchor or an
    // explicit {x, y} cm point) and `size` ("fit" | a fraction of slide
    // width | an explicit {w, h} cm object). `dispatchInPlaceOffice`
    // computes the placement rect DETERMINISTICALLY BEFORE this branch:
    //   - native pixels parsed from the image header bytes (PNG IHDR /
    //     JPEG SOF — `readImagePixelSize` in `@nautilo/loffice`), NO
    //     coolwsd `graphicselection:` echo dependency,
    //   - the REAL slide size fetched via the engine (`getStructured` →
    //     `slideSize {widthCm, heightCm}`; last-resort fallback
    //     25.4×19.05 cm flagged `slideSizeSource: "fallback"`),
    //   - a pure compute (`computeImagePlacementRect`) that clamps the
    //     rect to the slide and respects the anchor.
    // This branch just APPLIES that rect via `.uno:TransformDialog` (the
    // same proven transform path `place_textbox` + `format_shape` use):
    //   (a) set the target slide as the active part (re-resolved here —
    //       the validator already rejected conflicts),
    //   (b) getchildid → multipart POST → clear-graphic-selection-cache →
    //       socket `insertfile name=… type=graphic`,
    //   (c) await `getGraphicSelection` as the SELECTION/TIMING gate
    //       (NOT to read size — the byte-based compute is authoritative;
    //       the gate proves the just-inserted image is the current
    //       selection, which the next step targets),
    //   (d) `.uno:TransformDialog` with cm→twips + TransformWidth/Height
    //       as type "unsigned long" (the EXACT type place_textbox uses;
    //       "long" is silently dropped — Bug 3 cause), TransformPosX/Y
    //       as "long",
    //   (e) `.uno:Escape` settle ack (best-effort) so the kit has
    //       processed the transform before the save/durability gate fires.
    // The placed rect is returned in the tool result (`placedRect`) — the
    // agent gets immediate spatial feedback WITHOUT a separate `extract`.
    //
    // LIVE-VERIFY PENDING (Genie readback): the image visibly lands
    //   correctly on the live slide. Confidence is HIGH because sizing is
    //   computed deterministically from bytes + slide size (not a runtime
    //   echo) — the unit tests of `computeImagePlacementRect` are
    //   meaningful proof of the geometry (anchor, fit, fraction, clamp).
    const imageBytes = extra?.imageBytes ?? null;
    const imageFilename = extra?.imageFilename ?? null;
    const placement = extra?.imagePlacement ?? null;
    if (!imageBytes || !imageFilename) {
      return { reason: "insert_image requires a resolved image artifact (bytes + filename); none was provided." };
    }
    if (!placement) {
      return { reason: "insert_image requires a pre-computed placement rect (computed by the dispatch from native pixels + slide size); none was provided." };
    }
    // (a) set the target slide as the active part (re-resolve here — the
    //     validator already rejected conflicts). Slide-2 etc. land on the
    //     intended part; without this the insert goes to the kit's current
    //     cursor context (typically slide 0 under headless).
    const imageTarget = resolvePlaceTextboxSlideTarget(args);
    if (imageTarget.ok && imageTarget.slide !== undefined) {
      session.setClientPart(imageTarget.slide);
    }
    const childId = await session.getChildId();
    if (!childId) {
      return { reason: "could not obtain a childid from the engine for image insert; please try again." };
    }
    // `name` is the upload handle coolwsd writes the file under in its
    // jail. The browser uses `Date.now()` (Map.FileInserter.js:51); we
    // mirror that — a unique-per-call numeric string.
    const name = String(Date.now());
    const contentType = mimeFromExtensionOr(imageFilename);
    await session.postInsertFile(name, childId, {
      bytes: imageBytes,
      filename: imageFilename,
      contentType,
    });
    // (b) Trigger the insert. BEFORE the trigger, clear any stale
    //     `graphicselection:` cache so a post-insert echo reads FRESH
    //     (not a rect left over from a prior selection — see the
    //     `clearGraphicSelectionCache` interface doc). Then send the
    //     socket `insertfile name=… type=graphic` (NOT a UNO command —
    //     no `uno ` prefix).
    session.clearGraphicSelectionCache?.();
    session.sendInsertFile(name, "graphic");
    // (c) SELECTION GATE — await the coolwsd `graphicselection:` echo for
    //     the just-inserted image. This is NOT for size (size is computed
    //     deterministically from the image header + slide size above; the
    //     byte-based `computeImagePlacementRect` is correct — do NOT
    //     change the math). The await is the TIMING/SELECTION gate:
    //     `.uno:TransformDialog` operates on the CURRENT selection, and
    //     the echo proves the freshly-inserted image IS the current
    //     selection (coolwsd selects a fresh insert by default, pushing
    //     `graphicselection:` with the new shape's rect — see
    //     `getGraphicSelection` interface doc). Without this gate the
    //     TransformDialog fires before the image is selected/ready →
    //     applies to nothing → the image keeps native size. This is the
    //     Bug 1 root cause, diagnosed from a clean single-op live test:
    //     the tool COMPUTES the correct rect
    //     (`placedRect {x:3.37,y:0.79,w:21.26,h:14.18}` for a 1536×1024
    //     image on a 28×15.75 slide) but `extract` shows the actual
    //     image at `{x:14.59,y:7.26,w:15.75,h:15.75}` — raw NATIVE size,
    //     off-slide. The 3c272fa2 redesign removed this await entirely;
    //     restoring it (its purpose now purely "the inserted image is
    //     selected and the kit is ready", NOT to read size) is the fix.
    //     Best-effort: if the echo times out (coolwsd didn't push within
    //     the bounded window — the echo is not wire-guaranteed), proceed
    //     with the TransformDialog anyway — the deterministic dims are
    //     still correct, and the save gate is the final sync. The `?.`
    //     guards fakes/alt sessions that don't implement the primitive.
    let graphicSelectionTimedOut = false;
    try {
      const sel = await session.getGraphicSelection?.(INSERT_SETTLE_HINT_TIMEOUT_MS);
      if (sel === null || sel === undefined) graphicSelectionTimedOut = true;
    } catch {
      // Primitive rejected (rare) — proceed best-effort, flag the gap.
      graphicSelectionTimedOut = true;
    }
    // (d) Apply POSITION via `.uno:TransformDialog` — the SAME proven
    //     transform path `place_textbox` + `format_shape` use, so
    //     placement is deterministic regardless of the insertfile's
    //     default landing. TransformDialog targets the current
    //     selection, which the graphicselection echo above proved is
    //     the just-inserted image (or, on timeout, is the best-effort
    //     assumption — see Bug 1 note).
    //
    //     SIZING-VIA-BYTES (D362 second wave): `TransformWidth` /
    //     `TransformHeight` are DROPPED/CORRUPTED by coolwsd — confirmed
    //     live (a 1024×1024 square image came out 1.39×2.45cm when
    //     sizing was attempted via TransformDialog Width/Height; see
    //     the U2 caveat at `office.ts:3107`). The image is now sized
    //     by RESAMPLING THE BYTES before insert (`resizeImageToCm` in
    //     `@nautilo/loffice`, called from `dispatchInPlaceOffice`), so
    //     the inserted raster's intrinsic pixel size IS the target cm
    //     rect — no post-insert size apply needed. ONLY position flows
    //     through TransformDialog here. `TransformPosX`/`TransformPosY`
    //     are SfxInt32Item → wire type "long" (the working type, same
    //     as place_textbox).
    //     `placedRect` in the result is now HONEST — the bytes are
    //     that size, so an `extract` after save will show the image at
    //     exactly `{xCm, yCm, wCm, hCm}` (modulo the `LO_INSERT_DPI`
    //     live-calibration factor — see `image-resize.ts`).
    void graphicSelectionTimedOut; // surfaced via code reasoning; the
    //   save/durability gate is the final sync either way.
    const { xCm, yCm } = placement.placedRect;
    const transformArgs: UnoArgs = {
      TransformPosX: { type: "long", value: Math.round(xCm * TWIPS_PER_CM) },
      TransformPosY: { type: "long", value: Math.round(yCm * TWIPS_PER_CM) },
    };
    session.sendUno(".uno:TransformDialog", transformArgs);
    // (e) Settle: await the Escape ack as proof the kit has processed the
    //     insertfile + TransformDialog (same kit queue — `ClientSession.cpp:
    //     1386-1478`). Best-effort — proceed on timeout; the save gate is
    //     the final sync. The Escape also deselects the image (harmless —
    //     the size is already applied).
    try {
      await session.sendUnoAndWait(".uno:Escape", undefined, INSERT_SETTLE_HINT_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/timed out/i.test(msg)) throw err;
      // Timeout: the ack is unreliable — proceed to save + durability gate.
    }
  }
  return {};
}

/**
 * Build the `.uno:SetBorderStyle` arg shape for a Calc border preset
 * (outline / all / none). Grounded in `EXTERNAL/collabora-online-source/
 * browser/src/control/Control.Toolbar.js:39-152` (`getBorderStyleUNOCommand`).
 *
 * The 6 funParams order in the source is [top, bottom, left, right, horiz,
 * vert] (SvxBoxInfoItemValidFlags 0x01..0x20). `_setBorders(left, right,
 * bottom, top, horiz, vert, color)` permutes to BorderLine2 order:
 *   - OuterBorder[] = [left, right, bottom, top] BorderLine2 structs
 *     (OuterLineWidth = the side's width), followed by 5 `long` zeros.
 *   - InnerBorder[] = [horiz, vert] BorderLine2 structs, followed by
 *     `short` 0, `short` valid flags, `long` 0.
 *
 * Width 1 = "on", 0 = "off"; color 0 = black (preset exposes no color arg).
 * When no flags are set, the source flips `valid` to 0x7f (clear-all
 * sentinel — lines 59-62). Arbitrary per-side border specs are out of
 * scope (build-sheet §4.2).
 */
function borderPresetArgs(preset: "outline" | "all" | "none"): UnoArgs {
  const on = preset === "outline" || preset === "all" ? 1 : 0;
  const inner = preset === "all" ? 1 : 0;
  const left = on;
  const right = on;
  const bottom = on;
  const top = on;
  const horiz = inner;
  const vert = inner;
  const color = 0;
  // SvxBoxInfoItemValidFlags: top=0x01, bottom=0x02, left=0x04, right=0x08,
  // horiz=0x10, vert=0x20. Source flips valid=0 → 0x7f (clear-all).
  let valid = 0;
  if (top) valid |= 0x01;
  if (bottom) valid |= 0x02;
  if (left) valid |= 0x04;
  if (right) valid |= 0x08;
  if (horiz) valid |= 0x10;
  if (vert) valid |= 0x20;
  if (valid === 0) valid = 0x7f;
  const borderLine = (outerLineWidth: number) => ({
    type: "com.sun.star.table.BorderLine2",
    value: {
      Color: { type: "com.sun.star.util.Color", value: color },
      InnerLineWidth: { type: "short", value: 0 },
      OuterLineWidth: { type: "short", value: outerLineWidth },
      LineDistance: { type: "short", value: 0 },
      LineStyle: { type: "short", value: 0 },
      LineWidth: { type: "unsigned long", value: 0 },
    },
  });
  return {
    OuterBorder: {
      type: "[]any",
      value: [
        borderLine(left),
        borderLine(right),
        borderLine(bottom),
        borderLine(top),
        { type: "long", value: 0 },
        { type: "long", value: 0 },
        { type: "long", value: 0 },
        { type: "long", value: 0 },
        { type: "long", value: 0 },
      ],
    },
    InnerBorder: {
      type: "[]any",
      value: [
        borderLine(horiz),
        borderLine(vert),
        { type: "short", value: 0 },
        { type: "short", value: valid },
        { type: "long", value: 0 },
      ],
    },
  };
}
