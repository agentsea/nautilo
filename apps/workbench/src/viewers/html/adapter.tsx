import workbenchNwRuntime from "@nautilo/workbench-components/dist/runtime.js?raw";
import { desktopAPI } from "../../lib/desktop";
import { loadArtifactViewerBlob } from "../artifact-byte-source";
import { buildCsp } from "./csp";
import { SandboxedHtmlIframe } from "./iframe";
import { buildSrcdoc } from "./srcdoc";
import {
  renderWriterPreview,
  shouldInjectWriterPreviewHydration,
  writerPreviewHydrationScript,
} from "./writer-preview";
import type { ViewerAdapter } from "../types";
import { useCan } from "../../hooks/use-can";

/**
 * HTML preview cap. Sized to the office-document ceiling (50 MB) so native
 * Nautilo `.doc.html` documents — which embed inline base64 images and route
 * through this viewer — preview instead of hitting a too-large wall. Also
 * reused as the content-association sniff cap (`association-content-io.ts`) so
 * large native docs still match their "Open in {app}" association.
 */
export const HTML_VIEWER_MAX_BYTES = 50 * 1024 * 1024;

function pathLooksHtml(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".html") || p.endsWith(".htm") || p.endsWith(".nwx.html");
}

function artifactMimeIsHtml(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m === "text/html" || m === "application/xhtml+xml";
}

function HtmlViewerBody({ data }: { data: unknown }) {
  const can = useCan();
  const typed = data as {
    srcDoc: string;
    stateBridge?: { artifactId: string; roomId?: string };
  };
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SandboxedHtmlIframe
        srcDoc={typed.srcDoc}
        {...(typed.stateBridge
          ? { stateBridge: { ...typed.stateBridge, readOnly: !can("write_artifacts") } }
          : {})}
      />
    </div>
  );
}

function buildHtmlSrcdoc(htmlContent: string): string {
  const csp = buildCsp();
  const trustedScripts = shouldInjectWriterPreviewHydration(htmlContent)
    ? [writerPreviewHydrationScript()]
    : [];
  return buildSrcdoc(renderWriterPreview(htmlContent), csp, workbenchNwRuntime, trustedScripts);
}

export const htmlViewerAdapter: ViewerAdapter = {
  kind: "html",
  canView(file) {
    if (file.kind === "artifact") {
      if (artifactMimeIsHtml(file.mimeType)) return true;
      return pathLooksHtml(file.path);
    }
    return pathLooksHtml(file.path);
  },
  async load(file, ctx) {
    if (file.kind !== "fs" && file.kind !== "artifact") {
      return { kind: "error", message: "Invalid file target." };
    }

    if (file.kind === "artifact") {
      if (typeof file.mimeType !== "string" || file.mimeType.length === 0) {
        return { kind: "error", message: "Invalid file target." };
      }
      const blob = await loadArtifactViewerBlob(file, ctx, HTML_VIEWER_MAX_BYTES);
      if (blob.size > HTML_VIEWER_MAX_BYTES) {
        return { kind: "too_large", sizeBytes: blob.size, maxBytes: HTML_VIEWER_MAX_BYTES };
      }
      const htmlContent = await blob.text();
      const srcDoc = buildHtmlSrcdoc(htmlContent);
      // D121-P3 — state bridge is artifact-scoped. We bind the
      // artifact's internal row id (matches what the bridge passes
      // to apiClient.getArtifactState / setArtifactState — the
      // server resolves to the external artifactId internally).
      const stateBridge: { artifactId: string; roomId?: string } = {
        artifactId: file.id,
        ...(file.roomId !== undefined ? { roomId: file.roomId } : {}),
      };
      return { kind: "ready", data: { srcDoc, stateBridge } };
    }

    if (!desktopAPI) return { kind: "error", message: "Desktop file bridge unavailable." };
    const stat = await desktopAPI.fs.stat(file.path);
    if (!stat.exists) return { kind: "error", message: "File no longer exists." };
    if (stat.size > HTML_VIEWER_MAX_BYTES) {
      return { kind: "too_large", sizeBytes: stat.size, maxBytes: HTML_VIEWER_MAX_BYTES };
    }
    const htmlContent = await desktopAPI.fs.readFile(file.path);
    const srcDoc = buildHtmlSrcdoc(htmlContent);
    return { kind: "ready", data: { srcDoc } };
  },
  Component: HtmlViewerBody,
};
