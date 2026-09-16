/** D568 — strict Human-facing projection for a private connected-website read. */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { apiClient } from "../../../lib/api";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import { publishConnectedWebOperation, useConnectedWebOperation } from "./use-connected-web-operation";
import { connectedWebOperationTerminalReadResultSchema, publicBrowserReadActiveSchema, type PublicBrowserReadActive } from "@nautilo/types";
import type { ConnectedWebAccount, ConnectedWebActivityPage, ConnectedWebOperationProjection } from "@nautilo/types";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { subscribeConnectedWebAccountRefresh } from "../../../adapters/connected-web-account-refresh";
import { requestWebsiteConnection } from "../../../adapters/website-connection-intent";
import { sendOrdinaryRoomMessage } from "../../../lib/ordinary-room-message";
import { WEBSITE_CATALOGUE, type WebsiteCatalogueEntry } from "../../../lib/website-catalogue";
import { requestOpenFile } from "../../../adapters/open-file-ref";
import { artifactOpenFileTarget } from "../../browser-column/open-file-target";
import { ImageLightbox, Thumbnail, type LightboxImageRef } from "./image-lightbox";
import type { ToolRenderer, ToolRendererProps } from "./types";

type ConnectedPage = Readonly<{ ref: string; title: string; origin: string }>;
type ConnectedOutput = Readonly<{ artifactId: string; path: string; mime: string; bytes: number }>;
type ConnectedReadSuccess = Readonly<{
  ok: true;
  status: "completed";
  account: Readonly<{ id: string; label: string; service: string; origin: string }> | null;
  read: Readonly<{
    answer: string;
    facts: readonly Readonly<{ label: string; value: string }>[];
    completeness: "complete" | "partial" | "unknown";
    provenance: "authenticated_website" | "user_connected_website" | "public_website";
    origin: string;
  }> | null;
  cost: Readonly<{ currency: "USD"; amountUsd: number | null; state: "actual" | "unknown" }>;
  page: ConnectedPage;
  outputs: readonly ConnectedOutput[];
  outputsTruncated: boolean;
}>;
type ConnectedReadFailure = Readonly<{
  ok: false;
  code: "unavailable" | "not_found" | "ambiguous_account" | "not_connected" | "reconnect_required" | "authentication_required" | "cancelled" | "provider_unavailable" | "invalid_result";
  recovery: "retry" | "reconnect" | "connect" | "none";
  intervention?: ConnectedAuthenticationIntervention;
  continuation?: ConnectedReadContinuation;
}>;
type ConnectedReadContinuation = Readonly<{
  account: string;
  request: string;
  delivery: "text" | "workspace";
}>;
type ConnectedAuthenticationIntervention = Readonly<
  | { kind: "authentication_required"; mode: "connect"; reason: "not_connected"; target: Readonly<{ selector: string }> }
  | { kind: "authentication_required"; mode: "reconnect"; reason: "reconnect" | "sign_in" | "mfa" | "captcha"; account: Readonly<{ id: string; label: string; service: string; origin: string }> }
>;
type ConnectedReadResult = ConnectedReadSuccess | ConnectedReadFailure;
type ConnectedReadActive = Readonly<{
  ok: true;
  status: "active";
  account: Readonly<{ id: string; label: string; service: string; origin: string }>;
  operation: Readonly<{
    operationId: string;
    driver: "hosted";
    lifecycle: "running";
    controlEpoch: number;
    activity: Readonly<{ phase: "starting" | "working" | "checking" | "attention" | "finishing"; code: string; summary: string }>;
    receipt: null;
  }>;
}>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FAILURE_CODES = new Set<ConnectedReadFailure["code"]>([
  "unavailable", "not_found", "ambiguous_account", "not_connected", "reconnect_required", "authentication_required", "cancelled", "provider_unavailable", "invalid_result",
]);
const RECOVERIES = new Set<ConnectedReadFailure["recovery"]>(["retry", "reconnect", "connect", "none"]);
const MAX_OUTPUTS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function nonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function safePath(value: unknown): value is string {
  return nonEmptyString(value, 512) && !value.includes("\0") && !value.split(/[\\/]/u).includes("..");
}

function safeOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.search.length === 0
      && parsed.hash.length === 0
      && parsed.origin === value;
  } catch {
    return false;
  }
}

function safeConnectionUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

function parseOutput(value: unknown): ConnectedOutput | null {
  if (!isRecord(value) || !onlyKeys(value, ["artifactId", "path", "mime", "bytes"])) return null;
  if (!nonEmptyString(value["artifactId"], 256) || !safePath(value["path"])
    || !nonEmptyString(value["mime"], 256) || typeof value["bytes"] !== "number"
    || !Number.isSafeInteger(value["bytes"]) || value["bytes"] < 0) return null;
  return { artifactId: value["artifactId"], path: value["path"], mime: value["mime"], bytes: value["bytes"] };
}

function parseAuthenticationIntervention(value: unknown): ConnectedAuthenticationIntervention | null {
  if (!isRecord(value) || value["kind"] !== "authentication_required" || typeof value["mode"] !== "string") return null;
  if (value["mode"] === "connect") {
    if (!onlyKeys(value, ["kind", "mode", "reason", "target"]) || value["reason"] !== "not_connected"
      || !isRecord(value["target"]) || !onlyKeys(value["target"], ["selector"])
      || !nonEmptyString(value["target"]["selector"], 2_048)) return null;
    return { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector: value["target"]["selector"] } };
  }
  if (value["mode"] !== "reconnect" || !onlyKeys(value, ["kind", "mode", "reason", "account"])
    || !["reconnect", "sign_in", "mfa", "captcha"].includes(String(value["reason"]))
    || !isRecord(value["account"]) || !onlyKeys(value["account"], ["id", "label", "service", "origin"])) return null;
  const account = value["account"];
  if (!UUID_RE.test(String(account["id"])) || !nonEmptyString(account["label"], 256)
    || !nonEmptyString(account["service"], 128) || !safeOrigin(account["origin"])) return null;
  return {
    kind: "authentication_required",
    mode: "reconnect",
    reason: value["reason"] as "reconnect" | "sign_in" | "mfa" | "captcha",
    account: { id: String(account["id"]), label: account["label"], service: account["service"], origin: account["origin"] },
  };
}

