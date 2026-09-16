import { expect, test } from "bun:test";
import { appendGenerationShot, createEmptyGenerationBrief, deleteGenerationShot, duplicateGenerationShot, moveGenerationShot, updateGenerationShot, type GenerationReference } from "./generation-brief";
import { referenceMentions, setSharedGenerationReferences, sharedGenerationReferences } from "./generator-composer";
import { addScopedGenerationReferences, allGenerationReferences, generationReferenceScope, preserveGenerationReferenceMentions, removeScopedGenerationReference, sceneGenerationReferences, setGenerationReferenceScope, updateScopedGenerationReference } from "./generation-reference-scope";
import { buildVideoGenerationPlanDraft, VIDEO_GENERATION_CATALOG_MODELS, type VideoGenerationPlanIntentV1 } from "./generation-plan";
import { createEmptyProject } from "./edl";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";

function fixture() {
  return appendGenerationShot(appendGenerationShot(createEmptyGenerationBrief(), { title: "First", description: "First scene", durationSec: 4 }, () => "one"), { title: "Second", description: "Second scene", durationSec: 4 }, () => "two");
}
function ref(id: string, kind: "image" | "video" | "audio" = "image"): GenerationReference {
  return { id, name: id, mediaKind: kind, role: "Identity", instruction: "Keep the style", source: { kind: "workspace-artifact", artifactId: id, path: `references/${id}.${kind === "audio" ? "wav" : kind === "video" ? "mp4" : "png"}`, mimeType: kind === "audio" ? "audio/wav" : kind === "video" ? "video/mp4" : "image/png", sizeBytes: 42 } };
}
function intent(ids: [string, ...string[]]): VideoGenerationPlanIntentV1 {
  return { version: 1, document: { sha256: "a".repeat(64), revision: 1 }, scope: { kind: "shots", shotIds: ids }, jobs: ids.map(shotId => ({ source: { kind: "shot" as const, shotId }, modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance, settings: {} })) as [VideoGenerationPlanIntentV1["jobs"][0], ...VideoGenerationPlanIntentV1["jobs"][0][]] };
}

test("scope moves reuse existing lineage and survive save/reopen with stable tokens", () => {
  const original = setSharedGenerationReferences(fixture(), [ref("subject"), ref("voice", "audio")]);
  const scoped = setGenerationReferenceScope(original, "voice", ["one"]);
  expect(sharedGenerationReferences(original)).toHaveLength(2);
  expect(generationReferenceScope(scoped, "voice")).toEqual(["one"]);
  expect(sceneGenerationReferences(scoped, "two").map(r => r.id)).toEqual(["subject"]);
  const parsed = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: scoped }));
  expect(parsed.ok).toBe(true); if (!parsed.ok) return;
  const saved = parsed.document.project.generationBrief!;
  expect(saved).toEqual(scoped);
  const shared = setGenerationReferenceScope(saved, "voice", "all");
  expect(shared.shots.every(s => s.references.length === 0)).toBe(true);
  expect(allGenerationReferences(shared).find(r => r.id === "voice")).toEqual(allGenerationReferences(original).find(r => r.id === "voice"));
});

test("new scenes inherit all-scene references but not an explicit selection of all current scenes", () => {
  let brief = addScopedGenerationReferences(fixture(), [ref("global")]);
  brief = addScopedGenerationReferences(brief, [ref("selected")], "one");
  brief = setGenerationReferenceScope(brief, "selected", ["one", "two"]);
  brief = appendGenerationShot(brief, { title: "Third" }, () => "three");
  expect(sceneGenerationReferences(brief, "three").map(r => r.id)).toEqual(["global"]);
  expect(generationReferenceScope(brief, "selected")).toEqual(["one", "two"]);
});

test("reorder, duplicate, deletion, and undo preserve reference ownership and mentions", () => {
  const original = addScopedGenerationReferences(fixture(), [ref("voice", "audio")], "one");
  const moved = moveGenerationShot(original, "one", 1);
  expect(sceneGenerationReferences(moved, "one")[0]?.mention).toBe("@Audio1");
  const copied = duplicateGenerationShot(moved, "one", () => "copy");
  expect(sceneGenerationReferences(copied, "copy")).toEqual(sceneGenerationReferences(copied, "one"));
  const deleted = deleteGenerationShot(copied, "one");
  expect(generationReferenceScope(deleted, "voice")).toEqual(["copy"]);
  const lastDeleted = deleteGenerationShot(deleted, "copy");
  expect(allGenerationReferences(lastDeleted)).toEqual([]);
  // Undo restores the previous immutable project snapshot, with no extra state.
  expect(generationReferenceScope(copied, "voice")).toEqual(["one", "copy"]);
});

test("selecting the same media in another scene reuses its identity and token", () => {
  const first = addScopedGenerationReferences(fixture(), [ref("subject")], "one");
  const second = addScopedGenerationReferences(first, [{ ...ref("subject"), id: "new-import-id" }], "two");
  expect(allGenerationReferences(second)).toHaveLength(1);
  expect(generationReferenceScope(second, "subject")).toEqual(["one", "two"]);
  expect(sceneGenerationReferences(second, "one")).toEqual(sceneGenerationReferences(second, "two"));
  const removed = removeScopedGenerationReference(second, "subject", "one");
  expect(sceneGenerationReferences(removed, "one")).toEqual([]);
  expect(sceneGenerationReferences(removed, "two")).toHaveLength(1);
});

