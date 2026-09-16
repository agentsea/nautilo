import { useCallback, useEffect, useState } from "react";
import type { ClaudeConnectionSummary } from "@nautilo/types";
import { useAuth } from "../../hooks/use-auth";
import { apiClient } from "../../lib/api";
import { getDesktopRelayId } from "../../lib/desktop";
import { stableViewerKeyForStorage } from "../../rooms/room-navigation-storage";
import { Button, StatusPill } from "../settings/ui";
import { ConnectionDisclosureControl, useConnectionDisclosure } from "./connection-disclosure";

function statePill(summary: ClaudeConnectionSummary | null): { tone: "ok" | "warn" | "error" | "info" | "muted"; label: string } {
  if (!summary) return { tone: "info", label: "Checking" };
  if (summary.observationStale) return summary.connectionState === "reconnecting"
    ? { tone: "info", label: "Reconnecting" }
    : { tone: "muted", label: summary.enabled ? "Desktop unavailable" : "Disabled" };
  if (summary.runtime.state === "incompatible") return { tone: "warn", label: "Version not supported" };
  if (summary.runtime.state === "unavailable") return { tone: "warn", label: "Claude Code not found" };
  if (summary.runtime.state === "failure") return { tone: "error", label: "Couldn’t check Claude Code" };
  if (summary.account.state === "disconnected") return { tone: "warn", label: "Connect in Claude Code" };
  if (summary.account.state !== "connected" || summary.catalog.state !== "complete" || summary.catalog.models.length === 0) return { tone: "warn", label: "Models unavailable" };
  if (!summary.runtime.executionQualified) return { tone: "info", label: "Account detected" };
  return summary.selectedModelAdmitted ? { tone: "ok", label: "Ready" } : { tone: "info", label: "Choose a model" };
}

export function claudeSelectedProviderRowId(summary: ClaudeConnectionSummary): string {
  return summary.catalog.models.find((model) => (model.resolvedModel ?? model.id) === summary.selectedModel)?.id ?? "";
}
export function claudeModelPickerEnabled(summary: ClaudeConnectionSummary): boolean {
  return !summary.observationStale && summary.runtime.state === "ready" && summary.account.state === "connected" && summary.catalog.state === "complete" && summary.catalog.models.length > 0;
}

