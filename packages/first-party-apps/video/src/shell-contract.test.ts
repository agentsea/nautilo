import { expect, test } from "bun:test";
import {
  DEFAULT_CUTTING_ROOM_LAYOUT,
  enterFocus,
  panelWidths,
  resolveHostTheme,
  toggleProjectPanel,
  togglePropertiesPanel,
} from "./cutting-room-layout";

test("shell layout remains presentation-only and can retain a contextual properties choice", () => {
  const withPropertiesHidden = togglePropertiesPanel(DEFAULT_CUTTING_ROOM_LAYOUT);
  const focused = enterFocus(withPropertiesHidden);
  expect(focused.focusSnapshot).toEqual({
    projectOpen: true,
    propertiesOpen: false,
    narrowDrawer: null,
    previewPercent: DEFAULT_CUTTING_ROOM_LAYOUT.previewPercent,
  });
});

test("hidden panels remove their exact grid width", () => {
  const hidden = togglePropertiesPanel(toggleProjectPanel(DEFAULT_CUTTING_ROOM_LAYOUT));
  expect(panelWidths(hidden)).toEqual({ projectWidth: "0px", propertiesWidth: "0px" });
});

test("host theme wins over OS fallback and is observed by the shell", async () => {
  expect(resolveHostTheme("dark", "light")).toBe("dark");
  expect(resolveHostTheme("unexpected", "light")).toBe("light");
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  expect(source).toContain('document.documentElement.dataset["theme"]');
  expect(source).toContain('attributeFilter: ["data-theme"]');
  expect(source).not.toContain("toggleTheme");
});

