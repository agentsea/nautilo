/** Strict presentation of the one bounded connected-website save action. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { apiClient } from "../../../lib/api";
import type { ConnectedWebAccountActionActivity } from "@nautilo/types";
import { deriveBrowserCryptoDeviceId } from "@nautilo/lattice-bridge/client/browser";
import { useAuth } from "../../../hooks/use-auth";
import { readOrCreateBrowserCryptoInstallationId } from "../../../lib/browser-crypto-installation";
import { currentClientActionSessionIdForResume } from "../../../lib/client-action-session";
import { requestWebsiteConnection } from "../../../adapters/website-connection-intent";
import { WEBSITE_CATALOGUE } from "../../../lib/website-catalogue";
import type {
  ConnectedWebActionAttention,
  ConnectedWebActionResumeFailed,
} from "../../../adapters/connected-web-action-attention";
import type { ToolRenderer, ToolRendererProps } from "./types";

type ActionSuccess = Readonly<{ ok: true; status: "completed"; account: { id: string; label: string; service: string; origin: string }; action: "save_item"; target: string; receipt: { executionRef: string; effectState: "observed"; postcondition: string; evidenceCode: string; cost: { amountUsd: number | null; state: "actual" | "unknown" } } }>;
type ActionFailure = Readonly<{ ok: false; code: "unavailable" | "not_found" | "ambiguous_account" | "not_connected" | "reconnect_required" | "authentication_required" | "cancelled" | "failed" | "provider_unavailable" | "invalid_result" | "ambiguous" | "idempotency_conflict" | "approval_required"; recovery: "connect" | "reconnect" | "none" }>;
type ActionResult = ActionSuccess | ActionFailure;
const FAILURE_CODES = new Set<ActionFailure["code"]>(["unavailable", "not_found", "ambiguous_account", "not_connected", "reconnect_required", "authentication_required", "cancelled", "failed", "provider_unavailable", "invalid_result", "ambiguous", "idempotency_conflict", "approval_required"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
function boundedText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function safeCanonicalOrigin(value: unknown): value is string {
  if (!boundedText(value, 2_048)) return false;
  try {
    const origin = new URL(value);
    return (origin.protocol === "http:" || origin.protocol === "https:")
      && !origin.username && !origin.password && !origin.search && !origin.hash
      && origin.origin === value;
  } catch { return false; }
}
function validAccount(value: unknown): value is { id: string; label: string; service: string; origin: string } {
  return record(value) && exact(value, ["id", "label", "service", "origin"])
    && typeof value.id === "string" && UUID.test(value.id)
    && boundedText(value.label, 256) && boundedText(value.service, 128)
    && safeCanonicalOrigin(value.origin);
}
function validIntervention(value: unknown): boolean {
  return record(value) && exact(value, ["kind", "mode", "reason", "account"])
    && value.kind === "authentication_required" && value.mode === "reconnect"
    && (value.reason === "reconnect" || value.reason === "sign_in" || value.reason === "mfa" || value.reason === "captcha")
    && validAccount(value.account);
}
function parse(raw: string | undefined): ActionResult | null {
  if (!raw?.trim()) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || typeof value.ok !== "boolean") return null;
    if (value.ok === false) {
      const auth = value.code === "authentication_required";
      if (!(auth ? exact(value, ["ok", "code", "recovery", "intervention"]) && value.recovery === "reconnect" && validIntervention(value.intervention) : exact(value, ["ok", "code", "recovery"])) || typeof value.code !== "string" || !FAILURE_CODES.has(value.code as ActionFailure["code"]) || !["connect", "reconnect", "none"].includes(String(value.recovery))) return null;
      return { ok: false, code: value.code as ActionFailure["code"], recovery: value.recovery as ActionFailure["recovery"] };
    }
    if (!exact(value, ["ok", "status", "account", "action", "target", "receipt"]) || value.status !== "completed" || value.action !== "save_item" || !validAccount(value.account) || !record(value.receipt)) return null;
    const account = value.account; const receipt = value.receipt;
    if (!exact(receipt, ["executionRef", "effectState", "postcondition", "evidenceCode", "cost"]) || !record(receipt.cost)
      || !boundedText(value.target, 1_024) || receipt.effectState !== "observed"
      || !boundedText(receipt.executionRef, 128) || !boundedText(receipt.postcondition, 2_048) || !boundedText(receipt.evidenceCode, 128)
      || !exact(receipt.cost, ["amountUsd", "state"]) || (receipt.cost.state !== "actual" && receipt.cost.state !== "unknown")
      || (receipt.cost.state === "actual" && (typeof receipt.cost.amountUsd !== "number" || !Number.isFinite(receipt.cost.amountUsd) || receipt.cost.amountUsd < 0)) || (receipt.cost.state === "unknown" && receipt.cost.amountUsd !== null)) return null;
    return { ok: true, status: "completed", action: "save_item", target: value.target, account: { id: account.id, label: account.label, service: account.service, origin: account.origin }, receipt: { executionRef: receipt.executionRef, effectState: "observed", postcondition: receipt.postcondition, evidenceCode: receipt.evidenceCode, cost: { amountUsd: receipt.cost.amountUsd as number | null, state: receipt.cost.state } } };
  } catch { return null; }
}

const STAGE: Record<ConnectedWebAccountActionActivity["stage"], string> = { starting: "Starting the protected action…", planning: "Preparing the requested save…", browsing: "Saving the item on the website…", saving: "Checking the saved item…", finishing: "Finishing the action…" };
function terminalLine(terminal: ConnectedWebAccountActionActivity["terminal"]): string | null { return terminal === "cancelled" ? "Stopped. The save action was cancelled." : terminal === "ambiguous" ? "The save may or may not have completed. It was not retried." : terminal === "failed" ? "The save action failed before it could be confirmed." : terminal === "authentication_required" ? "Sign-in is required before this save can continue." : terminal === "completed" ? "Completed." : null; }

function catalogueFor(selector: string) {
  const normalized = selector.trim().toLocaleLowerCase("en-US");
  let hostname: string | null = null;
  try {
    const parsed = new URL(selector);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) hostname = parsed.hostname.toLocaleLowerCase("en-US");
  } catch { /* service labels are also valid selectors */ }
  return WEBSITE_CATALOGUE.find((website) => {
    const start = new URL(website.startUrl);
    return website.id.toLocaleLowerCase("en-US") === normalized
      || website.displayName.toLocaleLowerCase("en-US") === normalized
      || start.origin.toLocaleLowerCase("en-US") === normalized
      || start.hostname.toLocaleLowerCase("en-US") === normalized
      || (hostname !== null && (start.hostname.toLocaleLowerCase("en-US") === hostname || website.relatedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))));
  }) ?? null;
}

function safeConnectionUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch { return false; }
}

function useForegroundResumeCryptoBinding() {
  const auth = useAuth();
  return useCallback(() => {
    if (typeof window === "undefined" || auth.viewer.sessionUserId === null || auth.viewer.sessionActorId === null) return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({ serverScope: window.location.origin, userId: auth.viewer.sessionUserId, humanActorId: auth.viewer.sessionActorId });
    if (installationId === null) return undefined;
    const clientActionSessionId = currentClientActionSessionIdForResume();
    if (clientActionSessionId === undefined) return undefined;
    return {
      clientActionSessionId,
      authorizationDeviceId: deriveBrowserCryptoDeviceId({ serverScope: window.location.origin, userId: auth.viewer.sessionUserId, humanActorId: auth.viewer.sessionActorId, installationId }),
    };
  }, [auth.viewer.sessionActorId, auth.viewer.sessionUserId]);
}

function AuthenticationAttentionCard({
  attention,
  args,
  event,
}: {
  attention: ConnectedWebActionAttention;
  args: ToolRendererProps["args"];
  event: ToolRendererProps["event"];
}): ReactElement {
  const currentCryptoBinding = useForegroundResumeCryptoBinding();
  const [state, setState] = useState<"ready" | "opening" | "replying" | "done_pending" | "cancel_pending" | "error">("ready");
  const replyingRef = useRef(false);
  const intervention = attention.intervention;
  const catalogue = intervention.mode === "connect" ? catalogueFor(intervention.target.selector) : null;
  const label = intervention.mode === "reconnect" ? intervention.account.label : catalogue?.displayName ?? intervention.target.selector;
  const canOpen = intervention.mode === "reconnect" || catalogue !== null || safeConnectionUrl(intervention.target.selector);
  useEffect(() => {
    replyingRef.current = false;
    setState("ready");
  }, [attention.revision]);
  const reply = useCallback((decision: "done" | "cancel") => {
    const cryptoBinding = currentCryptoBinding();
    if (replyingRef.current || !cryptoBinding) {
      if (!cryptoBinding) setState("error");
      return;
    }
    replyingRef.current = true;
    setState("replying");
    void apiClient.replyConnectedWebActionAttention({ threadId: attention.threadId, laneKey: attention.laneKey, toolCallId: attention.toolCallId, decision }, cryptoBinding)
      // The HTTP response admits a background resume; it is not terminal
      // action truth. Canonical tool.end or a private resume-failed event owns
      // the final UI state.
      .then(() => setState(decision === "done" ? "done_pending" : "cancel_pending"))
      .catch(() => { replyingRef.current = false; setState("error"); });
  }, [attention.laneKey, attention.threadId, attention.toolCallId, currentCryptoBinding]);
  const open = useCallback(() => {
    if (!canOpen) return;
    if (!currentCryptoBinding()) {
      setState("error");
      return;
    }
    setState("opening");
    const onFinished = (outcome: "done" | "cancelled") => reply(outcome === "done" ? "done" : "cancel");
    const opened = intervention.mode === "reconnect"
      ? requestWebsiteConnection({ kind: "reconnect", accountId: intervention.account.id, onFinished })
      : catalogue
        ? requestWebsiteConnection({ kind: "catalogue", websiteId: catalogue.id, onFinished })
        : requestWebsiteConnection({ kind: "custom", url: intervention.target.selector, onFinished });
    if (!opened) setState("error");
  }, [canOpen, catalogue, currentCryptoBinding, intervention, reply]);
  const detail = intervention.mode === "reconnect" && intervention.reason === "mfa"
    ? "This account needs verification before Nautilo can continue the exact save."
    : intervention.mode === "reconnect" && intervention.reason === "captcha"
      ? "This website needs a Human check before Nautilo can continue the exact save."
      : "Sign in directly in Nautilo’s protected browser, then choose Done.";
  if (state === "done_pending") {
    return <RunningActionCard args={args} event={event} resumePending />;
  }
  return <div className="space-y-2 border-t border-border px-3 py-3">
    <p className="text-sm font-medium text-foreground">Sign in to {label}</p>
    <p className="text-xs text-foreground-muted">{detail}</p>
    {state === "cancel_pending" ? <p className="text-xs text-foreground-muted" role="status">Cancellation requested. Waiting for Nautilo to confirm that this save will not continue.</p> : <>
      {state === "error" ? <p className="text-xs text-tool-error" role="alert">Sign-in could not continue this save. Try again or cancel the save.</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!canOpen || state === "opening" || state === "replying"} onClick={open} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60">{state === "opening" ? "Waiting for sign-in…" : `Sign in to ${label}`}</button>
        <button type="button" disabled={state === "replying"} onClick={() => reply("cancel")} className="rounded-md border border-border px-3 py-2 text-xs font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-60">{state === "replying" ? "Cancelling…" : "Cancel save"}</button>
      </div>
    </>}
    {!canOpen ? <p className="text-xs text-foreground-muted">Connect this website from Connections, then try the save again.</p> : null}
  </div>;
}
function RunningActionCard({
  args,
  event,
  resumePending = false,
  resumeFailure,
}: Pick<ToolRendererProps, "args" | "event"> & { readonly resumePending?: boolean; readonly resumeFailure?: ConnectedWebActionResumeFailed }): ReactElement {
  const currentCryptoBinding = useForegroundResumeCryptoBinding();
  const deliveryId = event?.toolCallId ?? null;
  const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : "the requested item";
  const [activity, setActivity] = useState<ConnectedWebAccountActionActivity | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [state, setState] = useState<"ready" | "watching" | "stopping" | "stopped" | "recovery_cancelling" | "recovery_pending" | "error">("ready");
  const controlEpoch = useRef(0);
  const terminalRef = useRef(false);
  const awaitingResumeRef = useRef(resumePending);
  useEffect(() => {
    // A later failure event is a fresh server-authored recovery revision. It
    // must re-enable the one exact Cancel control after a prior attempt was
    // accepted but failed in the background.
    if (resumeFailure) setState("ready");
  }, [resumeFailure]);
  useEffect(() => {
    if (!deliveryId || resumeFailure) return;
    terminalRef.current = false;
    awaitingResumeRef.current = resumePending;
    controlEpoch.current++;
    let alive = true; let timer: ReturnType<typeof setTimeout> | null = null;
    const finishTerminal = (next: ConnectedWebAccountActionActivity): void => {
      terminalRef.current = true;
      controlEpoch.current++;
      setActivity(next);
      setLiveUrl(null);
      setState(next.terminal === "cancelled" ? "stopped" : "ready");
    };
    const poll = async (): Promise<void> => {
      if (terminalRef.current) return;
      try {
        const next = await apiClient.getConnectedWebAccountActionActivity(deliveryId);
        if (!alive || terminalRef.current) return;
        if (next.terminal === "authentication_required" && awaitingResumeRef.current) {
          // The HTTP reply is acknowledged before the background graph has
          // rotated the parked ledger. Keep polling instead of freezing on
          // the deliberately stale authentication receipt.
          setActivity(null);
        } else if (next.terminal !== null) {
          finishTerminal(next);
          return;
        } else {
          awaitingResumeRef.current = false;
          setActivity(next);
        }
        if (!next.canWatch) {
          controlEpoch.current++;
          setLiveUrl(null);
        }
      } catch { /* the ledger may not be committed yet */ }
      if (alive && !terminalRef.current) timer = setTimeout(() => void poll(), 1_000);
    };
    void poll(); return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [deliveryId, resumeFailure, resumePending]);
  const watch = useCallback(async () => { if (!deliveryId || terminalRef.current) return; const epoch = ++controlEpoch.current; setState("watching"); try { const watched = await apiClient.watchConnectedWebAccountAction(deliveryId); if (epoch !== controlEpoch.current || terminalRef.current) return; setLiveUrl(watched.liveViewUrl); setState("ready"); } catch { if (epoch === controlEpoch.current && !terminalRef.current) setState("error"); } }, [deliveryId]);
  const stop = useCallback(async () => { if (!deliveryId || terminalRef.current) return; controlEpoch.current++; setState("stopping"); try { const stopped = await apiClient.stopConnectedWebAccountAction(deliveryId); if (stopped.terminal !== null) { terminalRef.current = true; controlEpoch.current++; } setActivity(stopped); setLiveUrl(null); setState(stopped.terminal === "cancelled" ? "stopped" : "ready"); } catch { if (!terminalRef.current) setState("error"); } }, [deliveryId]);
  const recoverByCancelling = useCallback(() => {
    if (!resumeFailure || resumeFailure.cancelRecovery !== "available"
      || state === "recovery_cancelling" || state === "recovery_pending") return;
    const cryptoBinding = currentCryptoBinding();
    if (!cryptoBinding) {
      setState("error");
      return;
    }
    setState("recovery_cancelling");
    void apiClient.replyConnectedWebActionAttention({
      threadId: resumeFailure.threadId,
      laneKey: resumeFailure.laneKey,
      toolCallId: resumeFailure.toolCallId,
      decision: "cancel",
    }, cryptoBinding)
      .then(() => setState("recovery_pending"))
      .catch(() => setState("error"));
  }, [currentCryptoBinding, resumeFailure, state]);
  const statusLine = resumeFailure
    ? state === "recovery_pending"
      ? "Cancellation requested. Waiting for Nautilo to close the exact parked save."
      : resumeFailure.cancelRecovery === "available"
        ? "Nautilo could not safely resume or cancel this save. The original save remains parked and will not be retried."
        : "Nautilo could not safely resume or cancel this save, and exact recovery is unavailable. This save will not be retried."
    : terminalLine(activity?.terminal ?? null) ?? STAGE[activity?.stage ?? "starting"];
  return <div className="space-y-3 border-t border-border px-3 py-3">
    <div><p className="text-sm font-medium text-foreground">Saving {target}</p><p className={`mt-1 text-xs ${resumeFailure ? "text-tool-error" : "text-foreground-muted"}`} role={resumeFailure ? "alert" : "status"}>{statusLine}</p><p className="mt-1 text-xs text-foreground-dim">Nautilo can only save this named item; it cannot make purchases, send messages, post, upload, delete, or change account settings.</p></div>
    {resumeFailure?.cancelRecovery === "available"
      ? <div className="flex flex-wrap gap-2"><button type="button" onClick={recoverByCancelling} disabled={state === "recovery_cancelling" || state === "recovery_pending"} className="rounded border border-tool-error/60 px-2 py-1 text-xs font-medium text-tool-error disabled:cursor-not-allowed disabled:opacity-50">{state === "recovery_cancelling" ? "Cancelling…" : state === "recovery_pending" ? "Cancellation requested" : "Cancel parked save"}</button></div>
      : resumeFailure
        ? null
        : <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void watch()} disabled={!deliveryId || !activity?.canWatch || state === "watching" || state === "stopping" || state === "stopped"} className="rounded border border-border px-2 py-1 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50">{state === "watching" ? "Opening live view…" : liveUrl ? "Refresh live view" : "Watch live"}</button><button type="button" onClick={() => void stop()} disabled={!deliveryId || !activity?.canStop || state === "stopping" || state === "stopped"} className="rounded border border-tool-error/60 px-2 py-1 text-xs font-medium text-tool-error disabled:cursor-not-allowed disabled:opacity-50">{state === "stopping" ? "Stopping…" : state === "stopped" ? "Stopped" : activity?.terminal === "ambiguous" ? "Stop unconfirmed" : "Stop"}</button></div>}
    {state === "error" ? <p className="text-xs text-tool-error" role="alert">{resumeFailure ? "The cancellation request did not respond. You can try Cancel parked save again." : "The action control did not respond. This card will keep checking the action."}</p> : null}
    {liveUrl ? <section className="overflow-hidden rounded-md border border-border bg-black" aria-label="Live browser"><div className="flex items-center justify-between border-b border-border bg-background px-3 py-2"><p className="text-xs font-medium text-foreground">Live browser</p><button type="button" onClick={() => setLiveUrl(null)} className="text-xs text-foreground-muted">Hide</button></div><iframe title="Live browser" src={liveUrl} tabIndex={-1} className="pointer-events-none aspect-video w-full border-0" referrerPolicy="no-referrer" /></section> : null}
  </div>;
}
function failureMessage(result: ActionFailure): string { switch (result.code) { case "cancelled": return "Stopped. The save action was cancelled."; case "ambiguous": return "The save may or may not have completed. It was not retried."; case "failed": return "The save action failed before it could be confirmed."; case "authentication_required": return "Sign-in is required before this save can continue."; case "not_connected": return "Connect this website before saving an item."; case "reconnect_required": return "Reconnect this website before saving an item."; case "approval_required": return "This save needs your confirmation before it can run."; default: return "This save action could not be completed."; } }
function Expanded({ resultText, resultTruncated, args, event, state }: ToolRendererProps): ReactElement {
  if (event?.connectedWebActionAttention && (state === "pending" || state === "running" || state === "blocked")) {
    return <AuthenticationAttentionCard attention={event.connectedWebActionAttention} args={args} event={event} />;
  }
  if (event?.connectedWebActionResumeFailed) {
    return <RunningActionCard args={args} event={event} resumeFailure={event.connectedWebActionResumeFailed} />;
  }
  if (!resultText?.trim() && (state === "pending" || state === "running")) return <RunningActionCard args={args} event={event} />;
  if (resultTruncated) return <div className="border-t border-border px-3 py-2 text-xs text-tool-error">This save result was truncated and cannot be confirmed.</div>;
  const result = parse(resultText);
  if (!result) return <div className="border-t border-border px-3 py-2 text-xs text-tool-error">This save result could not be displayed safely.</div>;
  if (!result.ok) return <div className="border-t border-border px-3 py-2 text-xs text-tool-error">{failureMessage(result)}</div>;
  return <div className="space-y-2 border-t border-border px-3 py-3"><p className="text-sm font-medium text-tool-success">Completed</p><p className="text-xs text-foreground">Saved {result.target} on {result.account.label}.</p><p className="text-xs text-foreground-muted">Verified: {result.receipt.postcondition}</p></div>;
}
export const connectedWebAccountActionRenderer: ToolRenderer = { displayName: "Connected website save", sealedResultParser: true, autoExpandWhileRunning: true, collapseOnTerminalResult: true, collapsedSummary: ({ resultText, resultTruncated, state }) => { if (resultTruncated === true) return "Result could not be confirmed"; const result = parse(resultText); return !result && (state === "running" || state === "pending") ? "Saving item" : result?.ok ? "Completed" : result && !result.ok ? failureMessage(result) : "Connected website save"; }, stateOverride: ({ resultText, resultTruncated }) => { if (resultTruncated === true) return "error"; const result = parse(resultText); return result?.ok ? "success" : result?.ok === false ? result.code === "cancelled" ? "cancelled" : result.code === "authentication_required" ? "blocked" : "error" : null; }, ExpandedBody: Expanded };
