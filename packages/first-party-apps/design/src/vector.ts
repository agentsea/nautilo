/**
 * Phase-2 vector foundation — renderer-neutral vector model + pure geometry.
 *
 * A `VectorNetwork` is the source of truth for a vector shape: a set of
 * `vertices` (points), `segments` (edges between two vertices, optionally with
 * cubic Bézier handles), and `regions` (ordered closed loops of vertices). This
 * module converts a network to SVG path data and provides DOM-free geometry
 * helpers (hit-testing, bounds) that later interaction code (Wave B) can reuse.
 *
 * Nothing here touches the DOM. `renderSceneSvg` (design-document.ts) turns the
 * path data into an SVG string. All functions are pure and unit-tested.
 */

export type VectorVertex = {
  id: string;
  x: number;
  y: number;
};

export type VectorSegmentHandle = {
  x: number;
  y: number;
};

export type VectorSegment = {
  id: string;
  startVertexId: string;
  endVertexId: string;
  startHandle?: VectorSegmentHandle;
  endHandle?: VectorSegmentHandle;
};

export type VectorRegion = {
  id: string;
  vertexIds: string[];
  fill?: string;
};

export type VectorNetwork = {
  vertices: VectorVertex[];
  segments: VectorSegment[];
  regions: VectorRegion[];
};

export type VectorPathCommand =
  | { kind: "M"; x: number; y: number }
  | { kind: "L"; x: number; y: number }
  | {
      kind: "C";
      c1x: number;
      c1y: number;
      c2x: number;
      c2y: number;
      x: number;
      y: number;
    }
  | { kind: "Z" };

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error("SVG geometry must contain finite coordinates.");
  return String(n);
}

/** Serialize a sequence of path commands to an SVG path `d` string. */
export function pathDataFromCommands(commands: VectorPathCommand[]): string {
  const parts: string[] = [];
  for (const cmd of commands) {
    switch (cmd.kind) {
      case "M":
        parts.push(`M ${formatNumber(cmd.x)} ${formatNumber(cmd.y)}`);
        break;
      case "L":
        parts.push(`L ${formatNumber(cmd.x)} ${formatNumber(cmd.y)}`);
        break;
      case "C":
        parts.push(
          `C ${formatNumber(cmd.c1x)} ${formatNumber(cmd.c1y)} ${formatNumber(cmd.c2x)} ${formatNumber(cmd.c2y)} ${formatNumber(cmd.x)} ${formatNumber(cmd.y)}`,
        );
        break;
      case "Z":
        parts.push("Z");
        break;
    }
  }
  return parts.join(" ");
}

/** Translate every coordinate in a command list by (dx, dy). Pure. */
export function translateCommands(
  commands: VectorPathCommand[],
  dx: number,
  dy: number,
): VectorPathCommand[] {
  return commands.map((cmd) => {
    switch (cmd.kind) {
      case "M":
        return { kind: "M", x: cmd.x + dx, y: cmd.y + dy };
      case "L":
        return { kind: "L", x: cmd.x + dx, y: cmd.y + dy };
      case "C":
        return {
          kind: "C",
          c1x: cmd.c1x + dx,
          c1y: cmd.c1y + dy,
          c2x: cmd.c2x + dx,
          c2y: cmd.c2y + dy,
          x: cmd.x + dx,
          y: cmd.y + dy,
        };
      case "Z":
        return { kind: "Z" };
    }
  });
}

type SegmentMatch = { seg: VectorSegment; reversed: boolean };

function segmentBetween(
  segments: VectorSegment[],
  aId: string,
  bId: string,
): SegmentMatch | null {
  for (const seg of segments) {
    if (seg.startVertexId === aId && seg.endVertexId === bId) {
      return { seg, reversed: false };
    }
    if (seg.startVertexId === bId && seg.endVertexId === aId) {
      return { seg, reversed: true };
    }
  }
  return null;
}

function isCurve(seg: VectorSegment | null): boolean {
  return seg !== null && (seg.startHandle !== undefined || seg.endHandle !== undefined);
}