test("iframe shell begins at the document bar and leaves timeline tools to Timeline", async () => {
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const cuttingRoom = source.slice(source.indexOf('<div className="video-app cutting-room"'));
  const toolboxSource = await Bun.file(`${import.meta.dir}/Toolbox.tsx`).text();
  const toolStrip = toolboxSource.match(/<nav className="cutting-room__tool-strip"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const documentBar = cuttingRoom.match(/<nav className="cutting-room__document-bar"[\s\S]*?<\/nav>/)?.[0] ?? "";
  expect(cuttingRoom).toMatch(/^<div className="video-app cutting-room" data-theme=\{theme\}>\s*<nav/);
  expect(source).not.toContain("cutting-room__host");
  expect(source).not.toContain("cutting-room__file");
  expect(source).toContain("<ToolboxRail category={toolboxCategory}");
  expect(toolStrip).toContain("onBrowse(item)");
  expect(toolStrip).not.toMatch(/Selection|Blade|Hand|Snap|Split/);
  expect(toolboxSource).toContain('["Media", "Transitions", "Audio", "Text", "Effects"]');
  expect(source).toContain("<TextLibrary onAdd={handleAddSyntheticClip}");
  expect(documentBar).not.toMatch(/>\s*(?:Select|Split|Snap)\s*</);
  expect(source).not.toContain("Genie receipt");
  expect(source).not.toContain("cutting-room__receipt");
  expect(documentBar).toContain(">Export video</button>");
  expect(documentBar).toContain('title="Choose MP4 resolution and quality"');
  expect(documentBar).toContain("setExportDialogOpen(true)");
  expect(source).toContain("<ExportDialog");
  expect(source).toContain("Load 20-clip interaction fixture");
  expect(source).toContain("createCuttingRoomFixtureProject()");
});

test("Edit uses a reusable Media Bin and user-managed tracks instead of fixed OPEN slots", async () => {
  const appSource = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const timelineSource = await Bun.file(`${import.meta.dir}/timeline/Timeline.tsx`).text();
  const trackSource = await Bun.file(`${import.meta.dir}/timeline/TimelineTrack.tsx`).text();
  expect(appSource).toContain("<h2>Media Bin</h2>");
  expect(appSource).toContain("VIDEO_MEDIA_DRAG_TYPE");
  expect(appSource).toContain("Add at playhead");
  expect(appSource).toContain("admitImportedMedia");
  expect(appSource).not.toContain("Choosing and inspecting media");
  expect(appSource).toContain("Dismiss media message");
  expect(timelineSource).toContain('aria-label="Add track" title="Add a track for any clip type"');
  expect(trackSource).toContain("onPlaceMedia({ mediaId, trackId: track.id, timelineStartSec: snap.seconds })");
  expect(trackSource).not.toContain('{locked ? "LOCK" : "OPEN"}');
});

test("splitter exposes recoverable keyboard and pointer contracts without changing panel choice", async () => {
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const timeline = source.match(/<Timeline\s[\s\S]*?\/>/)?.[0] ?? "";
  expect(timeline).not.toBe("");
  expect(source).toContain("aria-valuemin={PREVIEW_PERCENT_MIN}");
  expect(source).toContain("aria-valuemax={PREVIEW_PERCENT_MAX}");
  expect(source).toContain("aria-valuenow={layout.previewPercent}");
  expect(source).toContain("onKeyDown={handlePreviewResizeKey}");
  expect(source).toContain('"pointercancel", restorePreviewResize');
  expect(source).toContain("restorePreviewResize();");
  expect(source).toContain('keyEvent.key !== "Escape"');
  expect(timeline).not.toContain("setLayout");
});

test("narrow drawer and Properties contracts leave interaction ownership intact", async () => {
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const properties = source.match(/<aside className=\{`cutting-room__panel cutting-room__properties[\s\S]*?<\/aside>/)?.[0] ?? "";
  expect(source).toContain('"(max-width: 760px)"');
  expect(source).toContain("togglePanelForViewport(current");
  expect(source).toContain("if (event.defaultPrevented) return;");
  expect(source).toContain("if (isNarrowViewport && !isEditingControl) setLayout(clearNarrowDrawer);");
  expect(properties).toContain("trackDisplayName(track.id, track.kind)");
  expect(properties).not.toContain("{track.id} ({track.kind})");
  expect(properties).not.toContain("onClick={splitSelected}");
});

test("real previews use bounded host bridges and clean up their resources", async () => {
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const preview = await Bun.file(`${import.meta.dir}/ProgramPreview.tsx`).text();
  expect(source).toContain("<ProgramPreview project={project}");
  expect(source).toContain("PROGRAM · SEQUENCE");
  expect(source).not.toContain("cutting-room__range-key");
  expect(source).not.toContain("previewVideoClip");
  expect(preview).toContain("bridge.asset.read({ ref: mediaRef }");
  expect(preview).toContain("URL.createObjectURL");
  expect(preview).toContain("URL.revokeObjectURL(objectUrl)");
  expect(preview).toContain("bridge.media.openPreview(request, { signal: controller.signal })");
  expect(preview).toContain("closePreview(result.revokeToken)");
  expect(preview).toContain("controller.abort();");
  expect(preview).toContain("evaluateSequence(compiled, timeSec)");
});

test("timeline controls own a readable row instead of clipping into the splitter", async () => {
  const timeline = await Bun.file(`${import.meta.dir}/timeline/Timeline.tsx`).text();
  const styles = await Bun.file(`${import.meta.dir}/../styles.css`).text();
  expect(timeline).toContain('<div className="video-timeline__scroller" ref={scroller}>');
  expect(timeline).not.toContain('style={{ height: "calc(100% - 64px)" }}');
  expect(styles).toContain("grid-template-rows: auto auto minmax(0, 1fr)");
  expect(styles).toMatch(/\.video-timeline__toolbar\s*\{[\s\S]*?min-height:\s*44px/);
  expect(styles).toMatch(/\.video-timeline__toolbar button\s*\{[\s\S]*?min-height:\s*32px/);
});

test("Generate is a peer workspace over the saved brief with Simple and Advanced scene editing", async () => {
  const app = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const composer = await Bun.file(`${import.meta.dir}/GeneratorWorkspace.tsx`).text();
  const styles = await Bun.file(`${import.meta.dir}/../styles.css`).text();
  expect(app).toContain('type VideoWorkspace = "edit" | "generate"');
  expect(app).toContain('inert={workspace !== "edit"}');
  expect(app).toContain('<GeneratorWorkspace project={project}');
  expect(composer).toContain('inert={!enabled} hidden={!enabled}');
  expect(composer).toContain('aria-label="Generation mode"');
  expect(composer).toContain('aria-label="Shared references"');
  expect(composer).toContain('aria-label="Scene design"');
  expect(composer).toContain("appendGenerationShot");
  expect(composer).toContain("moveGenerationShot");
  expect(composer).toContain("duplicateGenerationShot");
  expect(composer).toContain("deleteGenerationShot");
  expect(composer).toContain("chooseReferences");
  expect(composer).toContain("Add references");
  expect(composer).toContain("Camera");
  expect(composer).toContain("Motion");
  expect(app).toContain("generationPlanIssueMessage");
  expect(app).toContain("GenerationSettingsControls");
  expect(app).toContain("generationSettingsForSource(currentBrief, source, originalJob.requestedSettings)");
  expect(app).toContain("sourceFingerprint");
  expect(app).toContain("isSafeVideoGenerationRequestPrompt(job.prompt)");
  expect(app).toContain("runGenerationSequence");
  expect(styles).toContain(".generator-composer[hidden] { display: none; }");
});

test("empty projects are inert while structural clips keep bounded transport", async () => {
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const timeline = await Bun.file(`${import.meta.dir}/timeline/Timeline.tsx`).text();
  const ruler = await Bun.file(`${import.meta.dir}/timeline/Ruler.tsx`).text();
  expect(source).toContain("if (!playing || durationSec <= 0) return;");
  expect(source).toContain("if (!previewReadyRef.current)");
  expect(source).toContain("window.requestAnimationFrame(tick)");
  expect(source).toContain("setPlayheadSec(0);");
  expect(source).toContain("disabled={!hasTimelineClips}");
  expect(timeline).toContain("Nothing to cut yet.");
  expect(timeline).toContain("interactive={interactive}");
  expect(ruler).toContain("interactive = true");
  expect(ruler).toContain("{interactive ? <div");
});

test("Full width restores Video layout locally and requests only parent-owned Genie rail state", async () => {
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const bridge = await Bun.file(`${import.meta.dir}/bridge.ts`).text();
  expect(source).toContain("const toggleFullWidth");
  expect(source).toContain("setLayout(toggleFocus);");
  expect(source).toContain("hostLayout?.setFullWidth({ enabled })");
  expect(source).toContain(">Full width<");
  expect(bridge).toContain("setFullWidth(input: Readonly<{ enabled: boolean }>)");
});

test("generated media is automatically admitted while host authority and explicit timeline placement remain separate", async () => {
  const source = await Bun.file(`${import.meta.dir}/app.tsx`).text();
  const composer = await Bun.file(`${import.meta.dir}/GeneratorWorkspace.tsx`).text();
  const bridge = await Bun.file(`${import.meta.dir}/bridge.ts`).text();
  expect(composer).toContain("Completed media appears in the editor’s Media Bin automatically");
  expect(composer).toContain("onPlaceMedia(previewAsset.id)");
  expect(composer).toContain("Add at playhead");
  expect(source).toContain("admitGeneratedTakeMedia(nextProject, revalidation)");
  expect(source).toContain("revalidateTake({ takeId: candidate.id })");
  expect(source).toContain("commitProject(nextProject, selectedClipIdRef.current, false, true)");
  expect(source).toContain("GENERATED_TAKE_STATUS_CONCURRENCY = 6");
  expect(source).toContain("GENERATED_TAKE_POLL_INTERVAL_MS = 5_000");
  expect(source).toContain("window.clearInterval(timer)");
  expect(source).toContain("Generation finished—downloading securely.");
  expect(source).toContain("Saving to Workspace…");
  expect(source).not.toContain("time remaining");
  expect(source).toContain("generatedTakeDisplaySummaries");
  expect(source).toContain("generatedTakesEqual");
  expect(bridge).toContain("previewTake(input: { takeId: string })");
  expect(bridge).not.toContain("previewTake(input: { url:");
});