function parseReadContinuation(value: unknown): ConnectedReadContinuation | null {
  if (!isRecord(value) || !onlyKeys(value, ["account", "request", "delivery"])
    || !nonEmptyString(value["account"], 2_048)
    || typeof value["request"] !== "string" || value["request"].trim().length === 0
    || (value["delivery"] !== "text" && value["delivery"] !== "workspace")) return null;
  return {
    account: value["account"],
    request: value["request"],
    delivery: value["delivery"],
  };
}

/** Reject malformed or provider-shaped historical payloads without displaying them. */
function parseConnectedWebAccountReadResult(raw: string | undefined): ConnectedReadResult | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
    if (value["ok"] === false) {
      if (!onlyKeys(value, ["ok", "code", "recovery", "intervention", "continuation"])
        || typeof value["code"] !== "string" || !FAILURE_CODES.has(value["code"] as ConnectedReadFailure["code"])
        || typeof value["recovery"] !== "string" || !RECOVERIES.has(value["recovery"] as ConnectedReadFailure["recovery"])) return null;
      if (value["code"] === "authentication_required") {
        const intervention = parseAuthenticationIntervention(value["intervention"]);
        const continuation = value["continuation"] === undefined
          ? undefined
          : parseReadContinuation(value["continuation"]) ?? null;
        if (!intervention || (intervention.mode === "connect" && value["recovery"] !== "connect")
          || (intervention.mode === "reconnect" && value["recovery"] !== "reconnect")
          || continuation === null) return null;
        return {
          ok: false,
          code: "authentication_required",
          recovery: value["recovery"] as "connect" | "reconnect",
          intervention,
          ...(continuation ? { continuation } : {}),
        };
      }
      if (value["intervention"] !== undefined || value["continuation"] !== undefined) return null;
      return { ok: false, code: value["code"] as ConnectedReadFailure["code"], recovery: value["recovery"] as ConnectedReadFailure["recovery"] };
    }
    if (!onlyKeys(value, ["ok", "status", "account", "read", "cost", "page", "outputs", "outputsTruncated"])
      || (value["status"] !== undefined && value["status"] !== "completed")
      || !isRecord(value["account"]) || (value["read"] !== null && !isRecord(value["read"]))
      || !isRecord(value["cost"])) return null;
    const account = value["account"];
    const read = isRecord(value["read"]) ? value["read"] : null;
    const cost = value["cost"];
    if (!onlyKeys(account, ["id", "label", "service", "origin"])
      || !UUID_RE.test(String(account["id"])) || !nonEmptyString(account["label"], 256)
      || !nonEmptyString(account["service"], 128) || !safeOrigin(account["origin"])) return null;
    if (read !== null && (!onlyKeys(read, ["answer", "facts", "completeness", "provenance", "origin"])
      || !nonEmptyString(read["answer"], 16_000) || !Array.isArray(read["facts"])
      || read["facts"].length > 100 || !["complete", "partial", "unknown"].includes(String(read["completeness"]))
      || !["authenticated_website", "user_connected_website"].includes(String(read["provenance"]))
      || !safeOrigin(read["origin"]) || read["origin"] !== account["origin"])) return null;
    const facts: Array<{ label: string; value: string }> = [];
    for (const fact of read === null ? [] : read["facts"] as unknown[]) {
      if (!isRecord(fact) || !onlyKeys(fact, ["label", "value"])
        || !nonEmptyString(fact["label"], 256) || !nonEmptyString(fact["value"], 4_096)) return null;
      facts.push({ label: fact["label"], value: fact["value"] });
    }
    if (!onlyKeys(cost, ["currency", "amountUsd", "state"])
      || cost["currency"] !== "USD" || (typeof cost["amountUsd"] !== "number" && cost["amountUsd"] !== null)
      || (typeof cost["amountUsd"] === "number" && (!Number.isFinite(cost["amountUsd"]) || cost["amountUsd"] < 0))
      || !["actual", "unknown"].includes(String(cost["state"]))
      || typeof value["outputsTruncated"] !== "boolean") return null;
    if (!isRecord(value["page"]) || !onlyKeys(value["page"], ["ref", "title", "origin"])
      || !UUID_RE.test(String(value["page"]["ref"])) || value["page"]["ref"] !== account["id"]
      || !nonEmptyString(value["page"]["title"], 512) || !safeOrigin(value["page"]["origin"])
      || value["page"]["title"] !== account["label"] || value["page"]["origin"] !== account["origin"]) return null;
    const page: ConnectedPage = { ref: String(value["page"]["ref"]), title: String(value["page"]["title"]), origin: String(value["page"]["origin"]) };
    if (!Array.isArray(value["outputs"]) || value["outputs"].length > MAX_OUTPUTS) return null;
    const projected = value["outputs"].map(parseOutput);
    if (projected.some((output) => output === null)) return null;
    const outputs = projected as ConnectedOutput[];
    return {
      ok: true,
      status: "completed",
      account: { id: String(account["id"]), label: String(account["label"]), service: String(account["service"]), origin: String(account["origin"]) },
      read: read === null ? null : { answer: String(read["answer"]), facts, completeness: read["completeness"] as "complete" | "partial" | "unknown", provenance: read["provenance"] as "authenticated_website" | "user_connected_website", origin: String(read["origin"]) },
      cost: { currency: "USD", amountUsd: cost["amountUsd"], state: cost["state"] as ConnectedReadSuccess["cost"]["state"] },
      outputsTruncated: value["outputsTruncated"],
      page,
      outputs,
    };
  } catch {
    return null;
  }
}

