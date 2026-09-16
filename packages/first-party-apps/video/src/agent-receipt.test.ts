import { describe, expect, test } from "bun:test";
import { deriveVideoAgentReceipt, recoverVideoAgentReceipt, revertVideoAgentReceipt } from "./agent-receipt";
import type { NautiloDocumentPatchAppliedEvent } from "./bridge";
import { createEmptyProject, type VideoProject } from "./edl";
import { VideoProjectHistory } from "./project-history";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";

function fixture() {
  const before = createEmptyProject();
  before.metadata = { title: "Before" };
  const after = structuredClone(before);
  after.metadata!.title = "Genie title";
  return { before, after };
}

function receiptFor(before: VideoProject, after: VideoProject, overrides: Partial<NautiloDocumentPatchAppliedEvent> = {}, omitted: readonly ("author" | "patchId")[] = []) {
  const content = serializeVideoHtml(createDefaultManifest(), before);
  const event: NautiloDocumentPatchAppliedEvent = {
    type: "patch_applied", patchId: "patch-1", author: { kind: "app_tool", displayName: "nautilo-video" },
    previousSha256: "before", previousRevision: 1, sha256: "after", revision: 2,
    envelope: { content: serializeVideoHtml(createDefaultManifest(), after), baseSha256: "after", baseRevision: 2 },
    ...overrides,
  };
  for (const key of omitted) delete event[key];
  return deriveVideoAgentReceipt(event, { content, sha256: "before", revision: 1 });
}

