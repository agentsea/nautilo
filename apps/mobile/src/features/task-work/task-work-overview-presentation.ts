import {
  sortTaskPresentationItems,
} from "@nautilo/types";

import type { TaskWorkRow, TaskWorkScope, TaskWorkViewState } from "./task-work-state";

const EDGE_GUTTER_PX = 20;
const MAX_DISPLAY_HIERARCHY_DEPTH = 2;

export type TaskWorkOverviewSectionId = "needs-you" | "working-paused" | "done";

/**
 * A row's canonical Task fields remain on `row`. Display ancestry is a
 * deliberately separate, disposable projection so malformed server ancestry
 * can never rewrite lifecycle truth or make a Mobile list unsafe to render.
 */
export interface TaskWorkOverviewDisplayRow {
  readonly row: TaskWorkRow;
  /**
   * Display-only parentage. It is present only for a valid, same-section
   * canonical relationship and must be the sole input for row connectors.
   */
  readonly displayParentTaskId: string | null;
  readonly displayDepth: number;
}

export interface TaskWorkOverviewSection {
  readonly id: TaskWorkOverviewSectionId;
  readonly title: "Needs you" | "Working / Paused" | "Done";
  /** Exact number of canonical overview rows allocated to this section. */
  readonly count: number;
  /** The bounded rows currently revealed by this section. */
  readonly rows: readonly TaskWorkOverviewDisplayRow[];
  /** Done remains countable even while its server-bounded rows are collapsed. */
  readonly collapsed?: boolean;
}

export interface TaskWorkOverviewProjection {
  /** This is derived only from canonical overview rows, never a parallel flag. */
  readonly empty: boolean;
  readonly totalCount: number;
  readonly sections: readonly [
    TaskWorkOverviewSection,
    TaskWorkOverviewSection,
    TaskWorkOverviewSection,
  ];
}

/**
 * Project the controller's canonical, bounded rows into the fixed Mobile
 * overview sections. The caller supplies the already-derived linger set only
 * to decide whether an errored terminal is still actionable; all row counts
 * and rendered membership come from `overviewRows` itself.
 */
export function projectTaskWorkOverview(input: {
  readonly overviewRows: readonly TaskWorkRow[];
  readonly newlyCompleted: readonly TaskWorkRow[];
  readonly doneExpanded?: boolean;
}): TaskWorkOverviewProjection {
  const freshErroredTaskIds = new Set(
    input.newlyCompleted
      .filter((row) => row.status === "errored")
      .map((row) => row.taskId),
  );
  const needsYou = input.overviewRows.filter((row) => row.status === "awaiting"
    || (row.status === "errored" && freshErroredTaskIds.has(row.taskId)));
  const workingPaused = input.overviewRows.filter((row) => row.status === "running" || row.status === "paused");
  // A fresh error belongs to Needs you exactly once. Older errors are bounded
  // terminal history alongside completed work.
  const done = input.overviewRows.filter((row) => row.status === "done"
    || (row.status === "errored" && !freshErroredTaskIds.has(row.taskId)));
  const doneExpanded = input.doneExpanded ?? false;

  return {
    empty: input.overviewRows.length === 0,
    totalCount: input.overviewRows.length,
    sections: [
      projectTaskWorkOverviewSection("needs-you", "Needs you", needsYou),
      projectTaskWorkOverviewSection("working-paused", "Working / Paused", workingPaused),
      projectTaskWorkOverviewSection("done", "Done", done, !doneExpanded),
    ],
  };
}

function projectTaskWorkOverviewSection(
  id: TaskWorkOverviewSectionId,
  title: TaskWorkOverviewSection["title"],
  rows: readonly TaskWorkRow[],
  collapsed = false,
): TaskWorkOverviewSection {
  return {
    id,
    title,
    count: rows.length,
    rows: collapsed ? [] : projectDisplayHierarchy(rows),
    ...(id === "done" ? { collapsed } : {}),
  };
}

/**
 * Preserve shared lifecycle/time/task-id ordering while making valid, same
 * lifecycle parentage readable. Every malformed relationship becomes a root:
 * this is intentionally display-only and cannot mutate the Task row itself.
 */
function projectDisplayHierarchy(rows: readonly TaskWorkRow[]): TaskWorkOverviewDisplayRow[] {
  const ordered = sortTaskPresentationItems(rows);
  const output: TaskWorkOverviewDisplayRow[] = [];

  for (const status of ["awaiting", "errored", "running", "paused", "done"] as const) {
    const band = ordered.filter((row) => row.status === status);
    output.push(...projectDisplayHierarchyBand(band));
  }
  return output;
}

