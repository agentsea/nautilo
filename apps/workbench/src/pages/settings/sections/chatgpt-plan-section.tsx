import { useCallback, useEffect, useRef, useState } from "react";
import { addAuthTransitionListener } from "../../../lib/auth-transition";
import { apiClient } from "../../../lib/api";
import { desktopAPI } from "../../../lib/desktop";
import { PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT } from "../../../lib/caller-model-availability";
import { Button, StatusPill } from "../ui";

type Accounts = Awaited<ReturnType<typeof apiClient.listChatGPTAccounts>>;
const SIGN_IN_STATUS_POLL_MS = 1500;
function changed() { window.dispatchEvent(new Event(PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT)); }

async function openSignIn(url: string) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://auth.openai.com" || parsed.pathname !== "/api/accounts/authorize") throw new Error("Invalid sign-in destination");
  if (desktopAPI?.browserControl) await desktopAPI.browserControl.openExternal({ url });
  else window.open(url, "_blank", "noopener,noreferrer");
}

type ChatGPTAccountApi = Pick<typeof apiClient, "listChatGPTAccounts" | "startChatGPTSignIn" | "chatGPTSignInStatus"
  | "completeChatGPTSignIn" | "cancelChatGPTSignIn" | "selectChatGPTAccount" | "listChatGPTModels" | "disconnectChatGPTAccount">;
