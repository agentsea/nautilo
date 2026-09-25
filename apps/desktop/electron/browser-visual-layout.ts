export interface BrowserVisualLayoutBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserVisualLayoutMembership {
  readonly groupId: string;
  readonly kind: "grid" | "row" | "column";
  readonly box: BrowserVisualLayoutBox;
  readonly ordinal: number;
  readonly itemCount: number;
  readonly row: number;
  readonly column: number;
  readonly rows: number;
  readonly columns: number;
}

interface IndexedBox {
  readonly index: number;
  readonly box: BrowserVisualLayoutBox;
}

interface PositionedBox extends IndexedBox {
  readonly row: number;
  readonly column: number;
}

interface LayoutCandidate {
  readonly kind: BrowserVisualLayoutMembership["kind"];
  readonly members: readonly PositionedBox[];
  readonly rows: number;
  readonly columns: number;
  readonly score: number;
  readonly bounds: BrowserVisualLayoutBox;
}

function center(box: BrowserVisualLayoutBox): { readonly x: number; readonly y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function area(box: BrowserVisualLayoutBox): number {
  return box.width * box.height;
}

function intersectionArea(left: BrowserVisualLayoutBox, right: BrowserVisualLayoutBox): number {
  return Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function similarSize(left: BrowserVisualLayoutBox, right: BrowserVisualLayoutBox): boolean {
  const widthRatio = left.width / right.width;
  const heightRatio = left.height / right.height;
  const aspectRatio = (left.width / left.height) / (right.width / right.height);
  return widthRatio >= 0.72 && widthRatio <= 1.39
    && heightRatio >= 0.72 && heightRatio <= 1.39
    && aspectRatio >= 0.72 && aspectRatio <= 1.39;
}

function connected(left: IndexedBox, right: IndexedBox, medianWidth: number, medianHeight: number): boolean {
  if (intersectionArea(left.box, right.box) > Math.min(area(left.box), area(right.box)) * 0.2) return false;
  const a = center(left.box);
  const b = center(right.box);
  const horizontal = Math.abs(a.y - b.y) <= Math.max(8, medianHeight * 0.38)
    && Math.abs(a.x - b.x) >= medianWidth * 0.55
    && Math.abs(a.x - b.x) <= medianWidth * 2.75;
  const vertical = Math.abs(a.x - b.x) <= Math.max(8, medianWidth * 0.38)
    && Math.abs(a.y - b.y) >= medianHeight * 0.55
    && Math.abs(a.y - b.y) <= medianHeight * 2.75;
  return horizontal || vertical;
}

function connectedComponents(boxes: readonly IndexedBox[]): IndexedBox[][] {
  const medianWidth = median(boxes.map(({ box }) => box.width));
  const medianHeight = median(boxes.map(({ box }) => box.height));
  const remaining = new Set(boxes.map(({ index }) => index));
  const byIndex = new Map(boxes.map((item) => [item.index, item]));
  const components: IndexedBox[][] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as number;
    remaining.delete(first);
    const component: IndexedBox[] = [];
    const queue = [first];
    while (queue.length > 0) {
      const current = byIndex.get(queue.shift()!);
      if (!current) continue;
      component.push(current);
      for (const candidateIndex of [...remaining]) {
        const candidate = byIndex.get(candidateIndex);
        if (candidate && connected(current, candidate, medianWidth, medianHeight)) {
          remaining.delete(candidateIndex);
          queue.push(candidateIndex);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function axisClusters(
  boxes: readonly IndexedBox[],
  axis: "x" | "y",
  tolerance: number,
): readonly (readonly IndexedBox[])[] {
  const sorted = [...boxes].sort((left, right) => center(left.box)[axis] - center(right.box)[axis]);
  const clusters: IndexedBox[][] = [];
  for (const item of sorted) {
    const value = center(item.box)[axis];
    const existing = clusters.find((cluster) =>
      Math.abs(value - median(cluster.map((member) => center(member.box)[axis]))) <= tolerance);
    if (existing) existing.push(item);
    else clusters.push([item]);
  }
  return clusters.sort((left, right) =>
    median(left.map((member) => center(member.box)[axis]))
      - median(right.map((member) => center(member.box)[axis])));
}

function boundsOf(boxes: readonly IndexedBox[]): BrowserVisualLayoutBox {
  const left = Math.min(...boxes.map(({ box }) => box.x));
  const top = Math.min(...boxes.map(({ box }) => box.y));
  const right = Math.max(...boxes.map(({ box }) => box.x + box.width));
  const bottom = Math.max(...boxes.map(({ box }) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function candidateFromComponent(component: readonly IndexedBox[]): LayoutCandidate | null {
  if (component.length < 3) return null;
  const medianWidth = median(component.map(({ box }) => box.width));
  const medianHeight = median(component.map(({ box }) => box.height));
  const rowClusters = axisClusters(component, "y", Math.max(8, medianHeight * 0.38));
  const columnClusters = axisClusters(component, "x", Math.max(8, medianWidth * 0.38));
  const rows = rowClusters.length;
  const columns = columnClusters.length;
  const positioned = component.map((item) => ({
    ...item,
    row: rowClusters.findIndex((cluster) => cluster.some(({ index }) => index === item.index)) + 1,
    column: columnClusters.findIndex((cluster) => cluster.some(({ index }) => index === item.index)) + 1,
  }));
  const members = [...new Map(positioned.map((item) => [`${item.row}:${item.column}`, item] as const))
    .entries()].map(([slot, initial]) => {
      const alternatives = positioned.filter((candidate) => `${candidate.row}:${candidate.column}` === slot);
      return alternatives.sort((left, right) => {
        const leftDifference = Math.abs(left.box.width - medianWidth) + Math.abs(left.box.height - medianHeight);
        const rightDifference = Math.abs(right.box.width - medianWidth) + Math.abs(right.box.height - medianHeight);
        return leftDifference - rightDifference || area(right.box) - area(left.box);
      })[0] ?? initial;
    }).sort((left, right) => left.row - right.row || left.column - right.column);
  const coverage = members.length / (rows * columns);
  const kind = rows >= 2 && columns >= 2 && coverage >= 0.72
    ? "grid"
    : rows === 1 && members.length >= 3
      ? "row"
      : columns === 1 && members.length >= 3
        ? "column"
        : null;
  if (kind === null) return null;
  if (kind === "grid") {
    const rowCoverage = Array.from({ length: rows }, (_, index) =>
      members.filter(({ row }) => row === index + 1).length >= 2).filter(Boolean).length / rows;
    const columnCoverage = Array.from({ length: columns }, (_, index) =>
      members.filter(({ column }) => column === index + 1).length >= 2).filter(Boolean).length / columns;
    if (rowCoverage < 0.75 || columnCoverage < 0.75) return null;
  }
  const regularity = kind === "grid" ? coverage : 1;
  return {
    kind,
    members,
    rows,
    columns,
    score: members.length * 10 + regularity * 5 + (kind === "grid" ? 8 : 0),
    bounds: boundsOf(members),
  };
}

function candidateSignature(candidate: LayoutCandidate): string {
  return candidate.members.map(({ index }) => index).sort((left, right) => left - right).join(",");
}

function medianMemberArea(candidate: LayoutCandidate): number {
  return median(candidate.members.map(({ box }) => area(box)));
}

function sharesPlacement(left: LayoutCandidate, right: LayoutCandidate): boolean {
  if (left.kind !== right.kind || left.members.length !== right.members.length) return false;
  return left.members.every((member) => {
    const memberCenter = center(member.box);
    return right.members.some((candidate) => {
      const candidateCenter = center(candidate.box);
      const tolerance = Math.max(10, Math.min(
        member.box.width,
        member.box.height,
        candidate.box.width,
        candidate.box.height,
      ) * 0.35);
      return Math.hypot(memberCenter.x - candidateCenter.x, memberCenter.y - candidateCenter.y) <= tolerance;
    });
  });
}

/**
 * Infer repeated visual layouts using geometry alone. The result deliberately
 * contains relative structure but no semantic assumptions about the page.
 */
export function inferBrowserVisualLayouts(options: {
  readonly rectangles: readonly BrowserVisualLayoutBox[];
  readonly image: { readonly width: number; readonly height: number };
}): readonly BrowserVisualLayoutMembership[] {
  const imageArea = options.image.width * options.image.height;
  const indexed = options.rectangles.map((box, index) => ({ box, index })).filter(({ box }) =>
    box.width >= 12 && box.height >= 12
      && area(box) >= imageArea * 0.00035
      && area(box) <= imageArea * 0.2);
  const candidatesBySignature = new Map<string, LayoutCandidate>();
  for (const seed of indexed) {
    const peers = indexed.filter((candidate) => similarSize(seed.box, candidate.box));
    for (const component of connectedComponents(peers)) {
      const candidate = candidateFromComponent(component);
      if (candidate === null) continue;
      const signature = candidateSignature(candidate);
      const existing = candidatesBySignature.get(signature);
      if (!existing || candidate.score > existing.score) candidatesBySignature.set(signature, candidate);
    }
  }
  const assigned = new Set<number>();
  const selectedByScore: LayoutCandidate[] = [];
  for (const candidate of [...candidatesBySignature.values()]
    .sort((left, right) => right.score - left.score
      || right.members.length - left.members.length
      || medianMemberArea(right) - medianMemberArea(left))) {
    if (candidate.members.some(({ index }) => assigned.has(index))
      || selectedByScore.some((selected) => sharesPlacement(candidate, selected))) continue;
    candidate.members.forEach(({ index }) => assigned.add(index));
    selectedByScore.push(candidate);
  }
  const selected = selectedByScore
    .sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x);
  const counters: Record<BrowserVisualLayoutMembership["kind"], number> = { grid: 0, row: 0, column: 0 };
  return Object.freeze(selected.flatMap((candidate) => {
    counters[candidate.kind] += 1;
    const groupId = `${candidate.kind}-${counters[candidate.kind]}`;
    return candidate.members.map((member, index): BrowserVisualLayoutMembership => Object.freeze({
      groupId,
      kind: candidate.kind,
      box: Object.freeze({ ...member.box }),
      ordinal: index + 1,
      itemCount: candidate.members.length,
      row: member.row,
      column: member.column,
      rows: candidate.rows,
      columns: candidate.columns,
    }));
  }));
}
