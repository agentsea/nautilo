import { createElement, useState, type ReactElement, type SyntheticEvent } from "react";
import { useNavigate } from "react-router-dom";
import { parseGenieRecoveryResultV1, type GenieRecoveryRequirement, type GenieRecoveryResultV1 } from "@nautilo/types";
import { useAuth } from "../../hooks/use-auth";
import { desktopAPI, isDesktop } from "../../lib/desktop";
import { readWorkbenchTheme } from "../../lib/genie-soft-prompt";
import {
  presentWorkbenchApplicationTarget,
  resolveWorkbenchApplicationTarget,
} from "../../lib/genie-application-targets";

function direct(toolName: string, parsed: GenieRecoveryResultV1): boolean {
  const { target, requirement, domainTool } = parsed.recovery;
  if (toolName === "google_workspace") return target === "connections.google" && requirement === "login" && domainTool === toolName;
  if (toolName === "launch_customization") return target === "genie.customization" && requirement === "human_enablement" && domainTool === toolName;
  if (toolName === "task" || toolName === "in_background") return target === "connections.codex" && domainTool === toolName && (["human_enablement", "login", "desktop"] as GenieRecoveryRequirement[]).includes(requirement);
  return false;
}

function sshRecovery(value: unknown): GenieRecoveryResultV1 | null {
  if (!Array.isArray(value)) return null;
  const recovered = value.filter((row): row is { name: string; recovery: unknown } => Boolean(row && typeof row === "object" && "recovery" in row));
  if (!recovered.length) return null;
  const valid: GenieRecoveryResultV1[] = [];
  const names = new Set(["structured_ssh_auth", "structured_ssh_exec", "structured_ssh_copy_upload", "structured_ssh_copy_download"]);
  for (const row of recovered) {
    try {
      const parsed = parseGenieRecoveryResultV1(row.recovery);
      if (!names.has(row.name) || parsed.recovery.target !== "connections.ssh" || parsed.recovery.requirement !== "pin" || parsed.recovery.domainTool !== row.name) return null;
      valid.push(parsed);
    } catch { return null; }
  }
  const first = valid[0];
  return valid.every((item) => item.text === first.text && item.recovery.target === first.recovery.target && item.recovery.requirement === first.recovery.requirement) ? first : null;
}

export function parseGenieRecoveryToolResult(toolName: string, resultText: string | undefined): GenieRecoveryResultV1 | null {
  if (!resultText) return null;
  try {
    const value = JSON.parse(resultText) as unknown;
    if (toolName === "discover_tools") return sshRecovery(value);
    const parsed = parseGenieRecoveryResultV1(value);
    return direct(toolName, parsed) ? parsed : null;
  } catch { return null; }
}

export function GenieRecoveryAction({ recovery, stopParent }: { recovery: GenieRecoveryResultV1; stopParent: (event: SyntheticEvent) => void }): ReactElement | null {
  const auth = useAuth();
  const navigate = useNavigate();
  const [fallback, setFallback] = useState<string | null>(null);
  const availability = {
    isVerified: auth.viewer?.isVerified ?? true,
    capabilities: auth.viewer?.capabilities ?? [],
    isDesktopShell: isDesktop && desktopAPI !== null,
  };
  const target = resolveWorkbenchApplicationTarget(
    { version: recovery.version, target: recovery.recovery.target, presentation: "reveal" },
    undefined,
    availability,
  );
  if (target.kind !== "supported") return null;
  const open = () => {
    void presentWorkbenchApplicationTarget({
      version: recovery.version,
      target: recovery.recovery.target,
      presentation: "reveal",
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
  return createElement(
    "div",
    { className: "mt-2 rounded border border-border bg-background-panel p-2", "data-testid": "genie-recovery-action" },
    createElement("p", { className: "text-xs text-foreground-muted" }, recovery.text),
    createElement("button", { type: "button", className: "mt-2 text-xs font-medium text-primary hover:underline", onClick: (event: SyntheticEvent) => { stopParent(event); open(); }, onKeyDown: stopParent }, `Open ${target.value.definition.label}`),
    fallback ? createElement("p", { role: "alert", className: "mt-2 text-xs text-foreground-muted" }, fallback) : null,
  );
}
