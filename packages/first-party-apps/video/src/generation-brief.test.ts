import { describe, expect, test } from "bun:test";
import {
  appendGenerationShot,
  appendGenerationDirectionBlock,
  customDirectionText,
  customDirectionValue,
  createStarterGenerationBrief,
  createEmptyGenerationBrief,
  deleteGenerationDirectionBlock,
  deleteGenerationShot,
  duplicateGenerationShot,
  insertGenerationShot,
  moveGenerationShot,
  moveGenerationDirectionBlock,
  materializeGenerationDirectionBlocks,
  replaceGenerationReferenceAsset,
  updateGenerationDirectionBlock,
  updateGenerationBrief,
  updateGenerationShot,
  validateGenerationBrief,
} from "./generation-brief";

const ids = (...values: string[]) => {
  let index = 0;
  return () => values[index++]!;
};

describe("GenerationBrief V1", () => {
  test("creates an intentionally empty, valid brief", () => {
    expect(createEmptyGenerationBrief()).toEqual({
      version: 1,
      quickBrief: "",
      goal: "",
      references: [],
      continuity: "",
      shots: [],
      audio: "",
      exclusions: "",
      blocks: [],
    });
  });

  test("supports add, insert, edit, move, duplicate, and delete without mutation", () => {
    const original = createEmptyGenerationBrief();
    const withFirst = appendGenerationShot(original, { title: "Arrival", description: "Walk into frame." }, ids("shot-arrival"));
    const inserted = insertGenerationShot(withFirst, 0, { title: "Establishing" }, ids("shot-establishing"));
    const edited = updateGenerationShot(inserted, "shot-arrival", {
      durationSec: 4.5,
      camera: "Wide",
      motion: "Slow push in",
      references: [{ id: "ref-character", name: "Character reference" }],
      audio: "Street ambience",
      continuity: "Same coat",
      exclusions: "No logos",
    });
    const moved = moveGenerationShot(edited, "shot-arrival", 0);
    const duplicated = duplicateGenerationShot(moved, "shot-arrival", ids("shot-arrival-copy"));
    const deleted = deleteGenerationShot(duplicated, "shot-arrival");

    expect(original.shots).toEqual([]);
    expect(edited.shots[1]).toMatchObject({ id: "shot-arrival", durationSec: 4.5, camera: "Wide" });
    expect(moved.shots.map((shot) => shot.id)).toEqual(["shot-arrival", "shot-establishing"]);
    expect(duplicated.shots.map((shot) => shot.id)).toEqual(["shot-arrival", "shot-arrival-copy", "shot-establishing"]);
    expect(deleted.shots.map((shot) => shot.id)).toEqual(["shot-arrival-copy", "shot-establishing"]);
  });

  test("keeps zero shots valid after deletion and updates the non-shot details immutably", () => {
    const oneShot = appendGenerationShot(createEmptyGenerationBrief(), { title: "Only shot" }, ids("shot-only"));
    const noShots = deleteGenerationShot(oneShot, "shot-only");
    const detailed = updateGenerationBrief(noShots, {
      quickBrief: "A quiet arrival.",
      goal: "Show an arrival from the street.",
      references: [{ id: "ref-style", name: "Style board" }],
      continuity: "Keep the blue coat.",
      audio: "Rain and traffic.",
      exclusions: "No text overlays.",
    });
    expect(noShots.shots).toEqual([]);
    expect(detailed).toMatchObject({ quickBrief: "A quiet arrival.", shots: [] });
  });

  test("strictly rejects malformed, unsafe, duplicated, or path-like reference payloads", () => {
    const valid = appendGenerationShot(createEmptyGenerationBrief(), {}, ids("shot-good"));
    expect(() => validateGenerationBrief({ ...valid, extra: true })).toThrow("not supported");
    expect(() => validateGenerationBrief({ ...valid, shots: [{ ...valid.shots[0], id: "shot-good" }, { ...valid.shots[0], id: "shot-good" }] })).toThrow(
      "repeats shot id",
    );
    expect(() => updateGenerationBrief(valid, { references: [{ id: "ref-good", name: "https://example.test/a.png" }] })).toThrow(
      "not a path or URL",
    );
    expect(() => validateGenerationBrief(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow("Unsafe key");
  });

  test("preserves scene/reference collections beyond the removed project quotas", () => {
    const base = appendGenerationShot(createEmptyGenerationBrief(), {}, ids("shot-0"));
    const first = base.shots[0]!;
    const references = Array.from({ length: 129 }, (_, index) => ({
      id: `ref-${index}`, name: `Reference ${index}`,
    }));
    const shots = Array.from({ length: 129 }, (_, index) => ({ ...first, id: `shot-${index}`, references }));
    const accepted = validateGenerationBrief({ ...base, references, shots, goal: "Long direction. ".repeat(400) });
    expect(accepted.references).toEqual(references);
    expect(accepted.shots).toEqual(shots);
    expect(accepted.goal).toBe("Long direction. ".repeat(400));
    const updated = updateGenerationShot(base, "shot-0", { references });
    expect(updated.shots[0]!.references).toEqual(references);
  });

  test("keeps an ordered, editable canvas with safe media lineage", () => {
    const starter = createStarterGenerationBrief(ids("shot-opening"), ids("block-goal", "block-references", "block-shot", "block-continuity", "block-audio", "block-exclusions"));
    const reference = {
        id: "ref-look",
        name: "Portrait reference",
        mediaKind: "image" as const,
        role: "Subject identity",
        instruction: "Use face and hair, not the background.",
        source: { kind: "workspace-artifact" as const, artifactId: "artifact-look", path: "References/portrait.png", mimeType: "image/png", sizeBytes: 1234 },
      };
    const withReference = updateGenerationDirectionBlock(starter, "block-references", { references: [reference] });
    const withNote = appendGenerationDirectionBlock(withReference, { kind: "note", note: "Keep this quiet." }, ids("block-note"));
    const collapsed = updateGenerationDirectionBlock(withNote, "block-note", { collapsed: true });
    const moved = moveGenerationDirectionBlock(collapsed, "block-note", 0);
    const removed = deleteGenerationDirectionBlock(moved, "block-references");

    expect(starter.blocks.map((block) => block.kind)).toEqual(["goal", "references", "shot", "continuity", "audio", "exclusions"]);
    expect(moved.blocks[0]).toMatchObject({ id: "block-note", kind: "note", collapsed: true });
    expect(removed.blocks.find((block) => block.id === "block-references")).toBeUndefined();
    expect(() => validateGenerationBrief({ ...withReference, blocks: withReference.blocks.map((block) => block.id === "block-references" ? { ...block, references: [{ ...reference, source: { kind: "workspace-artifact", artifactId: "artifact-look", path: "/private/path.png", mimeType: "image/png", sizeBytes: 1 } }] } : block) })).toThrow("public Workspace logical path");
    expect(() => validateGenerationBrief({ ...withReference, blocks: withReference.blocks.map((block) => block.id === "block-references" ? { ...block, references: [{ ...reference, source: { kind: "workspace-artifact", artifactId: "artifact-look", path: "../private/path.png", mimeType: "image/png", sizeBytes: 1 } }] } : block) })).toThrow("public Workspace logical path");
  });

  test("keeps duplicated global blocks independent and synchronizes shot order from the canvas", () => {
    const base = createEmptyGenerationBrief();
    const first = appendGenerationShot(base, { title: "First", description: "First action" }, ids("shot-first"));
    const second = appendGenerationShot(first, { title: "Second", description: "Second action" }, ids("shot-second"));
    const withBlocks = validateGenerationBrief({ ...second, blocks: [
      { id: "goal-one", kind: "goal", quickBrief: "One", goal: "First goal" },
      { id: "goal-two", kind: "goal", quickBrief: "Two", goal: "Second goal" },
      { id: "shot-first-block", kind: "shot", shotId: "shot-first" },
      { id: "shot-second-block", kind: "shot", shotId: "shot-second" },
    ] });
    const edited = updateGenerationDirectionBlock(withBlocks, "goal-one", { quickBrief: "One revised" });
    const moved = moveGenerationDirectionBlock(edited, "shot-second-block", 2);
    const removed = deleteGenerationDirectionBlock(moved, "goal-one");

    expect(edited.blocks.find((block) => block.id === "goal-two")).toMatchObject({ quickBrief: "Two", goal: "Second goal" });
    expect(moved.shots.map((shot) => shot.id)).toEqual(["shot-second", "shot-first"]);
    expect(removed.blocks.find((block) => block.id === "goal-two")).toMatchObject({ quickBrief: "Two", goal: "Second goal" });
  });

  test("persists an explicit custom preset selection without confusing it for an empty field", () => {
    expect(customDirectionValue("low handheld orbit")).toBe("Custom: low handheld orbit");
    expect(customDirectionText(customDirectionValue("low handheld orbit"))).toBe("low handheld orbit");
  });

  test("replaces an attached Workspace reference without losing its Human direction", () => {
    const replaced = replaceGenerationReferenceAsset({
      id: "ref-subject",
      name: "Old image",
      mediaKind: "image",
      role: "Custom: face and hair only",
      instruction: "Ignore the background and clothing.",
      source: { kind: "workspace-artifact", artifactId: "old-artifact", path: "video-references/old.png", mimeType: "image/png", sizeBytes: 20 },
    }, {
      name: "Replacement video",
      mediaKind: "video",
      source: { kind: "workspace-artifact", artifactId: "new-artifact", path: "video-references/new.mp4", mimeType: "video/mp4", sizeBytes: 21 },
    });
    expect(replaced).toMatchObject({ id: "ref-subject", name: "Replacement video", mediaKind: "video", role: "Custom: face and hair only", instruction: "Ignore the background and clothing.", source: { artifactId: "new-artifact" } });
  });

  test("materializes legacy top-level Reference Board data before every block-scoped reference mutation", () => {
    const legacy = updateGenerationBrief(createEmptyGenerationBrief(), { references: [{ id: "ref-old", name: "Old", role: "Subject identity", instruction: "Keep the face." }] });
    const materialized = materializeGenerationDirectionBlocks(legacy);
    const board = materialized.blocks.find((block) => block.kind === "references");
    expect(board).toMatchObject({ id: "legacy-references", references: [{ id: "ref-old" }] });
    const added = updateGenerationDirectionBlock(materialized, "legacy-references", { references: [...(board?.references ?? []), { id: "ref-new", name: "New" }] });
    const edited = updateGenerationDirectionBlock(added, "legacy-references", { references: (added.blocks.find((block) => block.id === "legacy-references")?.references ?? []).map((reference) => reference.id === "ref-old" ? { ...reference, instruction: "Keep the face and hair." } : reference) });
    const replaced = updateGenerationDirectionBlock(edited, "legacy-references", { references: (edited.blocks.find((block) => block.id === "legacy-references")?.references ?? []).map((reference) => reference.id === "ref-old" ? replaceGenerationReferenceAsset(reference, { name: "New source", mediaKind: "image", source: { kind: "workspace-artifact", artifactId: "replacement", path: "video-references/replacement.png", mimeType: "image/png", sizeBytes: 1 } }) : reference) });
    const removed = updateGenerationDirectionBlock(replaced, "legacy-references", { references: (replaced.blocks.find((block) => block.id === "legacy-references")?.references ?? []).filter((reference) => reference.id !== "ref-new") });
    expect(removed.blocks.find((block) => block.id === "legacy-references")?.references).toEqual([expect.objectContaining({ id: "ref-old", name: "New source", role: "Subject identity", instruction: "Keep the face and hair." })]);
  });
});
