import type {
  MiniAppConversionImportDto,
  PublicMiniAppDto,
} from "@nautilo/api-client/browser";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { hasNautiloDocumentManifest, htmlMatchesContentAssociation } from "../lib/nautilo-document-html";

export interface AppAssociationMatch {
  app: PublicMiniAppDto;
  reason: "extension" | "mimeType" | "content";
}

/** M205 — a file matched to an app's declared import conversion action. */
export interface AppImportActionMatch {
  app: PublicMiniAppDto;
  action: MiniAppConversionImportDto;
}

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeMimeType(mime: string): string {
  return mime.trim().toLowerCase();
}

function normalizedAssociations(
  app: PublicMiniAppDto,
): { extensions: string[]; mimeTypes: string[] } | null {
  const fa = app.fileAssociations;
  if (fa == null) return null;

  const extensions = (fa.extensions ?? [])
    .map(normalizeExtension)
    .filter((ext) => ext.length > 0);
  const mimeTypes = (fa.mimeTypes ?? [])
    .map(normalizeMimeType)
    .filter((mime) => mime.length > 0);

  if (extensions.length === 0 && mimeTypes.length === 0) return null;
  return { extensions, mimeTypes };
}

/** Compound extension candidates from a path, most-specific first. */
export function extensionCandidatesForPath(path: string): string[] {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const basename = (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
  const dot = basename.indexOf(".");
  if (dot < 0 || dot === basename.length - 1) {
    return [];
  }

  const parts = basename.split(".");
  const candidates: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const ext = `.${parts.slice(i).join(".")}`;
    if (ext.length > 1) {
      candidates.push(ext);
    }
  }
  return candidates;
}

function matchesExtension(
  associations: { extensions: string[]; mimeTypes: string[] },
  file: OpenFileTarget,
): boolean {
  const candidates = extensionCandidatesForPath(file.path);
  if (candidates.length === 0) return false;
  const declared = new Set(associations.extensions);
  return candidates.some((candidate) => declared.has(candidate));
}

function matchesMimeType(
  associations: { extensions: string[]; mimeTypes: string[] },
  file: OpenFileTarget,
): boolean {
  if (file.kind !== "artifact") return false;
  const mime = normalizeMimeType(file.mimeType);
  if (!mime) return false;
  return associations.mimeTypes.includes(mime);
}

export function isHtmlAssociationCandidate(file: OpenFileTarget): boolean {
  const path = file.path.toLowerCase();
  if (path.endsWith(".html") || path.endsWith(".htm")) return true;
  if (file.kind === "artifact") {
    const mime = normalizeMimeType(file.mimeType);
    return mime === "text/html" || mime === "application/xhtml+xml";
  }
  return false;
}

export function appMatchesFile(
  app: PublicMiniAppDto,
  file: OpenFileTarget,
): AppAssociationMatch | null {
  if (app.status !== "ready") return null;
  // D343 — a disabled app stays installed but must not claim files.
  if (app.enabled === false) return null;

  const associations = normalizedAssociations(app);
  if (associations == null) return null;

  if (matchesExtension(associations, file)) {
    return { app, reason: "extension" };
  }

  if (file.kind === "artifact" && matchesMimeType(associations, file)) {
    return { app, reason: "mimeType" };
  }

  return null;
}

function appMatchesDeclaredContent(
  app: PublicMiniAppDto,
  file: OpenFileTarget,
  content: string | null | undefined,
): AppAssociationMatch | null {
  if (app.status !== "ready") return null;
  if (app.enabled === false) return null;
  if (!content || !isHtmlAssociationCandidate(file)) return null;
  if ((app.contentAssociations ?? []).some((assoc) => htmlMatchesContentAssociation(content, assoc))) {
    return { app, reason: "content" };
  }
  return null;
}

export function matchingReadyAppsForFile(
  apps: PublicMiniAppDto[],
  file: OpenFileTarget,
): AppAssociationMatch[] {
  const matches: AppAssociationMatch[] = [];
  for (const app of apps) {
    const match = appMatchesFile(app, file);
    if (match != null) {
      matches.push(match);
    }
  }
  return matches;
}

export function matchingReadyAppsForFileWithContent(
  apps: PublicMiniAppDto[],
  file: OpenFileTarget,
  content: string | null | undefined,
): AppAssociationMatch[] {
  // Native Nautilo documents are HTML containers, so `.html` and `text/html`
  // cannot establish app ownership. Resolve every app's declared embedded
  // content signature first. If any owner matches, it is authoritative and
  // broad metadata claimants are excluded — including for app-specific
  // manifest script types such as Nautilo Design's.
  if (content && isHtmlAssociationCandidate(file)) {
    const contentMatches = apps.flatMap((app) => {
      const match = appMatchesDeclaredContent(app, file, content);
      return match == null ? [] : [match];
    });
    if (contentMatches.length > 0) return contentMatches;

    // A generic native manifest without a currently installed owner must not
    // fall through to an unrelated app's broad HTML claim.
    if (hasNautiloDocumentManifest(content)) return [];
  }

  // Plain or unreadable HTML retains ordinary extension/MIME behavior. A
  // bounded-read failure therefore does not make generic HTML files unusable.
  return matchingReadyAppsForFile(apps, file);
}

/**
 * M205 — find every installed app whose `conversions.import[].from` matches this
 * file (by extension or, for artifacts, MIME). Distinct from "Open in …": this
 * powers the "Import to {app}" affordance and is independent of viewer support
 * (a `.docx` has no preview but is importable). A native Nautilo `.doc.html`
 * won't match here because its extension candidates are `.doc.html` / `.html`,
 * not `.docx`.
 */
export function matchingImportActionsForFile(
  apps: PublicMiniAppDto[],
  file: OpenFileTarget,
): AppImportActionMatch[] {
  const candidates = extensionCandidatesForPath(file.path);
  const mime = file.kind === "artifact" ? normalizeMimeType(file.mimeType) : "";
  const matches: AppImportActionMatch[] = [];
  for (const app of apps) {
    if (app.status !== "ready" || app.enabled === false) continue;
    for (const action of app.conversions?.import ?? []) {
      const extensions = (action.from.extensions ?? []).map(normalizeExtension);
      const mimeTypes = (action.from.mimeTypes ?? []).map(normalizeMimeType);
      const extMatch = candidates.length > 0 && candidates.some((c) => extensions.includes(c));
      const mimeMatch = mime.length > 0 && mimeTypes.includes(mime);
      if (extMatch || mimeMatch) {
        matches.push({ app, action });
      }
    }
  }
  return matches;
}