/**
 * Command for traversing an edge that ends at `end`, honouring handle order and
 * traversal direction. A segment with either handle emits a cubic `C`; missing controls use the endpoint. Otherwise
 * (or for an implicit region edge with `seg === null`) a straight `L`.
 */
function edgeCommand(
  seg: VectorSegment | null,
  reversed: boolean,
  start: VectorVertex,
  end: VectorVertex,
): VectorPathCommand {
  if (seg && (seg.startHandle || seg.endHandle)) {
    const c1 = (reversed ? seg.endHandle : seg.startHandle) ?? start;
    const c2 = (reversed ? seg.startHandle : seg.endHandle) ?? end;
    return { kind: "C", c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x: end.x, y: end.y };
  }
  return { kind: "L", x: end.x, y: end.y };
}

function emitRegion(
  commands: VectorPathCommand[],
  verts: VectorVertex[],
  segments: VectorSegment[],
  used: Set<string>,
): void {
  const first = verts[0]!;
  commands.push({ kind: "M", x: first.x, y: first.y });
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const from = verts[i]!;
    const to = verts[(i + 1) % n]!;
    const match = segmentBetween(segments, from.id, to.id);
    if (match) used.add(match.seg.id);
    const seg = match ? match.seg : null;
    const reversed = match ? match.reversed : false;
    const isClosing = i === n - 1;
    // A straight closing edge is implied by `Z`; only emit it when curved.
    if (isClosing && !isCurve(seg)) continue;
    commands.push(edgeCommand(seg, reversed, from, to));
  }
  commands.push({ kind: "Z" });
}

type ChainEdge = { seg: VectorSegment; reversed: boolean; to: VectorVertex };

function walkChain(
  startVertexId: string,
  incident: Map<string, VectorSegment[]>,
  vertexById: Map<string, VectorVertex>,
  consumed: Set<string>,
): ChainEdge[] {
  const edges: ChainEdge[] = [];
  let currentId = startVertexId;
  for (;;) {
    const candidates = incident.get(currentId);
    if (!candidates) break;
    let next: VectorSegment | undefined;
    for (const seg of candidates) {
      if (!consumed.has(seg.id)) {
        next = seg;
        break;
      }
    }
    if (!next) break;
    consumed.add(next.id);
    const reversed = next.endVertexId === currentId;
    const otherId = reversed ? next.startVertexId : next.endVertexId;
    const other = vertexById.get(otherId);
    if (!other) break;
    edges.push({ seg: next, reversed, to: other });
    currentId = otherId;
  }
  return edges;
}

function emitSubpath(
  commands: VectorPathCommand[],
  start: VectorVertex,
  edges: ChainEdge[],
): void {
  if (edges.length === 0) return;
  commands.push({ kind: "M", x: start.x, y: start.y });
  const closed = edges[edges.length - 1]!.to.id === start.id;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const isClosing = closed && i === edges.length - 1;
    if (isClosing && !isCurve(edge.seg)) continue;
    commands.push(edgeCommand(edge.seg, edge.reversed, i === 0 ? start : edges[i - 1]!.to, edge.to));
  }
  if (closed) commands.push({ kind: "Z" });
}

/**
 * Convert a `VectorNetwork` to an ordered list of path commands. Regions become
 * closed subpaths (walked in declaration order, honouring segment handles and
 * traversal direction); remaining segments are walked into open/closed chains,
 * starting from endpoint vertices (degree 1) first for deterministic output,
 * then any leftover cycles.
 */
