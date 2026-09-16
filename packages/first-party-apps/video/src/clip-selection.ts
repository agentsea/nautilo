/** Presentation-only selection. A selected anchor keeps its group when dragged. */
export function selectClipIds(
  current: ReadonlySet<string>,
  clipId: string | null,
  additive = false,
  preserveSelection = false,
): ReadonlySet<string> {
  if (clipId === null) return new Set();
  if (!additive) return preserveSelection && current.has(clipId) ? current : new Set([clipId]);
  const next = new Set(current);
  if (next.has(clipId)) next.delete(clipId);
  else next.add(clipId);
  return next;
}