describe("authored Video receipt and validated Revert", () => {
  test("persisted disjoint human saves do not fence Revert or resurrect it after its own later save", () => {
    const { before, after } = fixture();
    const manifest = createDefaultManifest();
    const saved = (project: VideoProject, updatedAt: string) => serializeVideoHtml(manifest,
      { ...project, metadata: { ...project.metadata, updatedAt } }, { touchMetadata: true, updatedAt });
    const parsed = (content: string) => {
      const result = parseVideoHtml(content);
      if (!result.ok) throw new Error("Invalid test document");
      return result.document;
    };
    const beforeContent = saved(before, "2026-01-01T00:00:00.000Z");
    const agentContent = saved(after, "2026-02-01T00:00:00.000Z");
    const human = parsed(agentContent).project;
    human.sequences[0]!.markers = [{ id: "human-marker", timeSec: 0 }];
    const latest = parsed(saved(human, "2026-03-01T00:00:00.000Z"));
    const change = { kind: "ready" as const, operationId: "retained", author: { kind: "agent" as const, displayName: "Genie" },
      before: { content: beforeContent, sha256: "a" }, after: { content: agentContent, sha256: "b" }, currentSha256: "c" };
    const receipt = recoverVideoAgentReceipt(change, "c", latest.project, latest.manifest);
    expect(receipt?.unavailableReason).toBeNull();
    const reverted = revertVideoAgentReceipt(receipt!, latest.project, latest.manifest);
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) throw new Error(reverted.reason);
    expect(reverted.project.metadata?.title).toBe("Before");
    expect(reverted.project.metadata?.updatedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(reverted.project.sequences[0]!.markers).toEqual(human.sequences[0]!.markers);
    const reopened = parsed(saved(reverted.project, "2026-04-01T00:00:00.000Z"));
    expect(recoverVideoAgentReceipt({ ...change, currentSha256: "d" }, "d", reopened.project, reopened.manifest)).toBeNull();
  });
  test("retained history recovers an inverse across reopen, preserves disjoint work and detects prior Revert", () => {
    const { before, after } = fixture();
    const manifest = createDefaultManifest();
    const current = structuredClone(after);
    current.sequences[0]!.markers = [{ id: "human", timeSec: 0 }];
    const change = { kind: "ready" as const, operationId: "retained", author: { kind: "agent" as const, displayName: "Genie" },
      before: { content: serializeVideoHtml(manifest, before), sha256: "a" },
      after: { content: serializeVideoHtml(manifest, after), sha256: "b" }, currentSha256: "c" };
    const recovered = recoverVideoAgentReceipt(change, "c", current, manifest)!;
    expect(recovered.recovered).toBe(true);
    const result = revertVideoAgentReceipt(recovered, current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.metadata?.title).toBe("Before");
    expect(result.project.sequences[0]!.markers).toHaveLength(1);
    expect(recoverVideoAgentReceipt(change, "c", result.project, manifest)).toBeNull();
    expect(recoverVideoAgentReceipt(change, "stale", current, manifest)).toBeNull();
    current.metadata!.title = "Human overlap";
    expect(recoverVideoAgentReceipt(change, "c", current, manifest)?.unavailableReason).toContain("Nothing was overwritten");
    expect(recoverVideoAgentReceipt({ kind: "unavailable", code: "pruned" }, "c", current, manifest)).toBeNull();
  });
  test("trusted app-tool and agent authors are labelled without converting approval into human authorship", () => {
    const { before, after } = fixture();
    expect(receiptFor(before, after)?.summary).toBe("Genie edited the video project.");
    expect(receiptFor(before, after, { author: { kind: "agent", displayName: "Moxie" }, rebased: true })?.summary).toBe("Moxie edited the video project.");
    expect(receiptFor(before, after, { author: { kind: "human", displayName: "Alex" } })).toBeNull();
    expect(receiptFor(before, after, {}, ["author"])).toBeNull();
    expect(receiptFor(before, after, {}, ["patchId"])).toBeNull();
    expect(receiptFor(before, after, { previousRevision: 0 })).toBeNull();
    expect(receiptFor(before, after, { previousSha256: "other" })).toBeNull();
    expect(receiptFor(before, after, { sha256: "mismatch" })).toBeNull();
    expect(receiptFor(before, after, { revision: 3 })).toBeNull();
  });

  test("save timestamps do not disable normal Genie Revert or create empty receipts", () => {
    const { before, after } = fixture();
    const manifest = createDefaultManifest();
    const beforeContent = serializeVideoHtml(manifest, before, { touchMetadata: true, updatedAt: "2026-01-01T00:00:00.000Z" });
    const event: NautiloDocumentPatchAppliedEvent = {
      type: "patch_applied", patchId: "p", author: { kind: "app_tool", displayName: "nautilo-video" },
      previousSha256: "a", previousRevision: 1, sha256: "b", revision: 2,
      envelope: { content: serializeVideoHtml(manifest, after, { touchMetadata: true, updatedAt: "2026-02-01T00:00:00.000Z" }), baseSha256: "b", baseRevision: 2 },
    };
    const receipt = deriveVideoAgentReceipt(event, { content: beforeContent, sha256: "a", revision: 1 });
    expect(receipt?.unavailableReason).toBeNull();
    expect(revertVideoAgentReceipt(receipt!, after).ok).toBe(true);
    event.envelope.content = serializeVideoHtml(manifest, before, { touchMetadata: true, updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(deriveVideoAgentReceipt(event, { content: beforeContent, sha256: "a", revision: 1 })).toBeNull();
  });

  test("real manifest changes remain inspect-only", () => {
    const { before, after } = fixture();
    const manifest = createDefaultManifest();
    manifest.metadata = { ...manifest.metadata, createdBy: "Different author" };
    const receipt = receiptFor(before, after, { envelope: { content: serializeVideoHtml(manifest, after), baseSha256: "after", baseRevision: 2 } });
    expect(receipt?.unavailableReason).toContain("document settings");
    expect(revertVideoAgentReceipt(receipt!, after).ok).toBe(false);
  });

  test("Revert preserves disjoint human edits and does not enter or consume human Undo", () => {
    const { before, after } = fixture();
    const human = structuredClone(after);
    human.sequences[0]!.markers = [{ id: "human-marker", timeSec: 0 }];
    const history = new VideoProjectHistory();
    history.record(after, human);
    const result = revertVideoAgentReceipt(receiptFor(before, after)!, human);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.metadata?.title).toBe("Before");
    expect(result.project.sequences[0]!.markers).toHaveLength(1);
    expect(history.getState()).toEqual({ canUndo: true, canRedo: false });
    const undone = history.undo(result.project);
    expect(undone.ok).toBe(true);
    if (undone.ok) expect(undone.project.metadata?.title).toBe("Before");
  });

  test("later overlapping edits refuse the entire inverse without touching input", () => {
    const { before, after } = fixture();
    const human = structuredClone(after);
    human.metadata!.title = "Human latest";
    const snapshot = structuredClone(human);
    expect(revertVideoAgentReceipt(receiptFor(before, after)!, human)).toEqual({ ok: false, reason: "Cannot revert this Genie edit. The project title changed elsewhere. Nothing was overwritten." });
    expect(human).toEqual(snapshot);
  });

  test("structural additions revert, but not when later work depends on their media", () => {
    const { before } = fixture();
    const after = structuredClone(before);
    after.media.push({ id: "asset", kind: "video", ref: "source.mp4", durationSec: 4 });
    const receipt = receiptFor(before, after)!;
    expect(receipt.details).toEqual(["Added 1 media item"]);
    expect(revertVideoAgentReceipt(receipt, after).ok).toBe(true);
    const current = structuredClone(after);
    const track = current.sequences[0]!.tracks[0]!;
    track.clips.push({ id: "human-clip", kind: "video", trackId: track.id, mediaId: "asset", timelineStartSec: 0, durationSec: 1, sourceInSec: 0, sourceOutSec: 1, props: {} });
    expect(revertVideoAgentReceipt(receipt, current).ok).toBe(false);
  });

  test("an inverse can restore its own lock+content transaction but cannot bypass a later lock", () => {
    const { before } = fixture();
    const track = before.sequences[0]!.tracks[0]!;
    track.clips.push({ id: "clip", kind: "video", trackId: track.id, timelineStartSec: 0, durationSec: 1, props: {} });
    const after = structuredClone(before);
    after.sequences[0]!.tracks[0]!.clips[0]!.timelineStartSec = 2;
    after.sequences[0]!.tracks[0]!.locked = true;
    const result = revertVideoAgentReceipt(receiptFor(before, after)!, after);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.sequences[0]!.tracks[0]!.locked).not.toBe(true);
      expect(result.project.sequences[0]!.tracks[0]!.clips[0]!.timelineStartSec).toBe(0);
    }
    after.sequences[0]!.tracks[0]!.locked = false;
    const receipt = receiptFor(before, after)!;
    const later = structuredClone(after); later.sequences[0]!.tracks[0]!.locked = true;
    expect(revertVideoAgentReceipt(receipt, later).ok).toBe(false);
  });
});
