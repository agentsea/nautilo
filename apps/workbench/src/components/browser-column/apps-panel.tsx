/**
 * Apps panel (D342) — dedicated left-column panel for Nautilo INSTALLED
 * mini-apps. Promoted out of the Artifacts browser column's middle tab into a
 * first-class rail panel (mode "apps"), symmetric with Artifacts / Rooms.
 *
 * Per-row affordances are deliberately slim. For document mini-apps that
 * declare workspace `createActions`, the primary inline button is the FIRST
 * create action's label (e.g. `New spreadsheet`, `New document`, `New deck`)
 * so the dogfood flow is "name a real file, then open it" rather than "open an
 * unbound runtime and figure out where the file lives". Raw unbound `Launch`
 * is still reachable as a secondary `⋯` overflow menu item
 * (`Launch without document`) for power users; it is not removed. Apps
 * without createActions keep `Launch` as the inline primary. The admin-only
 * `Edit source` also lives in the overflow menu so a row never renders three
 * full-text buttons wide. Launching an app maximizes the work surface — the
 * shell collapses this panel via the existing `setCollapsed("browser", true)`
 * path (see `openMiniApp`), and the Apps rail icon's collapsed `›` brings it
 * back. No launch-specific UI.
 *
 * Search uses the same matching rules as the expanded Apps page. Installation
 * is omitted until an actionable installation flow is available.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ArtifactDto, AppSourceTreeEntry, MiniAppCreateActionDto, PublicMiniAppDto } from "@nautilo/api-client/browser";
import { MoreHorizontal, Plus, Maximize2, Upload, Search } from "lucide-react";
import { useAuth } from "../../hooks/use-auth";
import { useRoomNavigation } from "../../contexts/room-navigation-context";
import { GuestPanel } from "../guest-panel";
import { filterApps } from "../../apps/apps-sort";
import { useInstalledApps } from "../../apps/use-installed-apps";
import { useWorkspaceArtifacts } from "../../artifacts/workspace-artifacts-provider";
import {
  isHtmlAssociationCandidate,
  matchingReadyAppsForFile,
  matchingReadyAppsForFileWithContent,
} from "../../apps/app-associations";
import { readFileTextForAssociation } from "../../apps/association-content-io";
import { apiClient } from "../../lib/api";
import { CollapsibleSection } from "../collapsible-section";
import { requestOpenMiniApp, supportsMiniAppPreview } from "../../adapters/open-mini-app-ref";
import { requestOpenAppSource } from "../../adapters/open-app-source-ref";
import { requestOpenOfficeDoc } from "../../adapters/open-office-doc-ref";
import { requestOpenAppsOverview, requestOpenAppDetail } from "../../adapters/open-apps-surface-ref";
import { AppIcon } from "../../apps/first-party-app-visuals";
import { artifactOpenFileTarget, fsOpenFileTarget, type OpenFileTarget } from "./open-file-target";
import { useBrowserColumn } from "./browser-column.context";
import { NewFileDialog } from "../new-file-dialog";
import { VideoAppIcon } from "../../apps/video-app-presentation";
import { buildNewEditablePath } from "../../editors/new-editable-path";
import { desktopAPI, isDesktop } from "../../lib/desktop";

const MAX_MATCHING_ARTIFACTS = 3;
const APP_GROUP_STORAGE_PREFIX = "nautilo.apps.group.expanded.v1";
const OTHER_APPS_GROUP_ID = "other-apps";

interface AppPanelGroup {
  id: string;
  title: string;
  order: number;
  defaultExpanded: boolean;
  apps: PublicMiniAppDto[];
}

function appDisplayName(app: PublicMiniAppDto): string {
  return app.name?.trim() || app.id;
}

function groupStorageKey(groupId: string): string {
  return `${APP_GROUP_STORAGE_PREFIX}:${groupId}`;
}

function appGroupId(app: PublicMiniAppDto): string {
  const raw = app.display?.groupId?.trim();
  return raw && raw.length > 0 ? raw : OTHER_APPS_GROUP_ID;
}

function appGroupTitle(app: PublicMiniAppDto): string {
  const raw = app.display?.groupName?.trim();
  return raw && raw.length > 0 ? raw : "Other Apps";
}

function groupApps(apps: PublicMiniAppDto[]): AppPanelGroup[] {
  const groups = new Map<string, AppPanelGroup>();
  for (const app of apps) {
    const id = appGroupId(app);
    const existing = groups.get(id);
    const next: AppPanelGroup =
      existing ??
      {
        id,
        title: appGroupTitle(app),
        order: app.display?.groupOrder ?? (id === OTHER_APPS_GROUP_ID ? 1000 : 500),
        defaultExpanded: app.display?.defaultCollapsed === true ? false : true,
        apps: [],
      };
    next.apps.push(app);
    groups.set(id, next);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      apps: [...group.apps].sort((a, b) => {
        const orderA = a.display?.appOrder ?? 500;
        const orderB = b.display?.appOrder ?? 500;
        if (orderA !== orderB) return orderA - orderB;
        return appDisplayName(a).localeCompare(appDisplayName(b));
      }),
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.title.localeCompare(b.title);
    });
}

type OfficeKind = "writer" | "calc" | "impress";

const OFFICE_KINDS: ReadonlyArray<{
  kind: OfficeKind;
  label: string;
  short: string;
  accept: string;
  extensions: readonly string[];
}> = [
  {
    kind: "writer",
    label: "Writer",
    short: "W",
    accept: ".doc,.docx,.odt,.rtf",
    extensions: [".doc", ".docx", ".odt", ".rtf"],
  },
  {
    kind: "calc",
    label: "Calc",
    short: "C",
    accept: ".xls,.xlsx,.ods,.csv",
    extensions: [".xls", ".xlsx", ".ods", ".csv"],
  },
  {
    kind: "impress",
    label: "Impress",
    short: "I",
    accept: ".ppt,.pptx,.odp",
    extensions: [".ppt", ".pptx", ".odp"],
  },
] as const;

function filterOfficeKinds(query: string) {
  const q = query.trim().toLowerCase();
  return OFFICE_KINDS.filter((entry) => `LibreOffice ${entry.label}`.toLowerCase().includes(q));
}

function formatAssociationSummary(app: PublicMiniAppDto): string {
  const fa = app.fileAssociations;
  const extensions = (fa?.extensions ?? []).map((ext) => ext.trim()).filter((ext) => ext.length > 0);
  if (extensions.length > 0) {
    return extensions.join(", ");
  }

  const mimeTypes = (fa?.mimeTypes ?? []).map((mime) => mime.trim()).filter((mime) => mime.length > 0);
  if (mimeTypes.length > 0) {
    return mimeTypes.join(", ");
  }

  const documentTypes = Array.from(
    new Set(
      (app.contentAssociations ?? [])
        .map((association) => association.match.documentType)
        .filter((documentType): documentType is string => typeof documentType === "string" && documentType.length > 0),
    ),
  );
  if (documentTypes.length > 0) {
    const labels = documentTypes.map(
      (documentType) => `${documentType.charAt(0).toUpperCase()}${documentType.slice(1)} documents`,
    );
    return `${labels.join(", ")} · verified manifest`;
  }

  return "No associations";
}

/**
 * D342 — only NON-ready states get a label. "Ready" is the default expected
 * state, so a permanent badge is noise; an enabled Launch button is the
 * readiness signal. Returns null for ready (render no badge).
 */