export function commandsFromVectorNetwork(network: VectorNetwork): VectorPathCommand[] {
  const commands: VectorPathCommand[] = [];
  const vertexById = new Map(network.vertices.map((v) => [v.id, v]));
  const used = new Set<string>();

  for (const region of network.regions) {
    const verts = region.vertexIds
      .map((id) => vertexById.get(id))
      .filter((v): v is VectorVertex => v !== undefined);
    if (verts.length < 2) continue;
    emitRegion(commands, verts, network.segments, used);
  }

  const remaining = network.segments.filter(
    (s) =>
      !used.has(s.id) &&
      vertexById.has(s.startVertexId) &&
      vertexById.has(s.endVertexId),
  );
  if (remaining.length > 0) {
    const incident = new Map<string, VectorSegment[]>();
    for (const seg of remaining) {
      for (const vid of [seg.startVertexId, seg.endVertexId]) {
        const list = incident.get(vid);
        if (list) list.push(seg);
        else incident.set(vid, [seg]);
      }
    }
    const consumed = new Set<string>();
    // Endpoints (degree 1) first, in vertex declaration order — open chains.
    for (const v of network.vertices) {
      const inc = incident.get(v.id);
      if (!inc || inc.length !== 1) continue;
      if (consumed.has(inc[0]!.id)) continue;
      emitSubpath(commands, v, walkChain(v.id, incident, vertexById, consumed));
    }
    // Any leftover segments form cycles — start from their declared start.
    for (const seg of remaining) {
      if (consumed.has(seg.id)) continue;
      const start = vertexById.get(seg.startVertexId);
      if (!start) continue;
      emitSubpath(commands, start, walkChain(start.id, incident, vertexById, consumed));
    }
  }

  return commands;
}

/** Serialize a `VectorNetwork` to an SVG path `d` string. */
export function pathDataFromVectorNetwork(network: VectorNetwork): string {
  return pathDataFromCommands(commandsFromVectorNetwork(network));
}

// ----- path-data parsing (for translating cached/opaque path strings) -----

/**
 * Parse an SVG path `d` string into absolute `M/L/C/Z` commands. Supports the
 * subset this app emits and typical cached paths: `M/m L/l H/h V/v C/c Z/z`
 * (relative commands are resolved to absolute; H/V become L; implicit repeated
 * coordinates after M/L/C are honoured). Returns `null` if an unsupported
 * command is encountered, so callers can fall back safely.
 */