export function ChatGPTPlanSection({ accountApi = apiClient, policyEnabled = true, desktopBridge = desktopAPI?.chatGPT }: {
  accountApi?: ChatGPTAccountApi; policyEnabled?: boolean; desktopBridge?: NonNullable<typeof desktopAPI>["chatGPT"];
}) {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ attemptId: string; authorizationUrl: string; successMessage: string } | null>(null);
  const [models, setModels] = useState<Record<string, { id: string; name: string }[]>>({});
  const [confirmFundingSwitch, setConfirmFundingSwitch] = useState(false);
  const listener = useRef<string | null>(null);
  const cancelListener = useCallback(() => {
    const id = listener.current; listener.current = null;
    if (id) void desktopBridge?.cancel(id).catch(() => {});
  }, [desktopBridge]);
  const epoch = useRef(0);
  const ceremony = useRef(0);
  const active = useRef(false);
  const loadGeneration = useRef(0);
  const isCurrent = (generation: number) => active.current && epoch.current === generation;
  const load = useCallback(async () => {
    const generation = epoch.current;
    const request = ++loadGeneration.current;
    try {
      const result = await accountApi.listChatGPTAccounts();
      if (isCurrent(generation) && request === loadGeneration.current) setAccounts(result);
    } catch {
      if (isCurrent(generation) && request === loadGeneration.current) setMessage("ChatGPT accounts could not be loaded. Check your permissions or try again.");
    }
  }, [accountApi]);
  useEffect(() => {
    active.current = true;
    const reset = () => {
      ++epoch.current; ++ceremony.current; cancelListener();
      setAccounts(null); setAttempt(null); setModels({}); setMessage(null); setBusy(false); setConfirmFundingSwitch(false);
    };
    reset();
    void load();
    const removeListener = addAuthTransitionListener(detail => {
      if (detail.reason === "credential-refreshed") return;
      reset();
      if (detail.reason !== "signed-out") void load();
    });
    return () => { active.current = false; ++epoch.current; ++ceremony.current; cancelListener(); removeListener(); };
  }, [load, cancelListener]);
  useEffect(() => {
    if (!attempt) return;
    const generation = epoch.current;
    const current = () => !cancelled && isCurrent(generation);
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await accountApi.chatGPTSignInStatus(attempt.attemptId);
        if (!current()) return;
        if (result.status === "pending") { timer = setTimeout(() => void poll(), SIGN_IN_STATUS_POLL_MS); return; }
        setAttempt(null);
        setMessage(result.status === "connected" ? attempt.successMessage
          : result.code === "plan_permission_missing" ? "ChatGPT plan access was not granted. Try again and allow plan usage."
          : result.code === "authorization_denied" ? "Sign-in was declined. Your existing accounts are unchanged."
          : "Sign-in ended without connecting. Try again.");
        await load(); if (isCurrent(generation)) changed();
      } catch { if (current()) { setAttempt(null); setMessage("Sign-in status is unavailable. Reload accounts before trying again."); await load(); } }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [attempt, load, accountApi]);
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    const generation = epoch.current;
    const current = () => isCurrent(generation);
    setBusy(true); setMessage(null);
    try { await action(current); } catch { if (current()) setMessage("This ChatGPT account action could not finish. Reload accounts and try again."); }
    finally { if (current()) setBusy(false); }
  };
  const signIn = (accountId?: string) => run(async sessionCurrent => {
    const successMessage = accountId ? "ChatGPT reconnected. Your account selection is unchanged."
      : "ChatGPT connected. Choose this account for your OpenAI chats, then choose a model.";
    const generation = ++ceremony.current;
    const current = () => sessionCurrent() && ceremony.current === generation;
    let local: { listenerId: string; port: number } | undefined;
    if (desktopBridge && accounts?.canEnrollWithDesktop) {
      local = await desktopBridge.prepare();
      if (!current()) { void desktopBridge.cancel(local.listenerId).catch(() => {}); return; }
      listener.current = local.listenerId;
    }
    try {
      const next = local ? await accountApi.startChatGPTSignIn(accountId, local.port) : await accountApi.startChatGPTSignIn(accountId);
      if (!current()) return;
      setAttempt({ ...next, successMessage });
      if (local && desktopBridge) {
        // Arm before opening the browser. Only the callback code crosses IPC;
        // tokens and the verifier remain on the Server throughout the flow.
        void desktopBridge.receive({ listenerId: local.listenerId, authorizationUrl: next.authorizationUrl }).then(async callbackUrl => {
          if (!current()) return;
          const result = await accountApi.completeChatGPTSignIn(next.attemptId, callbackUrl);
          if (!current()) return;
          setAttempt(null);
          setMessage(result.status === "connected" ? successMessage
            : "Sign-in ended without connecting. Try again.");
          await load(); if (current()) changed();
        }).catch(async () => {
          if (!current()) return;
          setAttempt(null); setMessage("Sign-in could not finish. Reload accounts before trying again.");
          await load();
        });
      }
      if (!local) { try { await openSignIn(next.authorizationUrl); } catch { if (current()) setMessage("Use Continue sign-in to open your browser."); } }
    } catch (error) { if (current()) cancelListener(); throw error; }
  });
  const canEnroll = accounts?.canEnroll || Boolean(accounts?.canEnrollWithDesktop && desktopBridge);
  if (!policyEnabled && !accounts?.accounts.length) return null;
  return <section className="mb-5 space-y-3 border-b border-border pb-5" aria-labelledby="chatgpt-plan-heading">
    <h3 id="chatgpt-plan-heading" className="text-sm font-semibold">ChatGPT subscription</h3>
    <p className="text-xs text-foreground-muted">Connect your ChatGPT account to use eligible models with your plan. Credentials are encrypted on this Nautilo Server and can be read by its operator. This connection covers eligible text and tool conversations. Separately billed media and provider services are unavailable inside subscription-funded tasks.</p>
    {!accounts ? <Button disabled={busy} onClick={() => void load()}>Reload ChatGPT accounts</Button> : <>
      {!accounts.enabled ? <p role="status">Personal provider funding is disabled on this Server.</p> : null}
      {!canEnroll ? <p className="text-xs text-foreground-muted">{accounts.canEnrollWithDesktop === false ? "ChatGPT subscription enrollment is not available on this managed Server." : "To connect a subscription to a remote Server, open this Server in an updated Nautilo Desktop. You can manage already-connected accounts here."}</p> : null}
      {accounts.accounts.map(account => <div key={account.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{account.label}</span><span className="text-xs text-foreground-muted">Account {account.registrationLabel}</span>
          <StatusPill tone={account.state === "connected" ? "ok" : "warn"}>{account.state === "connected" ? "Connected" : account.state === "disconnected" ? "Disconnected" : account.pendingRegistration ? "Sign-in unfinished" : "Reconnect needed"}</StatusPill>
          {account.selected ? <StatusPill tone="muted">Used for OpenAI chats</StatusPill> : null}</div>
        <div className="flex flex-wrap gap-2">
          {account.state === "connected" ? <>
            {!account.selected ? <Button disabled={busy || !accounts.enabled} onClick={() => void run(async current => { await accountApi.selectChatGPTAccount(account.id); if (!current()) return; await load(); if (current()) changed(); })}>Use for OpenAI chats</Button> : null}
            <Button disabled={busy || !accounts.enabled} onClick={() => void run(async current => { const result = await accountApi.listChatGPTModels(account.id); if (!current()) return; setModels(old => ({ ...old, [account.id]: result.models })); })}>See eligible models</Button>
          </> : null}
          {account.state !== "disconnected" ? <Button disabled={busy} onClick={() => void run(async current => {
              const result = await accountApi.disconnectChatGPTAccount(account.id, account.revision);
              if (!current()) return;
              setModels(old => { const next = { ...old }; delete next[account.id]; return next; });
              await load(); if (!current()) return; changed(); setMessage(result.remoteRevocationConfirmed ? "Disconnected from ChatGPT."
                : "Disconnected locally. Remote revocation was not confirmed; remove access in ChatGPT Settings.");
            })}>Disconnect</Button> : null}
          <Button disabled={busy || !accounts.enabled || !canEnroll || account.requiresReplacement || attempt !== null} onClick={() => void signIn(account.id)}>{account.pendingRegistration ? "Finish sign-in" : "Reconnect"}</Button>
        </div>
        {account.requiresReplacement ? <p className="text-xs text-foreground-muted">This saved account cannot be recovered. Disconnect its local access, then add another ChatGPT account and explicitly select it for OpenAI chats.</p> : null}
        {account.selected && account.state === "connected" ? <p className="text-xs">This connected ChatGPT account is currently funding eligible OpenAI chats.</p> : null}
        {account.selected && account.state !== "connected" ? <p className="text-xs text-foreground-muted">OpenAI chats are paused until you reconnect or explicitly switch funding below.</p> : null}
        {models[account.id] ? <p className="text-xs text-foreground-muted">{models[account.id].length ? `Eligible models for this account (for reference only): ${models[account.id].map(model => model.name).join(", ")}. Choose your active model separately.` : "No eligible Nautilo models are available for this account. This list is informational and does not change funding or model selection."}</p> : null}
      </div>)}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !accounts.enabled || !canEnroll || attempt !== null} onClick={() => void signIn()}>{accounts.accounts.length ? "Add another ChatGPT account" : "Continue with ChatGPT"}</Button>
        {accounts.accounts.some(account => account.selected) ? <Button disabled={busy || !accounts.enabled} onClick={() => setConfirmFundingSwitch(true)}>Switch funding</Button> : null}
        <a className="text-sm text-primary hover:underline" href="/settings#model">Choose a model for your Genie</a>
      </div>
      {confirmFundingSwitch ? <div className="space-y-2 rounded-md border border-border p-3" role="group" aria-labelledby="chatgpt-funding-switch-heading">
        <p id="chatgpt-funding-switch-heading" className="text-sm font-medium">Switch to API-key/server funding?</p>
        <p className="text-xs text-foreground-muted">Your OpenAI chats will stop using the selected ChatGPT subscription. Your configured API-key/server funding policy will apply, and API charges may be incurred.</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => setConfirmFundingSwitch(false)}>Cancel</Button>
          <Button disabled={busy || !accounts.enabled} onClick={() => void run(async current => { await accountApi.selectChatGPTAccount(null); if (!current()) return; await load(); if (!current()) return; changed(); setConfirmFundingSwitch(false); setMessage("OpenAI chats now use your configured API-key/server funding policy. API charges may apply."); })}>Confirm switch to API-key/server funding</Button>
        </div>
      </div> : null}
    </>}
    {attempt ? <div className="flex flex-wrap items-center gap-2"><span role="status" className="text-sm">Waiting for browser sign-in…</span>
      <Button onClick={() => void run(async current => { try { await openSignIn(attempt.authorizationUrl); } catch { if (current()) setMessage("The sign-in browser could not be opened."); } })}>Continue sign-in</Button>
      <Button onClick={() => void run(async current => { ++ceremony.current; cancelListener(); await accountApi.cancelChatGPTSignIn(attempt.attemptId); if (!current()) return; setAttempt(null); await load(); if (current()) setMessage("Sign-in stopped. Any account already connected is shown above."); })}>Cancel</Button></div> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}
    <a className="text-xs text-primary hover:underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage ChatGPT usage and app access</a>
  </section>;
}
