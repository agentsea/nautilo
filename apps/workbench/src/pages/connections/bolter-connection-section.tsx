import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import type { BolterConnectionSummary, BolterConnectionsResponse, BolterConversationChoice, BolterOperationResponse, BolterRoomLinkSummary } from "@nautilo/types";
import { useBolterStateReload } from "../../components/use-bolter-state-reload";
import { apiClient } from "../../lib/api";
import { Button } from "../settings/ui";
import type { ConnectedAppCatalogueSummary } from "./connected-app-presentation";
import { bolterCatalogueSummary, bolterConnectionLabel, bolterReason } from "./bolter-presentation";

type AgentChoice = Awaited<ReturnType<typeof apiClient.listAgents>>[number];

/** Canonical HTTP owns authority; this surface never receives a native selector or credential. */
export function BolterConnectionSection({ scopeKey, onCatalogueSummary, onRoomCreated }: {
  readonly scopeKey: string;
  readonly onCatalogueSummary?: (summary: ConnectedAppCatalogueSummary) => void;
  readonly onRoomCreated: (roomId: string) => Promise<void>;
}) {
  const [data, setData] = useState<BolterConnectionsResponse | null>(null);
  const [operation, setOperation] = useState<BolterOperationResponse | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const operationRevision = useRef(0);
  const operationRead = useRef<{ id: string; work: Promise<boolean> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const busy = loading || actionBusy;
  const [relayId, setRelayId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<BolterConnectionSummary | null>(null);
  const [choices, setChoices] = useState<readonly BolterConversationChoice[]>([]);
  const [agents, setAgents] = useState<readonly AgentChoice[]>([]);
  const [choiceId, setChoiceId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [disconnect, setDisconnect] = useState<BolterConnectionSummary | null>(null);
  const [links, setLinks] = useState<Readonly<Record<string, readonly BolterRoomLinkSummary[]>>>({});
  const epoch = useRef(0);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const capture = useCallback(() => {
    const generation = epoch.current;
    const credentials = apiClient.getCredentialGeneration();
    const scope = currentScope.current;
    return () => generation === epoch.current && credentials === apiClient.getCredentialGeneration() && scope === currentScope.current;
  }, []);

  const reload = useBolterStateReload(async current => {
    setLoading(true); setError(null);
    try {
      const result = await apiClient.getBolterConnections();
      if (!current()) return;
      setData(result);
      setRelayId(previous => result.desktops.some(desktop => desktop.relayId === previous) ? previous
        : result.desktops.length === 1 ? result.desktops[0].relayId : "");
      onCatalogueSummary?.(result.availability.state === "available" ? bolterCatalogueSummary(result.connections)
        : { state: "attention", statusLabel: result.availability.state === "mode_unsupported" ? "Unsupported content mode" : "Not available", tone: "warn" });
      const linked = await Promise.allSettled(result.connections.map(async connection => ({ id: connection.id,
        links: (await apiClient.getBolterRoomLinks(connection.id)).links })));
      if (current()) {
        setLinks(Object.fromEntries(linked.flatMap(item => item.status === "fulfilled" ? [[item.value.id, item.value.links]] : [])));
        if (linked.some(item => item.status === "rejected")) setError("Some linked rooms could not be checked. Reload to try again.");
      }
    } catch {
      if (current()) { setData(null); setError("Could not check Bolter. Reload to try again."); }
    } finally { if (current()) setLoading(false); }
  }, capture);

  useEffect(() => {
    epoch.current += 1; setActionBusy(false);
    setData(null); setOperation(null); setPollingStopped(false); setSelectedConnection(null); setDisconnect(null); setError(null);
    setChoices([]); setAgents([]); setChoiceId(""); setAgentId(""); setName(""); setConsent(false);
    setLinks({}); setRelayId("");
    void reload();
    return () => { epoch.current += 1; };
  }, [scopeKey, reload]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    const current = capture();
    setActionBusy(true); setError(null);
    try { await action(); }
    catch { if (current()) setError("Bolter could not complete this request. Reload to check its current state."); }
    finally { if (current()) setActionBusy(false); }
  }
  const observeOperation = useCallback(async (result: BolterOperationResponse, current: () => boolean) => {
    if (!current()) return;
    setOperation(result); setPollingStopped(false);
    if (result.status === "completed") { setOperation(null); await reload(); }
  }, [reload]);
  const refreshOperation = useCallback((id: string): Promise<boolean> => {
    // Manual checks and automatic refresh share one in-flight read.
    if (operationRead.current?.id === id) return operationRead.current.work;
    const scopeCurrent = capture();
    const revision = operationRevision.current;
    const current = () => scopeCurrent() && revision === operationRevision.current;
    const work = (async () => {
      try {
        const result = await apiClient.getBolterOperation(id);
        if (!current()) return false;
        await observeOperation(result, current);
        return result.status === "pending" || result.status === "auth_pending";
      } catch (error) {
        if (current()) {
          setPollingStopped(true);
          if (error instanceof ApiError && error.status === 404) {
            setOperation(null);
            setError("Bolter sign-in was interrupted. Connect Bolter again; you may need to confirm your account with Bolter again.");
          } else setError("Could not check Bolter sign-in. Check sign-in to try again.");
        }
        return false;
      }
    })();
    operationRead.current = { id, work };
    void work.then(() => { if (operationRead.current?.work === work) operationRead.current = null; });
    return work;
  }, [capture, observeOperation]);
  const operationId = operation?.operationId;
  const pendingOperation = operation?.status === "pending" || operation?.status === "auth_pending";
  useEffect(() => {
    if (!operationId || !pendingOperation || pollingStopped) return;
    let cancelled = false;
    const current = capture();
    let timer: number | undefined;
    const poll = async () => {
      if (cancelled || !current()) return;
      const pending = await refreshOperation(operationId);
      // Match Connections' existing sequential two-second device-auth refresh cadence.
      if (pending && !cancelled && current()) timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [operationId, pendingOperation, pollingStopped, capture, refreshOperation]);
  async function beginLink(connection: BolterConnectionSummary) {
    const current = capture();
    const [conversations, availableAgents] = await Promise.all([apiClient.getBolterConversations(connection.id), apiClient.listAgents()]);
    if (!current()) return;
    if (conversations.status !== "available") { setError(bolterReason(conversations.reason)); return; }
    setSelectedConnection(connection); setChoices(conversations.conversations); setAgents(availableAgents);
    setChoiceId(conversations.conversations.length === 1 ? conversations.conversations[0].id : "");
    setAgentId(availableAgents.length === 1 ? availableAgents[0].agentId : ""); setName(conversations.conversations.length === 1 ? conversations.conversations[0].label : ""); setConsent(false);
  }
  const chosen = choices.find(item => item.id === choiceId);
  const available = data?.availability.state === "available";

  return <section aria-label="Bolter connection" className="space-y-4 text-sm">
    <p className="text-foreground-muted">Keep the receiving Nautilo Desktop running. Each linked room has one Bolter conversation.</p>
    {data && data.desktops.length > 1 ? <label className="block">Receiving Desktop
      <select aria-label="Receiving Desktop" value={relayId} disabled={busy || pendingOperation}
        onChange={event => setRelayId(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background p-2">
        <option value="">Choose a Desktop</option>{data.desktops.map(desktop => <option key={desktop.relayId} value={desktop.relayId}>{desktop.label} · {desktop.relayId}</option>)}
      </select>
    </label> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || pendingOperation} onClick={() => void reload()}>Reload</Button>
      <Button disabled={busy || !available || !relayId || pendingOperation} onClick={() => void run(async () => {
        const current = capture(); await observeOperation(await apiClient.connectBolter({ relayId }), current);
      })}>Connect Bolter</Button>
    </div>
    {!data && !error ? <p role="status">Checking Bolter…</p> : null}
    {data?.desktops.length === 1 ? <p className="text-xs text-foreground-muted">Receiving Desktop: {data.desktops[0].label}</p> : null}
    {data && !available ? <p role="status">{bolterReason(data.availability.reason ?? (data.availability.state !== "available" ? data.availability.state : undefined))}</p> : null}
    {error ? <p role="alert" className="text-[var(--error)]">{error}</p> : null}
    {operation ? <div className="space-y-2 rounded-lg border border-border p-3" aria-label="Bolter sign-in">
      <p role="status">{operation.status === "auth_pending" ? pollingStopped ? "Sign in to Bolter, then check sign-in." : "Sign in to Bolter. This page will update when you’re connected." : operation.status === "pending" ? "Connecting to Bolter…" : bolterReason(operation.reason)}</p>
      {operation.auth && operation.status === "auth_pending" ? <>
        <a className="text-accent underline" href={operation.auth.url} target="_blank" rel="noopener noreferrer">Open Bolter sign-in</a>
        <p>Code: <span className="font-mono">{operation.auth.code}</span></p>
      </> : null}
      {pendingOperation ? <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void run(async () => {
          await refreshOperation(operation.operationId);
        })}>Check sign-in</Button>
        <Button disabled={busy} onClick={() => void run(async () => {
          operationRevision.current += 1; setPollingStopped(true);
          const current = capture(); await apiClient.cancelBolterOperation(operation.operationId);
          if (current()) { setOperation(null); await reload(); }
        })}>Cancel sign-in</Button>
      </div> : null}
    </div> : null}
    {data?.connections.map(connection => <article key={connection.id} className="space-y-2 rounded-lg border border-border p-3">
      <h4 className="font-medium">{connection.identity?.label || connection.displayName}</h4>
      <p role="status">{bolterConnectionLabel(connection)} · {connection.device.label}</p>
      {connection.reason ? <p className="text-xs text-foreground-muted">{bolterReason(connection.reason)}</p> : null}
      {connection.identity ? <p className="break-all text-xs text-foreground-muted">Bolter identity: {connection.identity.providerAgentId}</p> : null}
      {links[connection.id]?.length ? <div className="space-y-1"><h5 className="text-xs font-medium">Linked rooms</h5>
        {links[connection.id].map(link => <button key={link.id} type="button" disabled={busy}
          className="block w-full rounded p-2 text-left text-xs hover:bg-background-element"
          onClick={() => void run(() => onRoomCreated(link.roomId))}>{link.roomName} · {link.conversationLabel} · {link.status}</button>)}
      </div> : null}
      {connection.status !== "revoked" ? <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !available} onClick={() => void run(async () => {
          const current = capture(); await apiClient.checkBolterConnection(connection.id); if (current()) await reload();
        })}>Check connection</Button>
        <Button disabled={busy || !available || !connection.canCreateRoom} onClick={() => void run(() => beginLink(connection))}>Create a linked room</Button>
        <Button disabled={busy} onClick={() => void run(async () => {
          const current = capture(); await apiClient.updateBolterConnection(connection.id, { expectedRevision: connection.revision, enabled: connection.status === "paused" });
          if (current()) { setSelectedConnection(null); await reload(); }
        })}>{connection.status === "paused" ? "Resume connection" : "Pause connection"}</Button>
        <Button disabled={busy} onClick={() => setDisconnect(connection)}>Disconnect</Button>
      </div> : null}
      {connection.status !== "revoked" ? <p className="text-xs text-foreground-muted">Pause stops new sends. Messages already authorized for dispatch may finish.</p> : null}
    </article>)}
    {disconnect ? <div role="alertdialog" aria-label="Disconnect Bolter" className="space-y-2 rounded-lg border border-border p-3">
      <p>Disconnect {disconnect.identity?.label || disconnect.displayName}? Its linked rooms keep their privacy boundary and history. Sends already authorized may finish. Uncertain deliveries will not be replayed.</p>
      <div className="flex gap-2"><Button disabled={busy} onClick={() => setDisconnect(null)}>Keep connection</Button>
      <Button disabled={busy} onClick={() => void run(async () => {
        const current = capture(); await apiClient.revokeBolterConnection(disconnect.id, { expectedRevision: disconnect.revision });
        if (current()) { setDisconnect(null); setSelectedConnection(null); await reload(); }
      })}>Disconnect Bolter</Button></div>
    </div> : null}
    {selectedConnection ? <form aria-label="Create a Bolter room" className="space-y-3 rounded-lg border border-border p-3" onSubmit={event => {
      event.preventDefault(); if (!chosen || !agentId || !consent || !name.trim() || !available) return;
      void run(async () => {
        const current = capture(); const created = await apiClient.createBolterRoom(selectedConnection.id, {
          choiceId: chosen.id, agentId, name: name.trim(), modelSponsorshipAccepted: true,
        });
        if (current()) { setSelectedConnection(null); await onRoomCreated(created.roomId); }
      });
    }}>
      <h4 className="font-medium">Create a linked room</h4>
      <p className="text-xs text-foreground-muted">A fresh private room starts with no previous history. Other rooms, private memory, files and tools stay outside this connection.</p>
      {choices.length ? <label className="block">Bolter conversation<select aria-label="Bolter conversation" value={choiceId} onChange={event => { setChoiceId(event.target.value); setName(choices.find(choice => choice.id === event.target.value)?.label ?? ""); setConsent(false); }} className="mt-1 block w-full rounded border border-border bg-background p-2">
        <option value="">Choose a conversation</option>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label} · {choice.chatId}{choice.threadRootId ? ` / ${choice.threadRootId}` : ""}</option>)}
      </select></label> : <p>No conversations are available. Open a Bolter conversation, then cancel and reload.</p>}
      {chosen ? <p className="break-all text-xs">{chosen.label} · {chosen.chatId}{chosen.threadRootId ? ` · thread ${chosen.threadRootId}` : " · root conversation"}</p> : null}
      {agents.length === 1 ? <p>Genie: {agents[0].displayName}</p> : <label className="block">Genie<select aria-label="Genie" value={agentId} onChange={event => { setAgentId(event.target.value); setConsent(false); }} className="mt-1 block w-full rounded border border-border bg-background p-2">
        <option value="">Choose a Genie</option>{agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}
      </select></label>}
      {!agents.length ? <p>No eligible Genie is available. <a href="/settings#my-agents" className="text-accent underline">Manage your Genies</a>, then reload this connection.</p> : null}
      <label className="block">Room name<input aria-label="Room name" value={name} onChange={event => setName(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background p-2" /></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>Allow this Genie to respond to this Bolter conversation using this room’s messages and my model credits.</span></label>
      <div className="flex gap-2"><Button type="button" disabled={busy} onClick={() => setSelectedConnection(null)}>Cancel</Button>
        <Button type="submit" disabled={busy || !available || !chosen || !agentId || !name.trim() || !consent}>Create room</Button></div>
    </form> : null}
    <p className="text-xs text-foreground-muted">Genie replies to incoming messages may leave Nautilo. Your messages and selected files are shared only when you send them with the Bolter composer. Review before sending is optional. Protected content is unsupported.</p>
  </section>;
}