export function parsePathData(d: string): VectorPathCommand[] | null {
  if (/(?:^|[A-Za-z])\s*,|,\s*(?:,|$|[A-Za-z])/.test(d)) return null;
  const tokens: string[] = [];
  const tokenPattern = /[\s,]*([A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/gy;
  let offset = 0;
  while (offset < d.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(d);
    if (!match) {
      if (d.slice(offset).trim().length === 0) break;
      return null;
    }
    tokens.push(match[1]!);
    offset = tokenPattern.lastIndex;
  }
  if (tokens.length === 0) return [];
  const commands: VectorPathCommand[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let cmd = "";
  const num = (): number | null => {
    const t = tokens[i];
    if (t === undefined) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    i++;
    return n;
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[MmLlHhVvCcZz]/.test(t)) {
      cmd = t;
      i++;
    } else if (cmd === "") {
      return null;
    }
    if (commands.length === 0 && cmd !== "M" && cmd !== "m") return null;
    switch (cmd) {
      case "M":
      case "m": {
        const x = num();
        const y = num();
        if (x === null || y === null) return null;
        cx = cmd === "m" ? cx + x : x;
        cy = cmd === "m" ? cy + y : y;
        startX = cx;
        startY = cy;
        commands.push({ kind: "M", x: cx, y: cy });
        cmd = cmd === "m" ? "l" : "L";
        break;
      }
      case "L":
      case "l": {
        const x = num();
        const y = num();
        if (x === null || y === null) return null;
        cx = cmd === "l" ? cx + x : x;
        cy = cmd === "l" ? cy + y : y;
        commands.push({ kind: "L", x: cx, y: cy });
        break;
      }
      case "H":
      case "h": {
        const x = num();
        if (x === null) return null;
        cx = cmd === "h" ? cx + x : x;
        commands.push({ kind: "L", x: cx, y: cy });
        break;
      }
      case "V":
      case "v": {
        const y = num();
        if (y === null) return null;
        cy = cmd === "v" ? cy + y : y;
        commands.push({ kind: "L", x: cx, y: cy });
        break;
      }
      case "C":
      case "c": {
        const c1x = num();
        const c1y = num();
        const c2x = num();
        const c2y = num();
        const x = num();
        const y = num();
        if (c1x === null || c1y === null || c2x === null || c2y === null || x === null || y === null) {
          return null;
        }
        const rel = cmd === "c";
        const a1x = rel ? cx + c1x : c1x;
        const a1y = rel ? cy + c1y : c1y;
        const a2x = rel ? cx + c2x : c2x;
        const a2y = rel ? cy + c2y : c2y;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        commands.push({ kind: "C", c1x: a1x, c1y: a1y, c2x: a2x, c2y: a2y, x: cx, y: cy });
        break;
      }
      case "Z":
      case "z": {
        commands.push({ kind: "Z" });
        cx = startX;
        cy = startY;
        // Z has no numeric arguments. A following number must not re-enter
        // this branch forever or be accepted as an implicit command.
        cmd = "";
        break;
      }
      default:
        return null;
    }
  }
  return commands;
}

// ----- geometry helpers (hit-testing + bounds) -----

/** Shortest distance from point (px,py) to the line segment (ax,ay)-(bx,by). */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cxp = ax + t * dx;
  const cyp = ay + t * dy;
  return Math.hypot(px - cxp, py - cyp);
}

function cubicPoint(
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Approximate distance from a point to a cubic Bézier by subdividing it into
 * `samples` line segments and taking the minimum point-to-segment distance.
 */
export function distanceToCubic(
  px: number,
  py: number,
  p0x: number,
  p0y: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  p3x: number,
  p3y: number,
  samples = 24,
): number {
  const steps = Math.max(1, Math.floor(samples));
  let prevX = p0x;
  let prevY = p0y;
  let min = Infinity;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = cubicPoint(t, p0x, c1x, c2x, p3x);
    const y = cubicPoint(t, p0y, c1y, c2y, p3y);
    const dist = distanceToSegment(px, py, prevX, prevY, x, y);
    if (dist < min) min = dist;
    prevX = x;
    prevY = y;
  }
  return min;
}

/**
 * Distance from a point to the nearest segment/curve in the network. Returns
 * `Infinity` when the network has no usable segments.
 */
export function distanceToNetwork(
  network: VectorNetwork,
  px: number,
  py: number,
): number {
  const vertexById = new Map(network.vertices.map((v) => [v.id, v]));
  let min = Infinity;
  for (const seg of network.segments) {
    const a = vertexById.get(seg.startVertexId);
    const b = vertexById.get(seg.endVertexId);
    if (!a || !b) continue;
    const dist =
      (seg.startHandle || seg.endHandle)
        ? distanceToCubic(
            px,
            py,
            a.x,
            a.y,
            (seg.startHandle ?? a).x,
            (seg.startHandle ?? a).y,
            (seg.endHandle ?? b).x,
            (seg.endHandle ?? b).y,
            b.x,
            b.y,
          )
        : distanceToSegment(px, py, a.x, a.y, b.x, b.y);
    if (dist < min) min = dist;
  }
  return min;
}

/** True when (px,py) lies within `tolerance` of any segment/curve. */
export function pointNearPath(
  network: VectorNetwork,
  px: number,
  py: number,
  tolerance: number,
): boolean {
  return distanceToNetwork(network, px, py) <= tolerance;
}

export type VectorBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * Axis-aligned bounds of the network. Includes vertices and Bézier control
 * points, so the box is conservative (a Bézier stays within the convex hull of
 * its control points). Returns `null` when there are no vertices.
 */
export function vectorNetworkBounds(network: VectorNetwork): VectorBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  const acc = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    seen = true;
  };
  for (const v of network.vertices) acc(v.x, v.y);
  for (const seg of network.segments) {
    if (seg.startHandle) acc(seg.startHandle.x, seg.startHandle.y);
    if (seg.endHandle) acc(seg.endHandle.x, seg.endHandle.y);
  }
  if (!seen) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Serialize a stroke dash array to an SVG `stroke-dasharray` value. Non-finite
 * or negative entries are dropped; returns `null` when nothing usable remains.
 */
export function dashArrayToString(dash: number[]): string | null {
  const usable = dash.filter((n) => Number.isFinite(n) && n >= 0);
  if (usable.length === 0) return null;
  return usable.map((n) => formatNumber(n)).join(" ");
}
