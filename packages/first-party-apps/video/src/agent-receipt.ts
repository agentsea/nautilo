import type { NautiloAuthoredChange, NautiloDocumentPatchAppliedEvent } from "./bridge";
import type { VideoManifest, VideoProject } from "./edl";
import { mergeVideoProjects, videoChangeMatchesPreimage, type VideoProjectMergeResult } from "./project-history";
import { parseVideoHtml } from "./video-document";

/** One verified authored edit, observed live or recovered from canonical history. */
export type VideoAgentReceipt = Readonly<{
  patchId: string;
  summary: string;
  details: readonly string[];
  before: VideoProject;
  after: VideoProject;
  manifest: VideoManifest;
  unavailableReason: string | null;
  recovered?: boolean;
}>;

function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function semanticManifest(manifest: VideoManifest): unknown {
  return { ...manifest, metadata: { ...manifest.metadata, updatedAt: undefined } };
}

function describeChanges(before: VideoProject, after: VideoProject): string[] {
  const details: string[] = [];
  const tracks = (project: VideoProject) => project.sequences.flatMap((sequence) => sequence.tracks);
  const clips = (project: VideoProject) => tracks(project).flatMap((track) => track.clips);
  for (const [label, prior, next] of [
    ["clip", clips(before), clips(after)],
    ["track", tracks(before).map(({ clips: _clips, ...track }) => track), tracks(after).map(({ clips: _clips, ...track }) => track)],
    ["media item", before.media, after.media],
  ] as const) {
    const a = new Map(prior.map((item) => [item.id, item]));
    const b = new Map(next.map((item) => [item.id, item]));
    const added = [...b.keys()].filter((id) => !a.has(id)).length;
    const removed = [...a.keys()].filter((id) => !b.has(id)).length;
    const updated = [...a.keys()].filter((id) => b.has(id) && !equal(a.get(id), b.get(id))).length;
    for (const [action, count] of [["Added", added], ["Removed", removed], ["Updated", updated]] as const) {
      if (count) details.push(`${action} ${count} ${label}${count === 1 ? "" : "s"}`);
    }
  }
  if (!equal(before.generationBrief, after.generationBrief)) details.push("Updated generation direction");
  if (!equal(before.generatedTakes, after.generatedTakes)) details.push("Updated generated candidates");
  if (before.metadata?.title !== after.metadata?.title) details.push("Updated project title");
  return details.length ? details : ["Updated project settings"];
}

export function deriveVideoAgentReceipt(
  event: NautiloDocumentPatchAppliedEvent,
  previous: Readonly<{ content: string; sha256: string | null; revision: number | null }>,
): VideoAgentReceipt | null {
  if (!event.patchId || !["agent", "app_tool"].includes(event.author?.kind ?? "") ||
    previous.sha256 !== event.previousSha256 || previous.revision !== event.previousRevision ||
    event.envelope.baseSha256 !== event.sha256 || event.envelope.baseRevision !== event.revision) return null;
  return receiptFromDocuments(event.patchId, event.author?.kind === "agent" ? event.author.displayName || "Genie" : "Genie", previous.content, event.envelope.content);
}

function receiptFromDocuments(patchId: string, author: string, previousContent: string, nextContent: string): VideoAgentReceipt | null {
  const before = parseVideoHtml(previousContent);
  const after = parseVideoHtml(nextContent);
  if (!before.ok || !after.ok) return null;
  const a = before.document.project;
  const b = after.document.project;
  const semantic = (project: VideoProject) => ({ ...project, metadata: { ...project.metadata, updatedAt: undefined } });
  const manifestChanged = !equal(semanticManifest(before.document.manifest), semanticManifest(after.document.manifest));
  if (!manifestChanged && equal(semantic(a), semantic(b))) return null;
  return {
    patchId,
    summary: `${author} edited the video project.`,
    details: manifestChanged ? ["Changed document settings", ...describeChanges(a, b)] : describeChanges(a, b),
    before: a,
    after: b,
    manifest: after.document.manifest,
    unavailableReason: manifestChanged ? "This edit also changed document settings. Revert is unavailable; review the document before continuing." : null,
  };
}

/** Only host-verified retained history can recover an inverse after reopening. */
export function recoverVideoAgentReceipt(change: NautiloAuthoredChange, currentSha256: string | null, current: VideoProject, manifest: VideoManifest): VideoAgentReceipt | null {
  if (change.kind !== "ready" || change.currentSha256 !== currentSha256 || change.author.kind !== "agent") return null;
  const receipt = receiptFromDocuments(change.operationId, "Genie", change.before.content, change.after.content);
  if (!receipt) return null;
  if (!receipt.unavailableReason && videoChangeMatchesPreimage(receipt.before, receipt.after, current)) return null;
  const inverse = revertVideoAgentReceipt(receipt, current, manifest);
  // A previous explicit Revert may itself be an ordinary human save. Never
  // resurrect a no-op inverse just because its original journal row remains.
  const semantic = (project: VideoProject) => ({ ...project, metadata: { ...project.metadata, updatedAt: undefined } });
  if (inverse.ok && equal(semantic(inverse.project), semantic(current))) return null;
  return { ...receipt, recovered: true, ...(!inverse.ok ? { unavailableReason: inverse.reason } : {}) };
}

/** Validated inverse of this author's delta only; never replace a whole snapshot. */
export function revertVideoAgentReceipt(receipt: VideoAgentReceipt, current: VideoProject, manifest = receipt.manifest): VideoProjectMergeResult {
  if (receipt.unavailableReason) return { ok: false, reason: receipt.unavailableReason };
  if (!equal(semanticManifest(manifest), semanticManifest(receipt.manifest))) return { ok: false, reason: "Document settings changed since this Genie edit. Revert is unavailable; nothing was overwritten." };
  const result = mergeVideoProjects(receipt.after, receipt.before, current);
  return result.ok ? result : { ok: false, reason: `Cannot revert this Genie edit. ${result.reason}` };
}
