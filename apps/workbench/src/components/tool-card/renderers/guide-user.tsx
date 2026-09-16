import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  parseGuideUserArgsV1,
  parseGuideUserResultV1,
  type GuideUserArgsV1,
  type GuideUserResultV1,
  type UiPresentation,
} from "@nautilo/types";
import { useAuth } from "../../../hooks/use-auth";
import { desktopAPI, isDesktop } from "../../../lib/desktop";
import {
  readWorkbenchTheme,
} from "../../../lib/genie-soft-prompt";
import {
  presentWorkbenchApplicationTarget,
  resolveWorkbenchApplicationPresentation,
  resolveWorkbenchApplicationTarget,
} from "../../../lib/genie-application-targets";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { useSetupStatus } from "../../../contexts/setup-status-context";

type ValidGuide =
  | { kind: "discovery"; args: Extract<GuideUserArgsV1, { query: string }>; result: Extract<GuideUserResultV1, { kind: "discovery" }> }
  | { kind: "guidance"; args: Extract<GuideUserArgsV1, { target: string }>; result: Extract<GuideUserResultV1, { kind: "guidance" }> };

const INVALID_GUIDANCE_COPY = "This saved guidance is no longer available. Use the visible Genie or Connections menus to continue.";

function parseGuide(args: Record<string, unknown>, resultText: string | undefined, result: unknown): ValidGuide | null {
  const rawResult = resultText ?? (typeof result === "string" ? result : null);
  if (!rawResult) return null;
  try {
    const parsedArgs = parseGuideUserArgsV1(args);
    const parsedResult = parseGuideUserResultV1(JSON.parse(rawResult) as unknown);
    if ("query" in parsedArgs) {
      return parsedResult.kind === "discovery" ? { kind: "discovery", args: parsedArgs, result: parsedResult } : null;
    }
    if (parsedResult.kind !== "guidance" || parsedResult.target !== parsedArgs.target) return null;
    const compatiblePresentation = parsedArgs.confirmed
      ? parsedResult.presentation === parsedArgs.presentation || parsedResult.presentation === "link"
      : parsedResult.presentation === "link";
    if (!compatiblePresentation) return null;
    return resolveWorkbenchApplicationTarget({
      version: parsedArgs.version,
      target: parsedResult.target,
    }).kind === "supported" ? { kind: "guidance", args: parsedArgs, result: parsedResult } : null;
  } catch {
    return null;
  }
}

function stopCardToggle(event: SyntheticEvent): void {
  event.stopPropagation();
}

function presentationLabel(presentation: UiPresentation): string {
  if (presentation === "spotlight") return "Show and highlight";
  if (presentation === "reveal") return "Show";
  return "Open";
}

function GuidanceBody({ guide }: { guide: Extract<ValidGuide, { kind: "guidance" }> }): ReactElement {
  const auth = useAuth();
  const setupStatus = useSetupStatus();
  const navigate = useNavigate();
  const [fallback, setFallback] = useState<string | null>(null);
  const availability = { isVerified: auth.viewer?.isVerified ?? true, capabilities: auth.viewer?.capabilities ?? [], isDesktopShell: isDesktop && desktopAPI !== null, isSelfManaged: setupStatus?.providers?.managedByCloud === false };
  const targetResolution = resolveWorkbenchApplicationPresentation({
    version: guide.args.version,
    target: guide.result.target,
    presentation: guide.result.presentation,
  }, undefined, availability);
  if (targetResolution.kind !== "supported") {
    return <div className="border-t border-border px-3 py-3 text-xs text-foreground-muted">{targetResolution.fallbackText}</div>;
  }
  const { label } = targetResolution.value.definition;

  const open = (): void => {
    void presentWorkbenchApplicationTarget({
      version: guide.args.version,
      target: guide.result.target,
      presentation: guide.result.presentation,
    }, {
      availability,
      navigate,
      customization: {
        hasDesktopBridge: isDesktop && desktopAPI !== null,
        onboardingOpen: desktopAPI?.onboarding.open,
        getAccessToken: () => auth.session.getAccessToken(),
        getTheme: () => readWorkbenchTheme((key) => {
          try { return localStorage.getItem(key); } catch { return null; }
        }),
      },
    }).then((result) => {
      if (result.kind === "unsupported") setFallback(result.fallbackText);
    });
  };

  return (
    <div className="space-y-2 border-t border-border px-3 py-3" data-testid="guide-user-guidance">
      <p className="text-xs text-foreground-muted">{guide.result.fallbackText}</p>
      <button
        type="button"
        className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white focus-visible:ring-2 focus-visible:ring-accent/60"
        onClick={(event) => { stopCardToggle(event); open(); }}
        onKeyDown={stopCardToggle}
      >
        {presentationLabel(targetResolution.presentation)} {label}
      </button>
      {fallback ? <p role="alert" className="text-xs text-foreground-muted">{fallback}</p> : null}
    </div>
  );
}

function GuideUserExpanded(props: ToolRendererProps): ReactElement {
  const auth = useAuth();
  const setupStatus = useSetupStatus();
  if (props.state === "running") {
    return <div className="border-t border-border px-3 py-3 text-xs text-foreground-muted">Guidance is still being prepared.</div>;
  }
  if (props.state !== "success" || props.resultTruncated) {
    return <div className="border-t border-border px-3 py-3 text-xs text-foreground-muted">{INVALID_GUIDANCE_COPY}</div>;
  }
  const guide = parseGuide(props.args, props.resultText, props.result);
  if (!guide) {
    return <div className="border-t border-border px-3 py-3 text-xs text-foreground-muted">{INVALID_GUIDANCE_COPY}</div>;
  }
  if (guide.kind === "guidance") return <GuidanceBody guide={guide} />;
  const availability = { isVerified: auth.viewer?.isVerified ?? true, capabilities: auth.viewer?.capabilities ?? [], isDesktopShell: isDesktop && desktopAPI !== null, isSelfManaged: setupStatus?.providers?.managedByCloud === false };
  const visibleTargets = guide.result.targets.filter((target) => resolveWorkbenchApplicationTarget({ version: guide.args.version, target: target.target }, undefined, availability).kind === "supported");
  if (visibleTargets.length === 0) {
    return <div className="border-t border-border px-3 py-3 text-xs text-foreground-muted" data-testid="guide-user-empty">No matching Nautilo destinations were found.</div>;
  }
  return (
    <div className="space-y-2 border-t border-border px-3 py-3" data-testid="guide-user-discovery">
      {visibleTargets.map((target) => (
        <section key={target.target} className="rounded border border-border px-3 py-2">
          <h3 className="text-xs font-semibold text-foreground">{target.label}</h3>
          <p className="mt-0.5 text-[0.7rem] text-foreground-dim">{target.menuPath.join(" › ")}</p>
          <p className="mt-1 text-xs text-foreground-muted">{target.description}</p>
        </section>
      ))}
    </div>
  );
}

export const guideUserRenderer: ToolRenderer = {
  displayName: "Guidance",
  collapsedSummary: () => "Nautilo guidance",
  autoExpandOnResult: true,
  ExpandedBody: GuideUserExpanded,
};