/** The initial async receipt is the sole active-card coordinate. */
export function parseConnectedWebAccountReadActive(raw: string | undefined): ConnectedReadActive | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !onlyKeys(value, ["ok", "status", "account", "operation"])
      || value["ok"] !== true || value["status"] !== "active" || !isRecord(value["account"]) || !isRecord(value["operation"])) return null;
    const account = value["account"];
    const operation = value["operation"];
    if (!onlyKeys(account, ["id", "label", "service", "origin"])
      || !UUID_RE.test(String(account["id"])) || !nonEmptyString(account["label"], 256)
      || !nonEmptyString(account["service"], 128) || !safeOrigin(account["origin"])) return null;
    if (!onlyKeys(operation, ["operationId", "driver", "lifecycle", "controlEpoch", "activity", "receipt"])
      || !UUID_RE.test(String(operation["operationId"])) || operation["driver"] !== "hosted"
      || operation["lifecycle"] !== "running" || !Number.isSafeInteger(operation["controlEpoch"])
      || (operation["controlEpoch"] as number) < 1 || operation["receipt"] !== null || !isRecord(operation["activity"])) return null;
    const activity = operation["activity"];
    if (!onlyKeys(activity, ["phase", "code", "summary"])
      || !["starting", "working", "checking", "attention", "finishing"].includes(String(activity["phase"]))
      || !nonEmptyString(activity["code"], 128) || !nonEmptyString(activity["summary"], 512)) return null;
    return {
      ok: true, status: "active",
      account: { id: String(account["id"]), label: String(account["label"]), service: String(account["service"]), origin: String(account["origin"]) },
      operation: {
        operationId: String(operation["operationId"]), driver: "hosted", lifecycle: "running", controlEpoch: operation["controlEpoch"] as number,
        activity: { phase: activity["phase"] as ConnectedReadActive["operation"]["activity"]["phase"], code: String(activity["code"]), summary: String(activity["summary"]) }, receipt: null,
      },
    };
  } catch { return null; }
}

function basename(path: string): string {
  const segment = path.replace(/\\/gu, "/").split("/").pop();
  return segment && segment.length > 0 ? segment : "File";
}