test("replacement and direction edits apply to the reference in each assigned scene", () => {
  let brief = setGenerationReferenceScope(addScopedGenerationReferences(fixture(), [ref("subject")]), "subject", ["one", "two"]);
  const { id: _id, ...replacement } = ref("new-file");
  brief = updateScopedGenerationReference(brief, "subject", replacement);
  brief = updateScopedGenerationReference(brief, "subject", { instruction: "Match the new coat" });
  expect(sceneGenerationReferences(brief, "one")[0]).toMatchObject({ id: "subject", mention: "@Image1", instruction: "Match the new coat", source: ref("new-file").source });
  expect(sceneGenerationReferences(brief, "one")).toEqual(sceneGenerationReferences(brief, "two"));
});

test("legacy references gain collision-free tokens before scoping, and removed tokens are not reused", () => {
  let brief = fixture();
  brief.references = [{ ...ref("explicit"), mention: "@Image1" }, ref("implicit")];
  brief = preserveGenerationReferenceMentions(brief);
  expect([...referenceMentions(allGenerationReferences(brief)).values()]).toEqual(["@Image1", "@Image2"]);
  brief = updateGenerationShot(brief, "one", { description: "Use @Image2" });
  brief = removeScopedGenerationReference(brief, "implicit");
  brief = addScopedGenerationReferences(brief, [ref("new")], "two");
  expect(allGenerationReferences(brief).find(r => r.id === "new")?.mention).toBe("@Image3");
});

test("invalid scene assignments and stale imports cannot silently broaden scope", () => {
  const brief = addScopedGenerationReferences(fixture(), [ref("subject")]);
  expect(() => setGenerationReferenceScope(brief, "subject", [])).toThrow();
  expect(() => setGenerationReferenceScope(brief, "subject", ["missing"])).toThrow();
  expect(() => setGenerationReferenceScope(brief, "missing", "all")).toThrow();
  expect(() => addScopedGenerationReferences(brief, [ref("new")], "missing")).toThrow();
  expect(allGenerationReferences(brief)).toHaveLength(1);
});

test("each scene's quote/submission plan contains only its assigned image/video/audio references", async () => {
  let brief = addScopedGenerationReferences(fixture(), [ref("subject")]);
  brief = addScopedGenerationReferences(brief, [ref("voice", "audio")], "one");
  brief = addScopedGenerationReferences(brief, [ref("fight", "video"), ref("pose")], "two");
  brief = updateGenerationShot(brief, "one", { description: "Use @Image1 and @Audio1" });
  brief = updateGenerationShot(brief, "two", { description: "Use @Image2 with @Video1" });
  const plan = await buildVideoGenerationPlanDraft(brief, intent(["one", "two"]));
  expect(plan.status).toBe("ready-for-quote"); if (plan.status !== "ready-for-quote") return;
  expect(plan.jobs[0]?.referenceImages).toEqual([{ path: "references/subject.png" }]);
  expect(plan.jobs[0]?.referenceAudios).toEqual([{ path: "references/voice.wav" }]);
  expect(plan.jobs[0]?.referenceVideos).toEqual([]);
  expect(plan.jobs[1]?.referenceImages).toEqual([{ path: "references/subject.png" }, { path: "references/pose.png" }]);
  expect(plan.jobs[1]?.referenceVideos).toEqual([{ path: "references/fight.mp4" }]);
  expect(plan.jobs[1]?.referenceAudios).toEqual([]);
  expect(plan.jobs[1]?.prompt).toContain("Use <Image 2> with <Video 1>");
  const narrowed = setGenerationReferenceScope(brief, "pose", ["one"]);
  const blocked = await buildVideoGenerationPlanDraft(narrowed, intent(["two"]));
  expect(blocked.status).toBe("blocked");
  expect(blocked.jobs).toEqual([]);
  expect(blocked.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message: "The prompt mentions removed reference @Image2. Update the prompt or attach that reference." });
});

test("audio-only scene fails validation even if another scene has a visual reference", async () => {
  let brief = addScopedGenerationReferences(fixture(), [ref("subject")], "one");
  brief = addScopedGenerationReferences(brief, [ref("voice", "audio")], "two");
  const plan = await buildVideoGenerationPlanDraft(brief, intent(["two"]));
  expect(plan.status).toBe("blocked");
  expect(plan.issues).toContainEqual({ code: "REFERENCE_UNAVAILABLE", message: "Add at least one image or video reference before generating with audio references." });
});

test("older scene-local IDs and implicit mentions retain their meaning when scope is edited", async () => {
  let brief = fixture();
  brief = updateGenerationShot(brief, "one", { description: "Use @Image1", references: [{ ...ref("first"), id: "ref-1" }] });
  brief = updateGenerationShot(brief, "two", { description: "Use @Image1", references: [{ ...ref("second"), id: "ref-1" }] });
  const second = sceneGenerationReferences(brief, "two")[0]!;
  expect(second.source).toEqual(ref("second").source);
  expect(second.id).not.toBe("ref-1");
  const saved = setGenerationReferenceScope(brief, second.id, "all");
  expect(saved.shots[0]?.description).toBe("Use @Image1");
  expect(saved.shots[1]?.description).toBe("Use @Image2");
  expect(generationReferenceScope(saved, "ref-1")).toEqual(["one"]);
  const plan = await buildVideoGenerationPlanDraft(saved, intent(["one", "two"]));
  expect(plan.status).toBe("ready-for-quote"); if (plan.status !== "ready-for-quote") return;
  expect(plan.jobs[0]?.prompt).toContain("Use <Image 2>");
  expect(plan.jobs[1]?.prompt).toContain("Use <Image 1>");
  expect(plan.jobs[1]?.referenceImages).toEqual([{ path: "references/second.png" }]);
  expect(brief.shots[1]?.description).toBe("Use @Image1");
});