/** One status band is the maximum hierarchy scope: lifecycle priority wins. */
function projectDisplayHierarchyBand(rows: readonly TaskWorkRow[]): TaskWorkOverviewDisplayRow[] {
  const indexesByTaskId = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const indexes = indexesByTaskId.get(row.taskId);
    if (indexes) indexes.push(index);
    else indexesByTaskId.set(row.taskId, [index]);
  });

  const parentIndexes = rows.map((row, index) => {
    if (!isValidDisplayDepth(row.depth) || row.parentTaskId === null || row.parentTaskId === row.taskId) return null;
    const candidates = indexesByTaskId.get(row.parentTaskId);
    return candidates?.length === 1 && candidates[0] !== index ? candidates[0] : null;
  });
  const validity = new Array<"unvisited" | "visiting" | "valid" | "invalid">(rows.length).fill("unvisited");

  const isValidAncestry = (index: number): boolean => {
    const current = validity[index];
    if (current === "valid") return true;
    if (current === "invalid" || current === "visiting") return false;
    validity[index] = "visiting";
    const row = rows[index];
    const parentIndex = parentIndexes[index];
    const valid = row.parentTaskId === null
      ? row.depth === 0
      : parentIndex !== null
        && isValidAncestry(parentIndex)
        && row.depth === rows[parentIndex].depth + 1;
    validity[index] = valid ? "valid" : "invalid";
    return valid;
  };

  const children = rows.map((): number[] => []);
  const roots: number[] = [];
  rows.forEach((_row, index) => {
    const parentIndex = parentIndexes[index];
    if (parentIndex !== null && isValidAncestry(index)) children[parentIndex].push(index);
    else roots.push(index);
  });

  const output: TaskWorkOverviewDisplayRow[] = [];
  const pending = roots.slice().reverse().map((index) => ({
    index,
    displayDepth: 0,
    displayParentTaskId: null as string | null,
  }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    output.push({
      row: rows[current.index],
      displayParentTaskId: current.displayParentTaskId,
      displayDepth: current.displayDepth,
    });
    for (let childOffset = children[current.index].length - 1; childOffset >= 0; childOffset -= 1) {
      const childIndex = children[current.index][childOffset];
      pending.push({
        index: childIndex,
        displayParentTaskId: rows[current.index].taskId,
        displayDepth: Math.min(current.displayDepth + 1, MAX_DISPLAY_HIERARCHY_DEPTH),
      });
    }
  }
  return output;
}

function isValidDisplayDepth(depth: number): boolean {
  return Number.isInteger(depth) && depth >= 0;
}

export function taskWorkOverviewScopeKey(input: {
  roomId: string;
  serverUrl: string | null;
  scope: TaskWorkScope | null;
}): string | null {
  const { scope } = input;
  return scope && input.serverUrl
    ? `${input.roomId}\u0000${input.serverUrl}\u0000${scope.serverId}\u0000${scope.userId}\u0000${scope.actorId}\u0000${scope.viewerEpoch}`
    : null;
}

export function canOpenTaskWorkOverview(input: {
  isScreenFocused: boolean;
  scopeKey: string | null;
  view: TaskWorkViewState;
}): boolean {
  return input.isScreenFocused && input.scopeKey !== null && !input.view.selectors.quiet;
}

/** Quiet bounded history stays readable; only a genuinely empty dataset closes. */
export function shouldCloseTaskWorkOverview(view: TaskWorkViewState): boolean {
  return view.kind === "idle" || view.kind === "empty" || view.kind === "unsupported" || view.selectors.overviewRows.length === 0;
}

export type TaskWorkOverviewCloseReason = "explicit" | "teardown";

/** Only a same-scope, user-requested close may return accessibility focus to the strip. */
export function shouldRestoreTaskWorkStripFocus(input: {
  readonly reason: TaskWorkOverviewCloseReason;
  readonly openScopeKey: string | null;
  readonly currentScopeKey: string | null;
}): boolean {
  return input.reason === "explicit"
    && input.openScopeKey !== null
    && input.openScopeKey === input.currentScopeKey;
}

export type TaskWorkOverviewCloseAccessibilityAction = "focus-strip" | "announce-conversation" | "none";

/** A same-scope explicit close returns users to the strip when it remains visible. */
export function taskWorkOverviewCloseAccessibilityAction(input: {
  readonly reason: TaskWorkOverviewCloseReason;
  readonly openScopeKey: string | null;
  readonly currentScopeKey: string | null;
  readonly stripAvailable: boolean;
}): TaskWorkOverviewCloseAccessibilityAction {
  if (!shouldRestoreTaskWorkStripFocus(input)) return "none";
  return input.stripAvailable ? "focus-strip" : "announce-conversation";
}

/** Normal motion waits for the revealed panel; reduced motion may focus after layout. */
export function shouldFocusTaskWorkOverviewShell(input: {
  readonly stageHeight: number;
  readonly reducedMotion: boolean;
  readonly revealFinished: boolean;
  readonly alreadyFocused: boolean;
}): boolean {
  return input.stageHeight > 0
    && !input.alreadyFocused
    && (input.reducedMotion || input.revealFinished);
}

export function shouldCloseTaskWorkOverviewFromUpHandle(input: {
  dx: number;
  dy: number;
  startX: number;
  windowWidth: number;
}): boolean {
  return input.windowWidth > EDGE_GUTTER_PX * 2
    && input.startX > EDGE_GUTTER_PX
    && input.startX < input.windowWidth - EDGE_GUTTER_PX
    && input.dy <= -12
    && Math.abs(input.dy) >= Math.abs(input.dx) * 1.25;
}

/** Keeps browser Tab focus inside the currently mounted overview dialog. */
export function taskWorkOverviewTabWrap(input: {
  readonly focusableCount: number;
  readonly activeIndex: number;
  readonly shiftKey: boolean;
}): number | null {
  if (!Number.isInteger(input.focusableCount) || input.focusableCount <= 0) return null;
  if (input.activeIndex < 0 || input.activeIndex >= input.focusableCount) return input.shiftKey ? input.focusableCount - 1 : 0;
  if (input.shiftKey && input.activeIndex === 0) return input.focusableCount - 1;
  if (!input.shiftKey && input.activeIndex === input.focusableCount - 1) return 0;
  return null;
}