function outputDisplayName(path: string): string {
  const name = basename(path);
  const match = /^connected-web\/[a-f0-9]{16}-(.+)$/iu.exec(path.replace(/\\/gu, "/"));
  return match?.[1] || name;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

type ResolvedOutput = ConnectedOutput & Readonly<{ artifact: ArtifactDto | null }>;

function ConnectedOutputs({ outputs }: { outputs: readonly ConnectedOutput[] }): ReactElement {
  const roomId = useRoomNavigation().activeRoomId ?? undefined;
  const [artifacts, setArtifacts] = useState<readonly ArtifactDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lookupKey = outputs.map(({ artifactId, path }) => `${artifactId}:${path}`).join("|");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLookupFailed(false);
    void apiClient.listWorkspaceArtifacts({ ...(roomId ? { roomId } : {}) })
      .then(({ artifacts: next }) => {
        if (!cancelled) setArtifacts(next);
      })
      .catch(() => {
        if (!cancelled) {
          setArtifacts([]);
          setLookupFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [lookupKey, roomId]);

  const resolved = useMemo<readonly ResolvedOutput[]>(
    () => outputs.map((output) => ({
      ...output,
      artifact: artifacts.find((candidate) => candidate.artifactId === output.artifactId) ?? null,
    })),
    [artifacts, outputs],
  );
  const images = useMemo(
    () => resolved.filter((output) => output.mime.startsWith("image/") && output.artifact).map((output) => ({
      kind: "artifact" as const,
      id: output.artifact!.id,
      mime: output.artifact!.mimeType || output.mime,
      ...(roomId ? { roomId } : {}),
    })),
    [resolved, roomId],
  );

  const openInWork = useCallback((output: ResolvedOutput) => {
    const artifact = output.artifact;
    if (!artifact) return;
    setActionError(null);
    const opened = requestOpenFile(artifactOpenFileTarget({
      id: artifact.id,
      path: artifact.path,
      mimeType: artifact.mimeType || output.mime,
      ...(roomId ? { roomId } : {}),
    }));
    if (!opened) setActionError("The Work surface is not ready. Try again from the Workspace tab.");
  }, [roomId]);

  const download = useCallback(async (output: ResolvedOutput) => {
    const artifact = output.artifact;
    if (!artifact) return;
    setActionError(null);
    try {
      await apiClient.downloadArtifact(artifact.id, outputDisplayName(output.path), { ...(roomId ? { roomId } : {}) });
    } catch {
      setActionError("That file could not be downloaded yet. Try again.");
    }
  }, [roomId]);

  return (
    <section aria-label="connected website outputs" className="space-y-2">
      {lookupFailed ? <p className="text-xs text-tool-error" role="status">Saved output is not ready to open yet. Try again shortly.</p> : null}
      {actionError ? <p className="text-xs text-tool-error" role="status">{actionError}</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {resolved.map((output) => {
          const displayName = outputDisplayName(output.path);
          const isImage = output.mime.startsWith("image/");
          const imageIndex = resolved.filter((candidate) => candidate.mime.startsWith("image/") && candidate.artifact)
            .findIndex((candidate) => candidate.artifactId === output.artifactId);
          const imageRef: LightboxImageRef | null = isImage && output.artifact ? {
            kind: "artifact",
            id: output.artifact.id,
            mime: output.artifact.mimeType || output.mime,
            ...(roomId ? { roomId } : {}),
          } : null;
          return (
            <article key={output.artifactId} className="rounded border border-border bg-background px-3 py-2" data-testid={`connected-web-output-${output.artifactId}`}>
              <div className="flex gap-3">
                {isImage ? <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-background-element/30">
                  {imageRef ? <Thumbnail image={imageRef} size="small" onOpen={() => setLightboxIndex(imageIndex)} ariaLabel={`Open image ${displayName}`} /> : <div className="flex h-full items-center justify-center px-1 text-center text-[0.65rem] text-foreground-dim">{loading ? "Loading…" : "Preview unavailable"}</div>}
                </div> : null}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground" title={displayName}>{displayName}</p>
                  <p className="mt-0.5 text-[0.65rem] text-foreground-dim">{formatBytes(output.bytes)}</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={!output.artifact} onClick={() => openInWork(output)} className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" aria-label={`Open ${displayName} in Work`}>Open</button>
                    <button type="button" disabled={!output.artifact} onClick={() => void download(output)} className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" aria-label={`Download ${displayName}`}>Download</button>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {lightboxIndex !== null ? <ImageLightbox images={images} index={lightboxIndex} onClose={() => setLightboxIndex(null)} onStep={(delta) => setLightboxIndex((current) => current === null || images.length === 0 ? null : (current + delta + images.length) % images.length)} /> : null}
    </section>
  );
}

function failureMessage(result: ConnectedReadFailure): string {
  if (result.code === "cancelled") return "Stopped. The website read was cancelled.";
  if (result.code === "reconnect_required") return "Reconnect this website before trying again.";
  if (result.code === "not_connected") return "Connect a website before trying again.";
  if (result.code === "provider_unavailable") return "This connected website is temporarily unavailable. Try again shortly.";
  if (result.code === "invalid_result") return "Browser run completed.";
  return "This connected website result is not available. Try again.";
}

function catalogueEntryForSelector(selector: string): WebsiteCatalogueEntry | null {
  const normalized = selector.trim().toLocaleLowerCase("en-US");
  let hostname: string | null = null;
  try {
    const parsed = new URL(selector);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username.length === 0 && parsed.password.length === 0) hostname = parsed.hostname.toLocaleLowerCase("en-US");
  } catch {
    // Human-recognizable service and catalogue labels are expected here too.
  }
  return WEBSITE_CATALOGUE.find((website) => {
    const start = new URL(website.startUrl);
    return website.id.toLocaleLowerCase("en-US") === normalized
      || website.displayName.toLocaleLowerCase("en-US") === normalized
      || start.origin.toLocaleLowerCase("en-US") === normalized
      || start.hostname.toLocaleLowerCase("en-US") === normalized
      || (hostname !== null && (start.hostname.toLocaleLowerCase("en-US") === hostname
        || website.relatedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))));
  }) ?? null;
}

function retryArgs(args: Record<string, unknown>): { account: string; request: string; delivery: "text" | "workspace" } | null {
  const account = typeof args["account"] === "string" ? args["account"].trim() : "";
  const request = typeof args["request"] === "string" ? args["request"].trim() : "";
  const delivery = args["delivery"] === "workspace" ? "workspace" : "text";
  return account.length > 0 && account.length <= 2_048 && request.length > 0
    ? { account, request, delivery }
    : null;
}

function interventionStateKey(toolCallId: string | undefined): string | null {
  return toolCallId ? `nautilo:connected-web-intervention:${toolCallId}` : null;
}

function storedInterventionState(key: string | null): "waiting" | "resumed" | "cancelled" | null {
  if (!key || typeof sessionStorage === "undefined") return null;
  const value = sessionStorage.getItem(key);
  return value === "waiting" || value === "resumed" || value === "cancelled" ? value : null;
}

function AuthenticationRequiredCard({ result, args, event }: {
  result: ConnectedReadFailure & Readonly<{ intervention: ConnectedAuthenticationIntervention }>;
  args: Record<string, unknown>;
  event: ToolRendererProps["event"];
}): ReactElement {
  const { activeRoomId } = useRoomNavigation();
  const original = useMemo(() => result.continuation ?? retryArgs(args), [args, result.continuation]);
  const stateKey = interventionStateKey(event?.toolCallId);
  const [state, setState] = useState<"ready" | "waiting" | "resuming" | "resumed" | "cancelled" | "error">(
    () => storedInterventionState(stateKey) ?? "ready",
  );
  const resumedRef = useRef(false);
  const intervention = result.intervention;
  const catalogue = intervention.mode === "connect" ? catalogueEntryForSelector(intervention.target.selector) : null;
  const label = intervention.mode === "reconnect"
    ? intervention.account.label
    : catalogue?.displayName ?? intervention.target.selector;
  const canOpen = intervention.mode === "reconnect" || catalogue !== null || safeConnectionUrl(intervention.target.selector);

  const resumeOriginalRequest = useCallback(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    if (!activeRoomId || !event?.authorAgentId || !original) {
      resumedRef.current = false;
      setState("error");
      return;
    }
    setState("resuming");
    const content = [
      `Website sign-in completed for ${JSON.stringify(label)}.`,
      "Continue the exact original connected-website request now.",
      `Account: ${JSON.stringify(original.account)}`,
      `Request: ${JSON.stringify(original.request)}`,
      `Delivery: ${original.delivery}`,
      "Re-observe the signed-in page before answering. Do not ask for credentials in chat.",
    ].join("\n");
    void apiClient.getRoom(activeRoomId).then((room) => {
      const bot = room.members.find((member) => member.kind === "agent"
        && (member.agentId === event.authorAgentId || member.actorId === event.authorAgentId));
      if (!bot) throw new Error("The originating Genie is no longer a member of this room.");
      return sendOrdinaryRoomMessage(apiClient, activeRoomId, {
        content,
        uiSelectedBotActorId: bot.actorId,
      });
    }).then(() => {
      if (stateKey && typeof sessionStorage !== "undefined") sessionStorage.setItem(stateKey, "resumed");
      setState("resumed");
    }).catch(() => {
      resumedRef.current = false;
      setState("error");
    });
  }, [activeRoomId, event?.authorAgentId, label, original, stateKey]);

  const onFinished = useCallback((outcome: "done" | "cancelled") => {
    if (outcome === "cancelled") {
      if (stateKey && typeof sessionStorage !== "undefined") sessionStorage.setItem(stateKey, "cancelled");
      setState("cancelled");
      return;
    }
    resumeOriginalRequest();
  }, [resumeOriginalRequest, stateKey]);

  const open = useCallback(() => {
    setState("waiting");
    if (stateKey && typeof sessionStorage !== "undefined") sessionStorage.setItem(stateKey, "waiting");
    const common = { onFinished };
    const opened = intervention.mode === "reconnect"
      ? requestWebsiteConnection({ kind: "reconnect", accountId: intervention.account.id, ...common })
      : catalogue
        ? requestWebsiteConnection({ kind: "catalogue", websiteId: catalogue.id, ...common })
        : requestWebsiteConnection({ kind: "custom", url: intervention.target.selector, ...common });
    if (!opened) {
      if (stateKey && typeof sessionStorage !== "undefined") sessionStorage.removeItem(stateKey);
      setState("error");
    }
  }, [catalogue, intervention, onFinished, stateKey]);

  useEffect(() => {
    if (state !== "waiting") return;
    let alive = true;
    const resumeWhenConnected = async (): Promise<void> => {
      try {
        const accounts = (await apiClient.listConnectedWebAccounts()).accounts;
        const connected = intervention.mode === "reconnect"
          ? accounts.some((account) => account.id === intervention.account.id && account.status === "connected")
          : accounts.some((account) => account.status === "connected"
            && accountMatchesSelector(account, intervention.target.selector));
        if (alive && connected) resumeOriginalRequest();
      } catch {
        // The transient callback remains the primary path. A later account
        // refresh will retry this authoritative state check.
      }
    };
    void resumeWhenConnected();
    const unsubscribe = subscribeConnectedWebAccountRefresh(() => void resumeWhenConnected());
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [intervention, resumeOriginalRequest, state]);

  const detail = intervention.reason === "mfa"
    ? "This account needs verification before Genie can continue."
    : intervention.reason === "captcha"
      ? "This website needs a Human check before Genie can continue."
      : "Sign in directly in Nautilo’s protected browser, then choose Done.";

  if (state === "resumed") {
    return <div className="space-y-1 border-t border-border px-3 py-3">
      <p className="text-sm font-medium text-tool-success">Connected</p>
      <p className="text-xs text-foreground-muted" role="status">Genie is continuing your request.</p>
    </div>;
  }

  return <div className="space-y-2 border-t border-border px-3 py-3">
    <p className="text-sm font-medium text-foreground">Sign in to {label}</p>
    <p className="text-xs text-foreground-muted">{detail}</p>
    {state === "cancelled" ? <p className="text-xs text-foreground-muted" role="status">Sign-in cancelled. The original request was not retried.</p>
      : state === "error" ? <div className="flex flex-wrap items-center gap-2"><p className="text-xs text-foreground-muted" role="status">Connected. Your request has not continued yet.</p>{original ? <button type="button" onClick={resumeOriginalRequest} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground">Continue request</button> : null}</div>
        : <button type="button" disabled={!canOpen || state !== "ready"} onClick={open} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60">{state === "waiting" ? "Waiting for sign-in…" : state === "resuming" ? "Resuming…" : `Sign in to ${label}`}</button>}
    {!canOpen ? <p className="text-xs text-foreground-muted">Connect this website from Connections, then ask Genie to continue.</p> : null}
  </div>;
}

function accountMatchesSelector(account: ConnectedWebAccount, selector: string): boolean {
  const normalized = selector.trim().toLocaleLowerCase("en-US");
  let selectorOrigin: string | null = null;
  try {
    const parsed = new URL(selector);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") selectorOrigin = parsed.origin;
  } catch {
    // Labels and service names are valid selectors too.
  }
  return account.status !== "revoked" && (account.id === selector
    || account.label.trim().toLocaleLowerCase("en-US") === normalized
    || account.service.trim().toLocaleLowerCase("en-US") === normalized
    || account.origin === selector
    || (selectorOrigin !== null && account.origin === selectorOrigin));
}

function liveViewerStateKey(operationId: string): string {
  return `nautilo:connected-web-live-view:${operationId}`;
}

function storedLiveViewerOpen(operationId: string): boolean {
  return typeof sessionStorage !== "undefined"
    && sessionStorage.getItem(liveViewerStateKey(operationId)) === "open";
}

/** The owner projection is deliberately the sole authority for active-card language. */
function activeOperationLabel(operation: Pick<ConnectedWebOperationProjection, "driver" | "lifecycle" | "activity">): string {
  if (operation.activity.code === "provider_terminal_pending") return "Browser finished; recording outcome";
  if (operation.activity.code === "direct_browser_cleanup_unresolved") return "Browser cleanup needs attention";
  if (operation.activity.code === "direct_browser_control_recovered") return "Checking final browser status";
  if (operation.driver === "human" || operation.lifecycle === "attention" || operation.activity.phase === "attention") {
    return "Human input needed";
  }
  if (operation.driver === "checking") return "Moxie checking";
  if (operation.driver === "direct") return "Moxie controlling browser";
  return "Browser agent working";
}

function BrowserActivityLog({ operation }: { readonly operation: ConnectedWebOperationProjection | null }): ReactElement | null {
  const [earlier, setEarlier] = useState<ConnectedWebActivityPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const page = earlier ?? operation?.activityLog;
  if (!operation || !page || page.entries.length === 0) return null;
  const loadEarlier = async () => {
    if (!page.before) return;
    setLoading(true); setError(false);
    try {
      const result = await apiClient.getConnectedWebOperation(operation.operationId, page.before);
      if (result.activityLog) setEarlier(result.activityLog);
    } catch { setError(true); }
    finally { setLoading(false); }
  };
  return <section aria-label="Browser activity" className="space-y-2 px-3 py-2">
    <p className="text-xs font-medium text-foreground">{earlier ? "Earlier browser activity" : "Browser activity"}</p>
    <p className="text-xs text-foreground-muted">Actions reported by the browser agent—not verified findings.</p>
    <ol className="max-h-60 space-y-1 overflow-auto text-xs text-foreground-muted">
      {page.entries.map((entry) => <li key={entry.id} className="flex gap-2">
        <time dateTime={entry.occurredAt} className="shrink-0 tabular-nums">{new Date(entry.occurredAt).toLocaleTimeString()}</time>
        <span>{entry.summary} <span className="text-foreground-dim">({entry.status})</span></span>
      </li>)}
    </ol>
    <div className="flex gap-3">
      {page.hasMore ? <button type="button" disabled={loading} onClick={() => void loadEarlier()} className="text-xs text-primary">{loading ? "Loading…" : "Earlier activity"}</button> : null}
      {earlier ? <button type="button" onClick={() => setEarlier(null)} className="text-xs text-primary">Back to latest</button> : null}
    </div>
    {error ? <p className="text-xs text-foreground-muted" role="status">Earlier activity could not be loaded.</p> : null}
  </section>;
}

function RunningReadCard({ receipt, args = {}, event, task = false }: { readonly receipt: ConnectedReadActive | PublicBrowserReadActive; readonly args?: Record<string, unknown>; readonly event?: ToolRendererProps["event"]; readonly task?: boolean }): ReactElement {
  const publicTarget = "target" in receipt ? receipt.target : null;
  const selector = "account" in receipt ? receipt.account.label : receipt.target.origin;
  const operationId = receipt.operation.operationId;
  const observation = useConnectedWebOperation(operationId);
  const operation = observation.value;
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  // The provider capability never enters browser storage. Persist only the
  // Human's presentation choice so a transcript remount caused by the next
  // tool call can re-resolve the live URL from the owner-only endpoint.
  const [viewerOpen, setViewerOpen] = useState(() => storedLiveViewerOpen(operationId));
  const [controlState, setControlState] = useState<"ready" | "watching" | "stopping" | "stopped" | "error">("ready");
  const terminal = operation?.lifecycle === "terminal";

  const watch = useCallback(async () => {
    if (!operation?.canWatch) return;
    setViewerOpen(true);
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(liveViewerStateKey(operationId), "open");
    setControlState("watching");
    try {
      const result = await apiClient.watchConnectedWebOperation(operationId);
      setWatchUrl(result.liveViewUrl);
      setControlState("ready");
    } catch {
      setControlState("error");
    }
  }, [operation?.canWatch, operationId]);

  useEffect(() => {
    if (!viewerOpen || watchUrl !== null || !operation?.canWatch || controlState !== "ready") return;
    void watch();
  }, [controlState, operation?.canWatch, viewerOpen, watch, watchUrl]);

  useEffect(() => {
    if (!terminal) return;
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(liveViewerStateKey(operationId));
    setViewerOpen(false);
    setWatchUrl(null);
  }, [operationId, terminal]);

  const hideViewer = useCallback(() => {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(liveViewerStateKey(operationId));
    setViewerOpen(false);
    setWatchUrl(null);
  }, [operationId]);

  const stop = useCallback(async () => {
    if (!operation?.canStop) return;
    setControlState("stopping");
    try {
      const next = await apiClient.stopConnectedWebOperation(operationId);
      publishConnectedWebOperation(next);
      hideViewer();
      setControlState(next.lifecycle === "terminal" ? "stopped" : "ready");
    } catch {
      setControlState("error");
    }
  }, [hideViewer, operation?.canStop, operationId]);
  const currentOperation = operation ?? receipt.operation;

  if (terminal) {
    const result = operation?.result === null || operation?.result === undefined
      ? null
      : publicTarget ? parsePublicBrowserResult(JSON.stringify(operation.result)) : parseConnectedWebAccountReadResult(JSON.stringify(operation.result));
    if (publicTarget && operation?.receipt?.code === "authentication_required") {
      const request = typeof args["request"] === "string" ? args["request"] : null;
      return <AuthenticationRequiredCard result={{ ok: false, code: "authentication_required", recovery: "connect",
        intervention: { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector: publicTarget.url } },
        ...(request ? { continuation: { account: publicTarget.url, request, delivery: "text" as const } } : {}),
      }} args={args} event={event} />;
    }
    if (task && "account" in receipt && operation?.receipt?.code === "authentication_required") {
      const continuation = retryArgs(args);
      return <AuthenticationRequiredCard result={{ ok: false, code: "authentication_required", recovery: "reconnect",
        intervention: { kind: "authentication_required", mode: "reconnect", reason: "sign_in", account: receipt.account },
        ...(continuation ? { continuation } : {}),
      }} args={args} event={event} />;
    }
    const terminalHeading = operation?.receipt?.outcome === "cancelled"
      ? "Browser run stopped"
      : operation?.receipt?.outcome === "attention_required"
        ? "Human input needed"
        : operation?.receipt?.outcome === "completed"
          ? "Browser run completed"
          : operation?.receipt?.outcome === "failed"
            ? "Connected website could not complete"
            : "Connected website needs attention";
    return <>{result?.ok
      ? <CompletedReadBody result={result} />
      : <div className="space-y-1 border-t border-border px-3 py-3"><p className="text-sm font-medium text-foreground">{terminalHeading}</p><p className="text-xs text-foreground-muted" role="status">{operation?.receipt?.summary ?? "The connected website operation ended without a displayable result."}</p></div>}
      <BrowserActivityLog operation={operation} /></>;
  }

  if (observation.status !== "available") return <div className="space-y-2 border-t border-border px-3 py-3">
    <p className="text-sm font-medium text-foreground">{observation.status === "loading" ? "Checking browser status…" : "Browser status unavailable"}</p>
    <p className="text-xs text-foreground-muted" role="status">{observation.status === "loading"
      ? "Checking whether this browser run is still active."
      : "Nautilo cannot verify whether this run is still active. Live view and Stop cannot be reached until status reconnects."}</p>
    {observation.status === "unavailable" ? <button type="button" onClick={observation.retry} className="text-xs text-primary">Retry status</button> : null}
  </div>;

  return (
    <div className="space-y-3 border-t border-border px-3 py-3">
      <div>
        <p className="text-sm font-medium text-foreground">{activeOperationLabel(currentOperation)}</p>
        <p className="mt-1 text-xs text-foreground-muted">Website: {selector}</p>
        <p className="mt-1 text-xs text-foreground-muted" role="status">{currentOperation.activity.summary}</p>
        <p className="mt-1 text-xs text-foreground-dim">{task ? "Your Genie is working on your behalf. You can watch or stop it here." : publicTarget ? "Public browser research can search and filter. Messages, purchases, and account changes are outside this read operation." : "Nautilo instructed the browser agent to read only—no forms, messages, purchases, or account changes."}</p>
      </div>
      {operation?.activity.code !== "provider_terminal_pending" ? <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void watch()} disabled={!operation?.canWatch || controlState === "watching" || controlState === "stopping" || controlState === "stopped"} className="rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:text-primary disabled:cursor-not-allowed disabled:opacity-50">
          {controlState === "watching" ? "Opening live view…" : watchUrl ? "Refresh live view" : "Watch live"}
        </button>
        <button type="button" onClick={() => void stop()} disabled={!operation?.canStop || controlState === "stopping" || controlState === "stopped"} className="rounded border border-tool-error/60 px-2 py-1 text-xs font-medium text-tool-error disabled:cursor-not-allowed disabled:opacity-50">
          {controlState === "stopping" ? "Stopping…" : controlState === "stopped" ? "Stopped" : "Stop"}
        </button>
      </div> : null}
      {controlState === "error" ? <p className="text-xs text-tool-error" role="alert">The browser control did not respond. The activity card will keep checking the run.</p> : null}
      <BrowserActivityLog operation={operation} />
      {viewerOpen ? (
        <section className="overflow-hidden rounded-md border border-border bg-black" aria-label={`Live browser for ${selector}`}>
          <div className="flex items-center justify-between border-b border-border bg-background px-3 py-2">
            <p className="text-xs font-medium text-foreground">Live browser</p>
            <button type="button" onClick={hideViewer} className="text-xs text-foreground-muted hover:text-foreground">Hide</button>
          </div>
          {watchUrl
            ? <iframe title={`Live browser for ${selector}`} src={watchUrl} tabIndex={-1} className="pointer-events-none aspect-video w-full border-0" referrerPolicy="no-referrer" />
            : <div className="flex aspect-video items-center justify-center px-3 text-xs text-foreground-muted" role="status">{controlState === "error" ? "Live view is temporarily unavailable. Retry from the control above." : "Restoring live browser…"}</div>}
        </section>
      ) : null}
    </div>
  );
}

function CompletedReadBody({ result }: { readonly result: ConnectedReadSuccess }): ReactElement {
  if (result.read === null) return <div className="border-t border-border px-3 py-2 text-xs text-foreground-muted">Browser run completed.</div>;
  return (
    <div className="space-y-3 border-t border-border px-3 py-2">
      <section aria-label="connected website answer">
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{result.read.answer}</p>
        {result.read.completeness !== "complete" ? <p className="mt-1 text-xs text-foreground-muted">Some details may be incomplete.</p> : null}
      </section>
      {result.read.facts.length > 0 ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {result.read.facts.map((fact) => <Fragment key={`${fact.label}:${fact.value}`}><dt className="font-medium text-foreground-muted">{fact.label}</dt><dd className="break-words text-foreground">{fact.value}</dd></Fragment>)}
      </dl> : null}
      {result.account === null ? <a href={result.page.origin} target="_blank" rel="noopener noreferrer" className="text-xs text-primary">{result.page.title}</a> : <section className="rounded border border-border bg-background px-3 py-2" aria-label="protected connected page">
        <p className="text-xs font-medium text-foreground">{result.page.title}</p>
        <p className="mt-1 text-xs text-foreground-muted">Open this protected signed-in page.</p>
        <button type="button" onClick={() => requestWebsiteConnection({ kind: "view", accountId: result.page.ref, title: result.page.title })} className="mt-2 rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:text-primary">Open live page</button>
      </section>}
      {result.outputs.length ? <ConnectedOutputs outputs={result.outputs} /> : null}
      {result.outputsTruncated ? <p className="text-xs text-foreground-muted" role="status">Some requested files could not be imported into this result.</p> : null}
    </div>
  );
}

function ConnectedWebAccountReadExpanded({ resultText, args, event, state }: ToolRendererProps): ReactElement {
  const active = parseConnectedWebAccountReadActive(resultText);
  if (active) return <RunningReadCard receipt={active} />;
  if (!resultText?.trim() && (state === "pending" || state === "running")) {
    const selector = typeof args["account"] === "string" ? args["account"] : "connected website";
    return <div className="space-y-1 border-t border-border px-3 py-3 text-xs text-foreground-muted"><p>Working on {selector}</p><p role="status">Starting the connected website operation…</p></div>;
  }
  const result = parseConnectedWebAccountReadResult(resultText);
  if (!result) return <div className="border-t border-border px-3 py-2 text-xs text-tool-error">This connected website result could not be displayed safely.</div>;
  if (!result.ok && result.code === "authentication_required" && result.intervention) {
    return <AuthenticationRequiredCard result={result as ConnectedReadFailure & Readonly<{ intervention: ConnectedAuthenticationIntervention }>} args={args} event={event} />;
  }
  if (!result.ok) return <div className={`border-t border-border px-3 py-2 text-xs ${result.code === "invalid_result" ? "text-foreground-muted" : "text-tool-error"}`}>{failureMessage(result)}</div>;
  return <CompletedReadBody result={result} />;
}

function collapsedSummary(input: { resultText: string | undefined; state: ToolRendererProps["state"] }): string {
  if (parseConnectedWebAccountReadActive(input.resultText)) return `Connected website · ${input.state === "success" ? "completed" : input.state === "cancelled" ? "stopped" : input.state === "error" ? "failed" : input.state === "blocked" ? "needs attention" : "working"}`;
  if (!input.resultText?.trim() && (input.state === "pending" || input.state === "running")) return "Connected website · working";
  const result = parseConnectedWebAccountReadResult(input.resultText);
  if (!result) return "Connected website";
  if (!result.ok) return result.code === "invalid_result"
    ? "Connected website · completed"
    : result.code === "cancelled"
      ? "Connected website · stopped"
      : result.code === "authentication_required"
        ? "Connected website · sign-in needed"
    : "Connected website unavailable";
  return `Connected website · ${result.account?.label ?? result.page.title}`;
}

export const connectedWebAccountReadRenderer: ToolRenderer = {
  displayName: "Connected website",
  collapsedSummary,
  autoExpandWhileRunning: true,
  autoExpandOnResult: true,
  sealedResultParser: true,
  stateOverride: ({ resultText }) => {
    if (parseConnectedWebAccountReadActive(resultText)) return "running";
    const result = parseConnectedWebAccountReadResult(resultText);
    return result && !result.ok
      ? result.code === "invalid_result"
        ? "success"
        : result.code === "cancelled"
          ? "cancelled"
          : result.code === "authentication_required"
            ? "blocked"
          : null
      : null;
  },
  ExpandedBody: ConnectedWebAccountReadExpanded,
};

export function parsePublicBrowserReadActive(raw: string | undefined): PublicBrowserReadActive | null {
  try { const result = publicBrowserReadActiveSchema.safeParse(JSON.parse(raw ?? "")); return result.success ? result.data : null; }
  catch { return null; }
}

function parsePublicBrowserResult(raw: string | undefined): ConnectedReadResult | null {
  try {
    const value = JSON.parse(raw ?? "") as unknown;
    if (isRecord(value) && value["ok"] === false) return parseConnectedWebAccountReadResult(raw);
    const result = connectedWebOperationTerminalReadResultSchema.safeParse(value);
    return result.success && result.data.account === null ? result.data : null;
  } catch { return null; }
}

export const publicBrowserReadRenderer: ToolRenderer = {
  displayName: "Browser Use",
  collapsedSummary: ({ state }) => `Browser Use · ${state === "success" ? "completed" : state === "error" ? "failed" : state === "cancelled" ? "stopped" : state === "blocked" ? "needs attention" : "working"}`,
  autoExpandWhileRunning: true,
  autoExpandOnResult: true,
  sealedResultParser: true,
  stateOverride: ({ resultText }) => parsePublicBrowserReadActive(resultText) ? "running" : null,
  ExpandedBody: ({ resultText, args, event, state }) => {
    const active = parsePublicBrowserReadActive(resultText);
    if (active) return <RunningReadCard receipt={active} args={args} event={event} />;
    if (!resultText && (state === "pending" || state === "running")) return <p className="px-3 py-2 text-xs">Starting public Browser Use…</p>;
    const result = parsePublicBrowserResult(resultText);
    if (result?.ok) return <CompletedReadBody result={result} />;
    return <p className="px-3 py-2 text-xs text-tool-error">{result ? failureMessage(result) : "The browser result could not be displayed safely."}</p>;
  },
};

/** Task continuation comes from the typed result, never shortened display args. */
export function parseWebsiteTaskActive(raw: string | undefined) {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (!isRecord(value)) return null;
    const { continuation: candidate, ...base } = value;
    const continuation = parseReadContinuation(candidate);
    const receipt = parsePublicBrowserReadActive(JSON.stringify(base)) ?? parseConnectedWebAccountReadActive(JSON.stringify(base));
    if (!receipt || !continuation) return null;
    const target = "target" in receipt ? receipt.target.url : receipt.account.label;
    if ("target" in receipt && continuation.account !== target) return null;
    return { ...receipt, continuation };
  } catch { return null; }
}

export const websiteTaskRenderer: ToolRenderer = {
  ...publicBrowserReadRenderer,
  displayName: "Website task",
  collapsedSummary: () => "Website task",
  stateOverride: ({ resultText }) => parseWebsiteTaskActive(resultText) ? "running" : null,
  ExpandedBody: (props) => {
    const active = parseWebsiteTaskActive(props.resultText);
    if (active) return <RunningReadCard receipt={active} args={{ ...props.args, ...active.continuation }} event={props.event} task />;
    if (typeof props.args["account"] === "string") return <ConnectedWebAccountReadExpanded {...props} />;
    const Body = publicBrowserReadRenderer.ExpandedBody;
    return <Body {...props} />;
  },
};
