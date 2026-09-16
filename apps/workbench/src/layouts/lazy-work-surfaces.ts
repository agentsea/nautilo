import { deploymentSafeLazy } from "../lib/deployment-safe-lazy";

// Each explicit import is a feature boundary. In particular, ReaderSurface is
// the sole runtime edge from the eager shell into the viewer registry and its
// PDF/Office/media adapters.
export const MiniAppSurface = deploymentSafeLazy(() =>
  import("../apps/mini-app-surface").then((module) => ({
    default: module.MiniAppSurface,
  })),
);

export const SaasAppSurface = deploymentSafeLazy(() =>
  import("../apps/saas-app-surface").then((module) => ({
    default: module.SaasAppSurface,
  })),
);

export const BrowserResearchSurface = deploymentSafeLazy(() =>
  import("../apps/browser-research-surface").then((module) => ({
    default: module.BrowserResearchSurface,
  })),
);

export const TerminalSurface = deploymentSafeLazy(() =>
  import("../apps/terminal-surface").then((module) => ({
    default: module.TerminalSurface,
  })),
);

export const OfficeDocSurface = deploymentSafeLazy(() =>
  import("../apps/office-doc-surface").then((module) => ({
    default: module.OfficeDocSurface,
  })),
);

export const AppsOverviewSurface = deploymentSafeLazy(() =>
  import("../apps/apps-overview-surface").then((module) => ({
    default: module.AppsOverviewSurface,
  })),
);

export const AppDetailSurface = deploymentSafeLazy(() =>
  import("../apps/app-detail-surface").then((module) => ({
    default: module.AppDetailSurface,
  })),
);

export const AppSourceEditorSurface = deploymentSafeLazy(() =>
  import("../apps/app-source-editor-surface").then((module) => ({
    default: module.AppSourceEditorSurface,
  })),
);

export const ReaderSurface = deploymentSafeLazy(() =>
  import("../components/work-surface/reader-surface").then((module) => ({
    default: module.ReaderSurface,
  })),
);

export const EditorSurface = deploymentSafeLazy(() =>
  import("../editors/editor-surface").then((module) => ({
    default: module.EditorSurface,
  })),
);