function notReadyStatusLabel(status: PublicMiniAppDto["status"]): string | null {
  switch (status) {
    case "ready":
      return null;
    case "invalid_manifest":
      return "Invalid manifest";
    case "needs_dependencies":
      return "Needs dependencies";
  }
}

function statusHelpText(status: PublicMiniAppDto["status"]): string | null {
  switch (status) {
    case "invalid_manifest":
      return "Fix the app manifest before launching.";
    case "needs_dependencies":
      return "Install app dependencies before launching.";
    default:
      return null;
  }
}

function supportedCreateActions(app: PublicMiniAppDto): MiniAppCreateActionDto[] {
  if (app.status !== "ready") return [];
  return (app.createActions ?? []).filter((action) =>
    action.targetSurfaces.includes("workspace") || action.targetSurfaces.includes("currentFolder"),
  );
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function extensionOfPath(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : "";
}

/**
 * Create actions declare the document filename convention through their
 * suggested default. Ordinary create actions preserve an explicit filename;
 * callers that require the declared compound suffix normalize to that suffix.
 */
export function createActionFilename(
  name: string,
  action: MiniAppCreateActionDto,
  requireDeclaredCompoundSuffix = false,
): string {
  const requested = name.trim();
  if (!requested) return requested;
  const suggested = basename(action.defaultFilename);
  const suffixStart = suggested.indexOf(".");
  const suffix = suffixStart > 0 && suffixStart < suggested.length - 1 ? suggested.slice(suffixStart) : "";
  if (!suffix) return requested;
  if (requested.toLowerCase().endsWith(suffix.toLowerCase())) {
    return requireDeclaredCompoundSuffix
      ? `${requested.slice(0, -suffix.length)}${suffix}`
      : requested;
  }
  if (!requireDeclaredCompoundSuffix && requested.includes(".")) return requested;
  // Compound document suffixes (for example `.video.html`) are part of the
  // app's create contract. A Human-entered generic final extension keeps its
  // basename and is replaced by that compound suffix.
  const compoundSuffix = suffix.indexOf(".", 1) > 0;
  const requestedStem = compoundSuffix && requested.toLowerCase().endsWith(".html")
    ? requested.slice(0, -".html".length)
    : requested;
  return `${requestedStem}${suffix}`;
}

function officeKindForPath(path: string): OfficeKind | null {
  const ext = extensionOfPath(path);
  for (const entry of OFFICE_KINDS) {
    if (entry.extensions.includes(ext)) return entry.kind;
  }
  return null;
}

function officeMimeForKind(kind: OfficeKind, fallback: string): string {
  if (fallback.length > 0) return fallback;
  switch (kind) {
    case "writer":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "calc":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "impress":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
}

function openOfficeArtifact(artifact: ArtifactDto, activeRoomId: string | null | undefined): void {
  requestOpenOfficeDoc({
    artifactId: artifact.id,
    displayName: basename(artifact.path),
    documentPath: artifact.path,
    ...(activeRoomId ? { roomId: activeRoomId } : {}),
  });
}

function sortSourceEntries(entries: AppSourceTreeEntry[]): AppSourceTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function AppSourceTree({
  appId,
  entries,
  loading,
  error,
}: {
  appId: string;
  entries: AppSourceTreeEntry[] | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <p className="mt-2 text-[10px] text-foreground-muted">Loading source tree…</p>;
  }
  if (error) {
    return <p className="mt-2 text-[10px] text-[var(--error)]">{error}</p>;
  }
  if (entries == null || entries.length === 0) {
    return <p className="mt-2 text-[10px] text-foreground-muted">No source files found.</p>;
  }

  return (
    <ul
      data-testid={`apps-panel-source-tree-${appId}`}
      className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border/70 bg-background-element/40 px-2 py-1.5"
    >
      {sortSourceEntries(entries).map((entry) => (
        <li key={entry.path} className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-foreground">
            {entry.kind === "directory" ? `${basename(entry.path)}/` : basename(entry.path)}
          </span>
          {entry.kind === "file" ? (
            <button
              type="button"
              data-testid={`apps-panel-source-file-${appId}-${entry.path}`}
              onClick={() => {
                requestOpenAppSource({ kind: "app-source", appId, path: entry.path });
              }}
              className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-[var(--primary-muted)]"
            >
              Edit
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type ArtifactMatchesByApp = ReadonlyMap<string, ReadonlySet<string>>;

interface ArtifactMatchState {
  authorityKey: string | null;
  matchesByApp: ArtifactMatchesByApp;
  verifiedHtmlMatchesByApp: ArtifactMatchesByApp;
}

function artifactMatchesEqual(a: ArtifactMatchesByApp, b: ArtifactMatchesByApp): boolean {
  if (a.size !== b.size) return false;
  for (const [appId, artifactIds] of a) {
    const otherArtifactIds = b.get(appId);
    if (otherArtifactIds == null || artifactIds.size !== otherArtifactIds.size) return false;
    for (const artifactId of artifactIds) {
      if (!otherArtifactIds.has(artifactId)) return false;
    }
  }
  return true;
}

function artifactTarget(
  artifact: ArtifactDto,
  activeRoomId: string | null | undefined,
): OpenFileTarget {
  return artifactOpenFileTarget({
    id: artifact.id,
    path: artifact.path,
    mimeType: artifact.mimeType,
    roomId: activeRoomId ?? undefined,
  });
}

function recordArtifactMatches(
  matchesByApp: Map<string, Set<string>>,
  artifactId: string,
  matches: ReturnType<typeof matchingReadyAppsForFile>,
): void {
  for (const { app } of matches) {
    const artifactIds = matchesByApp.get(app.id) ?? new Set<string>();
    artifactIds.add(artifactId);
    matchesByApp.set(app.id, artifactIds);
  }
}

function artifactAssociationAuthorityKey(
  apps: PublicMiniAppDto[] | null,
  activeRoomId: string | null | undefined,
): string | null {
  if (apps == null) return null;
  return JSON.stringify([
    activeRoomId ?? null,
    apps.map((app) => [
      app.id,
      app.status,
      app.enabled,
      app.sourceHash,
      app.fileAssociations,
      app.contentAssociations,
    ]),
  ]);
}

/**
 * D390's manifest-authoritative routing also applies to document rows in the
 * Apps panel. A bare `text/html` association is not enough to claim a native
 * Nautilo HTML document, so HTML candidates are bounded-read before they are
 * listed beneath an app. If that read fails, the shared matcher deliberately
 * falls back to the established extension/MIME behavior for unknown content.
 */
function useArtifactMatchesByApp(
  apps: PublicMiniAppDto[] | null,
  artifacts: ArtifactDto[] | null,
  activeRoomId: string | null | undefined,
): ArtifactMatchesByApp {
  const authorityKey = artifactAssociationAuthorityKey(apps, activeRoomId);
  const [matchState, setMatchState] = useState<ArtifactMatchState>({
    authorityKey: null,
    matchesByApp: new Map(),
    verifiedHtmlMatchesByApp: new Map(),
  });
  const matchStateRef = useRef(matchState);
  matchStateRef.current = matchState;

  useEffect(() => {
    let cancelled = false;
    const publishMatches = (
      next: ArtifactMatchesByApp,
      verifiedHtmlMatchesByApp: ArtifactMatchesByApp,
    ): void => {
      setMatchState((current) =>
        current.authorityKey === authorityKey &&
        artifactMatchesEqual(current.matchesByApp, next) &&
        artifactMatchesEqual(current.verifiedHtmlMatchesByApp, verifiedHtmlMatchesByApp)
          ? current
          : { authorityKey, matchesByApp: next, verifiedHtmlMatchesByApp },
      );
    };
    if (apps == null || artifacts == null) {
      publishMatches(new Map(), new Map());
      return () => {
        cancelled = true;
      };
    }

    const resolved = new Map<string, Set<string>>();
    const htmlCandidates: Array<{ artifact: ArtifactDto; target: OpenFileTarget }> = [];
    for (const artifact of artifacts) {
      const target = artifactTarget(artifact, activeRoomId);
      if (isHtmlAssociationCandidate(target)) {
        htmlCandidates.push({ artifact, target });
      } else {
        recordArtifactMatches(resolved, artifact.id, matchingReadyAppsForFile(apps, target));
      }
    }

    // Keep only previously verified HTML matches within the same room and app
    // authority while a changed artifact revision is being read. This avoids
    // removing and restoring a row for every document update without letting
    // an initial, failed, deleted, or cross-room candidate inherit a claim.
    const currentHtmlArtifactIds = new Set(htmlCandidates.map(({ artifact }) => artifact.id));
    const displayedResolved = new Map<string, Set<string>>();
    for (const [appId, artifactIds] of resolved) {
      displayedResolved.set(appId, new Set(artifactIds));
    }
    const carriedVerified = new Map<string, Set<string>>();
    const previousMatchState = matchStateRef.current;
    if (previousMatchState.authorityKey === authorityKey) {
      for (const [appId, artifactIds] of previousMatchState.verifiedHtmlMatchesByApp) {
        for (const artifactId of artifactIds) {
          if (!currentHtmlArtifactIds.has(artifactId)) continue;
          const carriedIds = carriedVerified.get(appId) ?? new Set<string>();
          carriedIds.add(artifactId);
          carriedVerified.set(appId, carriedIds);
          const resolvedIds = displayedResolved.get(appId) ?? new Set<string>();
          resolvedIds.add(artifactId);
          displayedResolved.set(appId, resolvedIds);
        }
      }
    }

    publishMatches(displayedResolved, carriedVerified);
    if (htmlCandidates.length === 0) return () => {
      cancelled = true;
    };

    void Promise.all(
      htmlCandidates.map(async ({ artifact, target }) => {
        let content: string | null = null;
        try {
          content = await readFileTextForAssociation(target);
        } catch {
          // A failed bounded read has no manifest evidence. The shared matcher
          // therefore retains normal metadata association semantics.
        }
        return {
          artifactId: artifact.id,
          verified: content != null,
          matches: matchingReadyAppsForFileWithContent(apps, target, content),
        };
      }),
    ).then((results) => {
      if (cancelled) return;
      const currentResolved = new Map<string, Set<string>>();
      for (const [appId, artifactIds] of resolved) {
        currentResolved.set(appId, new Set(artifactIds));
      }
      const verifiedHtmlMatches = new Map<string, Set<string>>();
      for (const { artifactId, matches, verified } of results) {
        recordArtifactMatches(currentResolved, artifactId, matches);
        if (verified) recordArtifactMatches(verifiedHtmlMatches, artifactId, matches);
      }
      publishMatches(currentResolved, verifiedHtmlMatches);
    });

    return () => {
      cancelled = true;
    };
  }, [apps, artifacts, activeRoomId, authorityKey]);

  return matchState.authorityKey === authorityKey ? matchState.matchesByApp : new Map();
}

function matchingArtifactTargets(
  app: PublicMiniAppDto,
  matchesByApp: ArtifactMatchesByApp,
  artifacts: ArtifactDto[] | null,
  activeRoomId: string | null | undefined,
): OpenFileTarget[] {
  if (app.status !== "ready" || artifacts == null) return [];
  const artifactIds = matchesByApp.get(app.id);
  if (artifactIds == null) return [];
  return artifacts
    .filter((artifact) => artifactIds.has(artifact.id))
    .map((artifact) => artifactTarget(artifact, activeRoomId));
}

/**
 * D372 — recent-docs port. Mirrors the D362 LibreOffice cards' "2 most-recent
 * matching workspace docs beneath the row" pattern for Nautilo Office (and any
 * other) mini-app rows: the matching workspace artifacts (via the shared
 * manifest-aware association matcher — NOT the Collabora `officeKindForPath`
 * extension map), sorted by `updatedAt` desc, capped to `limit`. Each entry
 * carries the `OpenFileTarget` so the row can open it through OUR mini-app open
 * path (`requestOpenMiniApp`), the same action the create-first rows use to
 * open an existing bound document. Reuses the shared room artifact view; it
 * does not fetch anything itself.
 */
function recentMatchingArtifacts(
  app: PublicMiniAppDto,
  matchesByApp: ArtifactMatchesByApp,
  artifacts: ArtifactDto[] | null,
  activeRoomId: string | null | undefined,
  limit: number,
): Array<{ artifact: ArtifactDto; target: OpenFileTarget }> {
  if (app.status !== "ready" || artifacts == null) return [];
  const artifactIds = matchesByApp.get(app.id);
  if (artifactIds == null) return [];
  const matched = artifacts
    .filter((artifact) => artifactIds.has(artifact.id))
    .map((artifact) => ({ artifact, target: artifactTarget(artifact, activeRoomId) }));
  matched.sort((a, b) => b.artifact.updatedAt.localeCompare(a.artifact.updatedAt));
  return matched.slice(0, limit);
}

const MAX_RECENT_ARTIFACTS = 2;

/**
 * D362/D372 — shared boxed "app card" chrome used by BOTH office suites
 * (LibreOffice full-compose cards and Nautilo Office / other mini-app cards) so
 * the two tiers render with one consistent treatment instead of two divergent
 * looks. Purely presentational: a `rounded-md border` box, an `h-7 w-7`
 * letter-icon tile, a title (with optional trailing badges), an actions row,
 * an optional body slot, and a recent-docs list beneath a divider. Behavior
 * (create/upload/open handlers) lives entirely in the callers' slots.
 */
function AppCard({
  short,
  title,
  titleTrailing,
  actions,
  recent,
  recentTestId,
  headerExtra,
  children,
  testId,
}: {
  short: ReactNode;
  title: string;
  titleTrailing?: ReactNode;
  actions?: ReactNode;
  recent?: ReactNode;
  recentTestId?: string;
  headerExtra?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="w-full rounded-md border border-border bg-background-element px-2 py-2"
      data-testid={testId}
    >
      {headerExtra}
      <div className="flex items-center gap-2 px-1 py-1">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-xs font-semibold">
          {short}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{title}</span>
          {titleTrailing}
        </div>
      </div>
      {actions ? <div className="mt-1.5 flex items-center gap-1">{actions}</div> : null}
      {children}
      {recent ? (
        <div
          data-testid={recentTestId}
          className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5"
        >
          {recent}
        </div>
      ) : null}
    </section>
  );
}

function OfficeSuiteSection({
  query,
  artifacts,
  activeRoomId,
  onArtifactCreated,
}: {
  query: string;
  artifacts: ArtifactDto[] | null;
  activeRoomId: string | null | undefined;
  onArtifactCreated?: (artifact: ArtifactDto) => void;
}) {
  const visibleKinds = filterOfficeKinds(query);
  const writerInputRef = useRef<HTMLInputElement | null>(null);
  const calcInputRef = useRef<HTMLInputElement | null>(null);
  const impressInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<OfficeKind | null>(null);
  const [creating, setCreating] = useState<OfficeKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = uploading !== null || creating !== null;
  const refs: Record<OfficeKind, RefObject<HTMLInputElement | null>> = {
    writer: writerInputRef,
    calc: calcInputRef,
    impress: impressInputRef,
  };

  const officeArtifacts = useMemo(() => {
    const rows: Record<OfficeKind, ArtifactDto[]> = { writer: [], calc: [], impress: [] };
    for (const artifact of artifacts ?? []) {
      const kind = officeKindForPath(artifact.path);
      if (kind) rows[kind].push(artifact);
    }
    for (const kind of OFFICE_KINDS.map((entry) => entry.kind)) {
      rows[kind].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return rows;
  }, [artifacts]);

  const uploadOfficeFile = async (kind: OfficeKind, file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    setUploading(kind);
    try {
      const created = await apiClient.createWorkspaceArtifact(file, {
        path: file.name,
        mimeType: officeMimeForKind(kind, file.type),
        roomId: activeRoomId ?? undefined,
      });
      onArtifactCreated?.(created);
      openOfficeArtifact(created, activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the office document.");
    } finally {
      setUploading(null);
      const input = refs[kind].current;
      if (input) input.value = "";
    }
  };

  const createBlankDoc = async (kind: OfficeKind): Promise<void> => {
    setError(null);
    setCreating(kind);
    try {
      const created = await apiClient.createBlankOfficeDoc(kind, {
        roomId: activeRoomId ?? undefined,
      });
      onArtifactCreated?.(created);
      openOfficeArtifact(created, activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the document.");
    } finally {
      setCreating(null);
    }
  };

  return (
    <section className="border-b border-border px-3 py-3" data-testid="apps-panel-office-suite">
      {/* D362 — LibreOffice now collapses via the same real CollapsibleSection as
          the Nautilo Office groups (was a static ▾ header). Distinct title +
          storage key keeps the tier clearly separate. */}
      <CollapsibleSection
        title="LibreOffice"
        count={visibleKinds.length}
        forceExpanded={query.trim().length > 0}
        storageKey={groupStorageKey("libreoffice")}
        defaultExpanded
        testId="apps-panel-group-libreoffice"
      >
        <div className="space-y-1">
          {visibleKinds.map((entry) => {
            const recent = officeArtifacts[entry.kind].slice(0, 2);
            return (
              <AppCard
                key={entry.kind}
                testId={`apps-panel-office-${entry.kind}`}
                short={entry.short}
                title={entry.label}
                headerExtra={
                  <input
                    ref={refs[entry.kind]}
                    type="file"
                    accept={entry.accept}
                    className="hidden"
                    onChange={(event) => void uploadOfficeFile(entry.kind, event.currentTarget.files?.[0])}
                  />
                }
                actions={
                  <>
                    <button
                      type="button"
                      onClick={() => void createBlankDoc(entry.kind)}
                      disabled={busy}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-60"
                      title={`New ${entry.label} document`}
                      data-testid={`apps-panel-office-new-${entry.kind}`}
                    >
                      <Plus aria-hidden="true" size={12} />
                      {creating === entry.kind ? "Creating…" : "New"}
                    </button>
                    <button
                      type="button"
                      onClick={() => refs[entry.kind].current?.click()}
                      disabled={busy}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      title={`Upload ${entry.label} document`}
                      data-testid={`apps-panel-office-upload-${entry.kind}`}
                    >
                      <Upload aria-hidden="true" size={12} />
                      {uploading === entry.kind ? "Uploading…" : "Upload"}
                    </button>
                  </>
                }
                recent={
                  recent.length > 0
                    ? recent.map((artifact) => (
                        <button
                          key={artifact.id}
                          type="button"
                          onClick={() => openOfficeArtifact(artifact, activeRoomId)}
                          className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
                          title={artifact.path}
                        >
                          {basename(artifact.path)}
                        </button>
                      ))
                    : null
                }
              />
            );
          })}
        </div>
      </CollapsibleSection>
      {error ? <p className="mt-2 text-[10px] text-[var(--error)]">{error}</p> : null}
    </section>
  );
}

/**
 * D342 — `⋯` overflow menu holding the secondary per-app actions
 * (create-actions + admin-only `Edit source` + raw unbound `Launch` when the
 * primary button is already a create action). Keeps the row itself to a single
 * inline primary. Closes on outside-click and Escape.
 */
function AppRowMenu({
  appId,
  enabled,
  toggling,
  createActions,
  canEditSource,
  sourceExpanded,
  onPickCreateAction,
  onToggleSource,
  onToggleEnabled,
}: {
  appId: string;
  enabled: boolean;
  toggling: boolean;
  createActions: MiniAppCreateActionDto[];
  canEditSource: boolean;
  sourceExpanded: boolean;
  onPickCreateAction: (action: MiniAppCreateActionDto) => void;
  onToggleSource: () => void;
  onToggleEnabled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Menu always renders: every app has at least Disable / Uninstall (D344;
  // disabled until the D343 install/lifecycle backend lands).
  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid={`apps-panel-menu-${appId}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-[26px] w-7 items-center justify-center rounded-md border border-border bg-background-element text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
      >
        <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div
          role="menu"
          data-testid={`apps-panel-menu-list-${appId}`}
          className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[10rem] overflow-hidden rounded-md border border-border bg-background-panel py-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            data-testid={`apps-panel-details-${appId}`}
            onClick={() => {
              requestOpenAppDetail(appId);
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
          >
            Details
          </button>
          {/* D372 — when the row's primary button is a create action, keep
              raw unbound Launch reachable here as a secondary menu action. */}
          {createActions.length > 0 ? (
            <button
              type="button"
              role="menuitem"
              data-testid={`apps-panel-launch-${appId}`}
              disabled={!enabled}
              title="Open the app runtime without binding a document"
              onClick={() => {
                requestOpenMiniApp(appId);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-[11px] text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Launch without document
            </button>
          ) : null}
          {createActions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              data-testid={`apps-panel-create-${appId}-${action.id}`}
              disabled={!enabled}
              onClick={() => {
                onPickCreateAction(action);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
          {canEditSource ? (
            <button
              type="button"
              role="menuitem"
              data-testid={`apps-panel-edit-source-${appId}`}
              onClick={() => {
                onToggleSource();
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
            >
              {sourceExpanded ? "Hide source" : "Edit source"}
            </button>
          ) : null}
          {/* D343 — enable/disable is live; uninstall still pending. */}
          <div className="my-1 border-t border-border/60" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            disabled={toggling}
            data-testid={`apps-panel-disable-${appId}`}
            title={enabled ? "Disable this app (stays installed)" : "Enable this app"}
            onClick={() => {
              onToggleEnabled();
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled
            data-testid={`apps-panel-uninstall-${appId}`}
            title="Uninstalling apps is coming soon"
            className="block w-full cursor-not-allowed px-3 py-1.5 text-left text-[11px] text-foreground-muted opacity-60"
          >
            Uninstall
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AppRow({
  app,
  matchesByApp,
  artifacts,
  activeRoomId,
  onOpenFile,
  onArtifactCreated,
  reload,
  currentFolderPath,
}: {
  app: PublicMiniAppDto;
  matchesByApp: ArtifactMatchesByApp;
  artifacts: ArtifactDto[] | null;
  activeRoomId: string | null | undefined;
  onOpenFile?: (target: OpenFileTarget) => void;
  onArtifactCreated?: (artifact: ArtifactDto) => void;
  reload: () => void;
  currentFolderPath: string | null;
}) {
  const isDisabled = app.enabled === false;
  const isReady = app.status === "ready";
  const [toggling, setToggling] = useState(false);
  const toggleEnabled = () => {
    setToggling(true);
    void apiClient
      .setMiniAppEnabled(app.id, isDisabled)
      .catch(() => undefined)
      .finally(() => {
        setToggling(false);
        reload();
      });
  };
  const statusLabel = notReadyStatusLabel(app.status);
  const helpText = statusHelpText(app.status);
  const canEditSource = app.canEditSource;
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [sourceEntries, setSourceEntries] = useState<AppSourceTreeEntry[] | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [createAction, setCreateAction] = useState<MiniAppCreateActionDto | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createDestination, setCreateDestination] = useState<"workspace" | "currentFolder">("workspace");
  const [createFolder, setCreateFolder] = useState<string | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const createPendingRef = useRef(false);
  const folderPickerPendingRef = useRef(false);
  const folderRequestRef = useRef(0);
  const beginCreate = (action: MiniAppCreateActionDto): void => {
    folderRequestRef.current += 1;
    setCreateDestination(action.targetSurfaces.includes("workspace") ? "workspace" : "currentFolder");
    setCreateFolder(currentFolderPath);
    setChoosingFolder(false);
    setCreateError(null);
    setCreateAction(action);
  };
  const matchingTargets = useMemo(
    () => matchingArtifactTargets(app, matchesByApp, artifacts, activeRoomId),
    [app, matchesByApp, artifacts, activeRoomId],
  );
  const recentDocs = useMemo(
    () => recentMatchingArtifacts(app, matchesByApp, artifacts, activeRoomId, MAX_RECENT_ARTIFACTS),
    [app, matchesByApp, artifacts, activeRoomId],
  );
  const createActions = useMemo(() => supportedCreateActions(app), [app]);
  const rootArtifactNames = useMemo(
    () => (artifacts ?? []).filter((artifact) => !artifact.path.includes("/")).map((artifact) => artifact.path),
    [artifacts],
  );
  const previewTargets = matchingTargets.slice(0, MAX_MATCHING_ARTIFACTS);
  const displayName = appDisplayName(app);
  const iconShort = <AppIcon appId={app.id} name={displayName} />;

  const validateCreateName = (name: string): string | null => {
    if (createDestination === "currentFolder" && !createFolder) return "Choose a Current Folder before creating the file.";
    const built = buildNewEditablePath({
      parentPath: createDestination === "currentFolder" ? createFolder ?? "" : "",
      name: createAction ? createActionFilename(name, createAction, app.id === "nautilo-video") : name,
      existingNames: createDestination === "workspace" ? rootArtifactNames : [],
    });
    return built.ok ? null : built.reason;
  };

  const runCreateAction = async (name: string): Promise<void> => {
    if (!createAction || createPendingRef.current) return;
    createPendingRef.current = true;
    setCreateBusy(true);
    setCreateError(null);
    const destination = createDestination;
    if (!createAction.targetSurfaces.includes(destination)) {
      setCreateError(`This app does not support creating files in ${destination === "workspace" ? "Workspace" : "Current Folder"}.`);
      createPendingRef.current = false;
      setCreateBusy(false);
      return;
    }
    const capturedFolder = destination === "currentFolder" ? createFolder : null;
    const built = buildNewEditablePath({
      parentPath: capturedFolder ?? "",
      name: createActionFilename(name, createAction, app.id === "nautilo-video"),
      existingNames: destination === "workspace" ? rootArtifactNames : [],
    });
    if (!built.ok) {
      setCreateError(built.reason);
      createPendingRef.current = false;
      setCreateBusy(false);
      return;
    }
    try {
      const template = await apiClient.getMiniAppCreateTemplate(app.id, createAction.id);
      if (destination === "currentFolder") {
        if (!desktopAPI || !capturedFolder) throw new Error("Choose a Current Folder before creating the file.");
        const currentFolder = await desktopAPI.currentFolder.getPath();
        if (currentFolder !== capturedFolder) throw new Error("Current Folder changed while the file was being prepared. Review the folder and try again.");
        const existing = await desktopAPI.fs.stat(built.path);
        if (existing.exists) throw new Error("A file with that name already exists in the selected folder.");
        // The host treats a null base as an exclusive create. Existing-file
        // updates require their exact SHA, so a race here still cannot overwrite.
        const result = await desktopAPI.fs.writeFile(built.path, template.content, { baseSha256: null });
        if (!result.ok) {
          if (result.code === "conflict") throw new Error("A file with that name already exists in the selected folder.");
          throw new Error(result.message ?? "Could not create file in the selected folder.");
        }
        const target = fsOpenFileTarget(built.path, capturedFolder);
        if (createAction.openAfterCreate !== false) requestOpenMiniApp(app.id, target);
        else onOpenFile?.(target);
        setCreateAction(null);
        return;
      }
      const file = new Blob([template.content], { type: template.mimeType });
      const created = await apiClient.createWorkspaceArtifact(file, {
        path: built.path,
        mimeType: template.mimeType,
        roomId: activeRoomId ?? undefined,
      });
      onArtifactCreated?.(created);
      const target = artifactOpenFileTarget({
        id: created.id,
        path: created.path,
        mimeType: created.mimeType,
        roomId: activeRoomId ?? undefined,
      });
      if (createAction.openAfterCreate !== false) {
        requestOpenMiniApp(app.id, target);
      } else {
        onOpenFile?.(target);
      }
      setCreateAction(null);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create file.");
    } finally {
      createPendingRef.current = false;
      setCreateBusy(false);
    }
  };

  useEffect(() => {
    if (!createAction || !isDesktop || !desktopAPI || !createAction.targetSurfaces.includes("currentFolder")) return;
    let cancelled = false;
    const request = ++folderRequestRef.current;
    void desktopAPI.currentFolder.getPath().then((path) => {
      if (!cancelled && request === folderRequestRef.current) setCreateFolder(path);
    }).catch((error: unknown) => {
      if (!cancelled && request === folderRequestRef.current) setCreateError(error instanceof Error ? error.message : "Could not read Current Folder.");
    });
    return () => { cancelled = true; };
  }, [createAction]);

  useEffect(() => {
    if (!sourceExpanded || !canEditSource) return;
    if (sourceEntries !== null) return;

    let cancelled = false;
    setSourceLoading(true);
    setSourceError(null);
    void (async () => {
      try {
        const { files } = await apiClient.listMiniAppSourceTree(app.id);
        if (!cancelled) {
          setSourceEntries(files);
        }
      } catch (err) {
        if (!cancelled) {
          setSourceError(err instanceof Error ? err.message : "Could not load source tree.");
          setSourceEntries([]);
        }
      } finally {
        if (!cancelled) {
          setSourceLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [app.id, canEditSource, sourceEntries, sourceExpanded]);

  const titleTrailing = (
    <>
      {app.version ? (
        <span className="shrink-0 text-[10px] text-foreground-muted">v{app.version}</span>
      ) : null}
      {statusLabel ? (
        <span
          data-testid={`apps-panel-status-${app.id}`}
          className="shrink-0 rounded-full border border-[var(--error)]/40 px-1.5 py-0.5 text-[10px] font-medium text-[var(--error)]"
        >
          {statusLabel}
        </span>
      ) : null}
      {isDisabled ? (
        <span
          data-testid={`apps-panel-disabled-badge-${app.id}`}
          className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted"
        >
          Disabled
        </span>
      ) : null}
    </>
  );

  const actions = (
    <>
      {/* D372 — for document mini-apps that declare workspace createActions,
          the primary inline button is the first create action's label (so the
          dogfood flow is "name + bind a real file", not "open an unbound
          runtime"). Apps without createActions keep the legacy `Launch`
          primary. Raw unbound Launch stays reachable for create-action apps
          via the overflow menu. No Upload button — that is a LibreOffice-only
          affordance. */}
      {createActions.length > 0 ? (
        <button
          type="button"
          data-testid={`apps-panel-create-primary-${app.id}`}
          disabled={!isReady || isDisabled}
          title={createActions[0]?.label}
          onClick={() => {
            const action = createActions[0];
            if (action) beginCreate(action);
          }}
          className="flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createActions[0]?.label ?? "New"}
        </button>
      ) : (
        <button
          type="button"
          data-testid={`apps-panel-launch-${app.id}`}
          disabled={!isReady || isDisabled}
          onClick={() => {
            requestOpenMiniApp(app.id);
          }}
          className="flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Launch
        </button>
      )}
      <AppRowMenu
        appId={app.id}
        enabled={!isDisabled}
        toggling={toggling}
        createActions={createActions}
        canEditSource={canEditSource}
        sourceExpanded={sourceExpanded}
        onPickCreateAction={beginCreate}
        onToggleSource={() => setSourceExpanded((prev) => !prev)}
        onToggleEnabled={toggleEnabled}
      />
    </>
  );

  return (
    <AppCard
      testId={`apps-panel-row-${app.id}`}
      short={app.id === "nautilo-video" ? <VideoAppIcon /> : iconShort}
      title={displayName}
      titleTrailing={titleTrailing}
      actions={actions}
      recentTestId={isReady && recentDocs.length > 0 ? `apps-panel-recent-${app.id}` : undefined}
      recent={
        isReady && recentDocs.length > 0
          ? recentDocs.map(({ artifact, target }) => (
              <button
                key={artifact.id}
                type="button"
                data-testid={`apps-panel-recent-open-${app.id}-${artifact.id}`}
                onClick={() => requestOpenMiniApp(app.id, target)}
                className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
                title={artifact.path}
              >
                {basename(artifact.path)}
              </button>
            ))
          : null
      }
    >
      {app.description?.trim() ? (
        <p
          data-testid={`apps-panel-description-${app.id}`}
          className="mt-1.5 text-[11px] leading-snug text-foreground-muted"
        >
          {app.description.trim()}
        </p>
      ) : null}
      <p
        data-testid={`apps-panel-associations-${app.id}`}
        className="mt-1 text-[10px] text-foreground-muted"
      >
        {formatAssociationSummary(app)}
      </p>
      {helpText ? (
        <p className="mt-1 text-[10px] text-foreground-muted">{helpText}</p>
      ) : null}
      {createError ? (
        <p className="mt-1 text-[10px] text-[var(--error)]">{createError}</p>
      ) : null}

      {canEditSource && sourceExpanded ? (
        <AppSourceTree
          appId={app.id}
          entries={sourceEntries}
          loading={sourceLoading}
          error={sourceError}
        />
      ) : null}

      {isReady && matchingTargets.length > 0 ? (
        <div
          data-testid={`apps-panel-matches-${app.id}`}
          className="mt-2 space-y-1 rounded-md border border-border/70 bg-background-element/40 px-2 py-1.5"
        >
          <p className="text-[10px] text-foreground-muted">
            {matchingTargets.length} matching workspace file
            {matchingTargets.length === 1 ? "" : "s"}
          </p>
          <ul className="space-y-1">
            {previewTargets.map((target) => (
              <li
                key={target.kind === "artifact" ? target.id : target.path}
                className="flex items-center justify-between gap-2"
              >
                <span className="min-w-0 truncate text-[11px] text-foreground">
                  {basename(target.path)}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {onOpenFile ? (
                    <button
                      type="button"
                      data-testid={`apps-panel-preview-${app.id}-${target.kind === "artifact" ? target.id : target.path}`}
                      onClick={() => {
                        if (supportsMiniAppPreview(app.id)) {
                          if (!requestOpenMiniApp(app.id, target, { mode: "preview" })) {
                            onOpenFile(target);
                          }
                          return;
                        }
                        onOpenFile(target);
                      }}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
                    >
                      Preview
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-testid={`apps-panel-open-${app.id}-${target.kind === "artifact" ? target.id : target.path}`}
                    onClick={() => {
                      requestOpenMiniApp(app.id, target);
                    }}
                    className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-[var(--primary-muted)]"
                  >
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {createAction ? (
        <NewFileDialog
          title={createAction.label}
          description={`Create a new ${displayName} document in ${createDestination === "workspace" ? "the current Workspace" : "the selected Current Folder"}.`}
          initialName={createAction.defaultFilename}
          validateName={validateCreateName}
          error={createError}
          busy={createBusy}
          onCancel={() => {
            folderRequestRef.current += 1;
            setCreateError(null);
            setCreateAction(null);
          }}
          onCreate={(name) => void runCreateAction(name)}
        >
          {isDesktop && createAction.targetSurfaces.includes("currentFolder") ? (
            <div className="mt-3 space-y-2 text-xs text-foreground">
              <fieldset disabled={createBusy} className="flex gap-4">
                <legend className="sr-only">Create location</legend>
                <label><input type="radio" name="create-location" checked={createDestination === "workspace"} onChange={() => { setCreateDestination("workspace"); setCreateError(null); }} /> Workspace</label>
                <label><input type="radio" name="create-location" checked={createDestination === "currentFolder"} onChange={() => { setCreateDestination("currentFolder"); setCreateError(null); }} /> Current Folder</label>
              </fieldset>
              {createDestination === "currentFolder" ? (
                <div>
                  <div className="break-all rounded border border-border bg-background-element px-2 py-1 font-mono" data-testid="apps-panel-create-folder">{createFolder ?? "No Current Folder selected"}</div>
                  <button type="button" disabled={createBusy || choosingFolder} className="mt-2 rounded border border-border px-2 py-1" onClick={() => {
                    if (!desktopAPI || folderPickerPendingRef.current) return;
                    folderPickerPendingRef.current = true;
                    setChoosingFolder(true);
                    const request = ++folderRequestRef.current;
                    void desktopAPI.currentFolder.pickAndCommit().then((path) => {
                      if (path && request === folderRequestRef.current) setCreateFolder(path);
                    }).catch((error: unknown) => {
                      if (request === folderRequestRef.current) setCreateError(error instanceof Error ? error.message : "Could not choose folder.");
                    }).finally(() => {
                      folderPickerPendingRef.current = false;
                      if (request === folderRequestRef.current) setChoosingFolder(false);
                    });
                  }}>{choosingFolder ? "Choosing…" : "Choose folder…"}</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </NewFileDialog>
      ) : null}
    </AppCard>
  );
}

interface AppsPanelProps {
  /** Wired by the shell to `panelSizes.setCollapsed("browser", true)` — the
   *  same hide path Artifacts/Rooms use. Chevron only renders when provided. */
  onCollapse?: () => void;
  onOpenFile?: (target: OpenFileTarget) => void;
}

export function AppsPanel({ onCollapse, onOpenFile }: AppsPanelProps = {}) {
  const [query, setQuery] = useState("");
  const auth = useAuth();
  const { activeRoomId } = useRoomNavigation();
  const appsState = useInstalledApps();
  const { currentFolderPath } = useBrowserColumn();
  const {
    artifacts: workspaceArtifacts,
    loading: artifactsLoading,
    upsertArtifact,
  } = useWorkspaceArtifacts();
  const artifacts = artifactsLoading ? null : workspaceArtifacts;
  const officeEnabled = auth.viewer.features?.office.enabled === true;

  const rememberCreatedArtifact = (artifact: ArtifactDto): void => {
    upsertArtifact(artifact);
  };

  return (
    <aside
      data-testid="apps-panel"
      className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-clip grid-rows-[auto_1fr] border-r border-border bg-background-panel"
    >
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">Apps</span>
          <div className="flex items-center gap-1">
            {/* D344 — open the full-width Apps page (overview/manager). */}
            <button
              type="button"
              data-testid="apps-panel-open-overview"
              onClick={() => requestOpenAppsOverview()}
              aria-label="Open full Apps page"
              title="Open full Apps page"
              className="flex items-center justify-center rounded-md border border-border px-2 py-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
            >
              <Maximize2 aria-hidden="true" className="h-3 w-3" />
            </button>
            {onCollapse ? (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Hide apps panel"
                title="Hide apps panel"
                className="flex shrink-0 items-center justify-center rounded-md px-2 py-1 text-sm leading-5 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
              >
                <span aria-hidden="true">‹</span>
              </button>
            ) : null}
          </div>
        </div>
        <div className="relative mt-2">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            data-testid="apps-panel-search"
            className="w-full min-w-0 rounded-md border border-border bg-background-element py-1.5 pl-7 pr-2 text-xs text-foreground outline-none focus:border-accent"
          />
        </div>
      </div>

      <div className="min-h-0 min-w-0 overflow-hidden">
        <AppsPanelBody
          query={query}
          appsState={appsState}
          artifacts={artifacts}
          activeRoomId={activeRoomId}
          isVerified={auth.viewer.isVerified}
          officeEnabled={officeEnabled}
          currentFolderPath={currentFolderPath}
          onOpenFile={onOpenFile}
          onArtifactCreated={rememberCreatedArtifact}
        />
      </div>
    </aside>
  );
}

function AppsPanelBody({
  query,
  appsState,
  artifacts,
  activeRoomId,
  isVerified,
  officeEnabled,
  currentFolderPath,
  onOpenFile,
  onArtifactCreated,
}: {
  query: string;
  appsState: ReturnType<typeof useInstalledApps>;
  artifacts: ArtifactDto[] | null;
  activeRoomId: string | null | undefined;
  isVerified: boolean;
  officeEnabled: boolean;
  currentFolderPath: string | null;
  onOpenFile?: (target: OpenFileTarget) => void;
  onArtifactCreated?: (artifact: ArtifactDto) => void;
}) {
  const matchesByApp = useArtifactMatchesByApp(
    isVerified && appsState.kind === "ready" ? appsState.apps : null,
    isVerified ? artifacts : null,
    activeRoomId,
  );

  if (!isVerified) {
    return <GuestPanel surface="Apps" verb="are" />;
  }

  if (appsState.kind === "loading") {
    return (
      <div className="p-3" data-testid="apps-panel-loading">
        <span className="text-xs text-foreground-muted">Loading apps…</span>
      </div>
    );
  }

  if (appsState.kind === "error") {
    return (
      <div
        data-testid="apps-panel-error"
        className="m-3 rounded-md border border-border bg-background-element p-3"
      >
        <p className="text-xs text-foreground-muted">{appsState.message}</p>
      </div>
    );
  }

  if (appsState.apps.length === 0 && !officeEnabled) {
    return (
      <div
        data-testid="apps-panel-empty"
        className="flex h-full flex-col items-center justify-center px-6 text-center"
      >
        <p className="text-xs text-foreground-muted">No apps installed yet.</p>
      </div>
    );
  }

  const visibleApps = filterApps(appsState.apps, query);
  const showOffice = officeEnabled && filterOfficeKinds(query).length > 0;
  if (visibleApps.length === 0 && !showOffice) {
    return (
      <p data-testid="apps-panel-no-matches" role="status" className="p-3 text-xs text-foreground-muted">
        No apps match “{query}”.
      </p>
    );
  }

  return (
    <div data-testid="apps-panel-list" className="h-full overflow-y-auto">
      {/* D362 — LibreOffice/Collabora office suite (Writer/Calc/Impress) with
          per-kind create/upload and recent-docs, gated on the office feature. */}
      {showOffice ? (
        <OfficeSuiteSection
          query={query}
          artifacts={artifacts}
          activeRoomId={activeRoomId}
          onArtifactCreated={onArtifactCreated}
        />
      ) : null}
      {/* D372 — Nautilo Office + other installed mini-apps, grouped by manifest
          display metadata (create-first rows, recent-docs beneath each row). */}
      {groupApps(visibleApps).map((group) => (
        <CollapsibleSection
          key={group.id}
          title={group.title}
          count={group.apps.length}
          storageKey={groupStorageKey(group.id)}
          defaultExpanded={group.defaultExpanded}
          forceExpanded={query.trim().length > 0}
          testId={`apps-panel-group-${group.id}`}
        >
          <div className="space-y-1 px-3 pb-2">
            {group.apps.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                matchesByApp={matchesByApp}
                artifacts={artifacts}
                activeRoomId={activeRoomId}
                onOpenFile={onOpenFile}
                onArtifactCreated={onArtifactCreated}
                reload={appsState.reload}
                currentFolderPath={currentFolderPath}
              />
            ))}
          </div>
        </CollapsibleSection>
      ))}
    </div>
  );
}