/** Friendly existing-account discovery. Claude owns login; Nautilo never asks for identity or credentials. */
export function ClaudeConnectionSection() {
  const auth = useAuth();
  const [summary, setSummary] = useState<ClaudeConnectionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disclosure = useConnectionDisclosure({ cardId: "claude", viewerKey: stableViewerKeyForStorage(auth.viewer), forceOpen: error !== null });
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const relayId = await getDesktopRelayId();
      setSummary(await apiClient.claudeConnections.summary(relayId));
      setError(null);
    } catch { setError("Nautilo could not check Claude Code on this desktop."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const toggle = async () => {
    if (!summary) return;
    setBusy(true);
    try { setSummary(await apiClient.claudeConnections.toggle(!summary.enabled, await getDesktopRelayId())); setError(null); }
    catch { setError("Nautilo could not update the Claude Code connection."); }
    finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true);
    try { setSummary(await apiClient.claudeConnections.checkAgain(await getDesktopRelayId())); setError(null); }
    catch { setError("Nautilo could not refresh Claude Code right now."); }
    finally { setBusy(false); }
  };
  const selectModel = async (modelId: string | null) => {
    setBusy(true);
    try { setSummary(await apiClient.claudeConnections.selectModel(modelId, await getDesktopRelayId())); setError(null); }
    catch { setError("That model is no longer available. Check again to refresh Claude Code."); }
    finally { setBusy(false); }
  };
  const pill = statePill(summary);
  const account = summary?.account;
  const providerName = account?.state === "connected" ? ({ firstParty: "Claude", bedrock: "Amazon Bedrock", vertex: "Google Vertex", foundry: "Azure AI Foundry", anthropicAws: "Amazon", anthropicGoogleCloud: "Google Cloud", mantle: "Managed provider", gateway: "Managed provider" } as const)[account.apiProvider ?? "firstParty"] : undefined;
  const accountText = account?.state === "connected"
    ? [account.email, account.organization, account.subscriptionType, providerName, account.credentialsAvailable ? "Claude Code credentials" : undefined].filter(Boolean).join(" · ")
    : account?.state === "disconnected" ? "Open Claude Code and sign in on this desktop, then Check again." : "Account availability has not been confirmed.";
  const pickerEnabled = summary ? claudeModelPickerEnabled(summary) : false;
  const selectedRowId = summary ? claudeSelectedProviderRowId(summary) : "";
  return <div id="claude" tabIndex={-1} className="rounded-lg border border-border bg-background-panel outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-labelledby="claude-connection-title">
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 id="claude-connection-title" className="text-sm font-medium text-foreground">Claude Code</h3><StatusPill tone={pill.tone}>{pill.label}</StatusPill></div><p className="mt-1 text-xs text-foreground-muted">Use the Claude Code account already connected on this desktop.</p></div>
      <div className="flex shrink-0 items-center gap-2"><ConnectionDisclosureControl expanded={disclosure.expanded} detailsId={disclosure.detailsId} onToggle={disclosure.toggle} /><button type="button" role="switch" aria-checked={summary?.enabled ?? false} aria-label={summary?.enabled ? "Disable Claude Code" : "Enable Claude Code"} disabled={!summary || busy} onClick={() => void toggle()} className={`relative inline-flex h-5 w-9 items-center rounded-full ${summary?.enabled ? "bg-[var(--success)]" : "bg-foreground-muted/40"} disabled:opacity-50`}><span className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${summary?.enabled ? "translate-x-4" : "translate-x-0.5"}`} /></button></div>
    </div>
    <div id={disclosure.detailsId} hidden={!disclosure.expanded} className="space-y-3 px-4 pb-4 text-sm">
      {error ? <p role="alert" className="text-[var(--error)]">{error}</p> : null}
      <dl className="grid gap-2 text-xs sm:grid-cols-[7rem_1fr]"><dt className="font-medium">Runtime</dt><dd className="text-foreground-muted">{summary?.runtime.state === "ready" ? `${summary.runtime.executionQualified ? "Ready for Claude Tasks" : "Detected for account setup"} · Claude Code ${summary.runtime.version}` : summary?.runtime.state === "incompatible" ? `Claude Code${summary.runtime.version ? ` ${summary.runtime.version}` : ""} could not be checked by this Nautilo build.` : summary?.runtime.state === "failure" ? "Couldn’t check Claude Code." : "Claude Code not found."}</dd><dt className="font-medium">Account</dt><dd className="text-foreground-muted">{accountText}</dd><dt className="font-medium">Genie</dt><dd className="text-foreground-muted">{summary?.enabled ? summary.runtime.state === "ready" && summary.runtime.executionQualified ? "Enabled" : "Enabled when this runtime is qualified" : "Disabled"}</dd></dl>
      {summary?.runtime.state === "ready" && !summary.runtime.executionQualified ? <p className="text-xs text-foreground-muted">Account and model setup work with this version. Claude Tasks remain unavailable until this runtime is qualified for execution. After updating Claude Code or Nautilo, use Check again.</p> : null}
      {summary?.observationStale && summary.observedAt ? <p className="text-xs text-foreground-dim">Last confirmed {new Date(summary.observedAt).toLocaleString()}. {summary.connectionState === "reconnecting" ? "Current desktop truth is being rechecked." : "Those retained facts are not currently confirmed. Open or bring Nautilo Desktop online, then Check again."}</p> : null}
      <label className="block text-xs font-medium">Model<select aria-label="Claude Code model" disabled={!pickerEnabled || busy} value={selectedRowId} onChange={(event) => void selectModel(event.target.value || null)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1 text-sm disabled:opacity-50"><option value="">Choose a model</option>{summary?.catalog.models.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.description}</option>)}</select></label>
      {summary?.selectedModel && !summary.selectedModelAdmitted ? <p className="text-xs text-foreground-dim">Your model choice is retained, but needs fresh execution-qualified runtime truth before it can be used.</p> : null}
      {summary?.catalog.state === "incomplete" ? <p className="text-xs text-foreground-muted">Claude Code returned a partial model list, so no model can be selected yet.</p> : null}
      <div className="flex justify-end"><Button variant="ghost" loading={busy} onClick={() => void check()}>Check again</Button></div>
    </div>
  </div>;
}
