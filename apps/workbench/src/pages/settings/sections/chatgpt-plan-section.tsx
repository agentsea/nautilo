import { useCallback, useEffect, useRef, useState } from "react";
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
  | "cancelChatGPTSignIn" | "selectChatGPTAccount" | "listChatGPTModels" | "disconnectChatGPTAccount">;
export function ChatGPTPlanSection({ accountApi = apiClient, policyEnabled = true }: { accountApi?: ChatGPTAccountApi; policyEnabled?: boolean }) {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ attemptId: string; authorizationUrl: string } | null>(null);
  const [models, setModels] = useState<Record<string, { id: string; name: string }[]>>({});
  const mounted = useRef(true);
  const load = useCallback(async () => {
    try { const result = await accountApi.listChatGPTAccounts(); if (mounted.current) setAccounts(result); }
    catch { if (mounted.current) setMessage("ChatGPT accounts could not be loaded. Check your permissions or try again."); }
  }, [accountApi]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  useEffect(() => {
    if (!attempt) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await accountApi.chatGPTSignInStatus(attempt.attemptId);
        if (cancelled) return;
        if (result.status === "pending") { timer = setTimeout(() => void poll(), SIGN_IN_STATUS_POLL_MS); return; }
        setAttempt(null);
        setMessage(result.status === "connected" ? "ChatGPT connected. Choose this account for your OpenAI chats, then choose a model."
          : result.code === "plan_permission_missing" ? "ChatGPT plan access was not granted. Try again and allow plan usage."
          : result.code === "authorization_denied" ? "Sign-in was declined. Your existing accounts are unchanged."
          : "Sign-in ended without connecting. Try again.");
        await load(); changed();
      } catch { if (!cancelled) { setAttempt(null); setMessage("Sign-in status is unavailable. Reload accounts before trying again."); await load(); } }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [attempt, load, accountApi]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await action(); } catch { if (mounted.current) setMessage("This ChatGPT account action could not finish. Reload accounts and try again."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const signIn = (accountId?: string) => run(async () => {
    const next = await accountApi.startChatGPTSignIn(accountId);
    if (!mounted.current) { await accountApi.cancelChatGPTSignIn(next.attemptId); return; }
    setAttempt(next);
    try { await openSignIn(next.authorizationUrl); } catch { setMessage("Use Continue sign-in to open your browser."); }
  });
  if (!policyEnabled && !accounts?.accounts.length) return null;
  return <section className="mb-5 space-y-3 border-b border-border pb-5" aria-labelledby="chatgpt-plan-heading">
    <h3 id="chatgpt-plan-heading" className="text-sm font-semibold">ChatGPT subscription</h3>
    <p className="text-xs text-foreground-muted">Connect your ChatGPT account to use eligible models with your plan. Credentials are encrypted on this Nautilo Server and can be read by its operator. This connection covers eligible text and tool conversations. Separately billed media and provider services are unavailable inside subscription-funded tasks.</p>
    {!accounts ? <Button disabled={busy} onClick={() => void load()}>Reload ChatGPT accounts</Button> : <>
      {!accounts.enabled ? <p role="status">Personal provider funding is disabled on this Server.</p> : null}
      {!accounts.canEnroll ? <p className="text-xs text-foreground-muted">New sign-ins currently require a Nautilo Server on the same computer as your browser. Remote enrollment is not available in this build.</p> : null}
      {accounts.accounts.map(account => <div key={account.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{account.label}</span><span className="text-xs text-foreground-muted">Account {account.registrationLabel}</span>
          <StatusPill tone={account.state === "connected" ? "ok" : "warn"}>{account.state === "connected" ? "Connected" : account.state === "disconnected" ? "Disconnected" : "Reconnect needed"}</StatusPill>
          {account.selected ? <StatusPill tone="muted">Used for OpenAI chats</StatusPill> : null}</div>
        <div className="flex flex-wrap gap-2">
          {account.state === "connected" ? <>
            <Button disabled={busy || !accounts.enabled || account.selected} onClick={() => void run(async () => { await accountApi.selectChatGPTAccount(account.id); await load(); changed(); })}>Use for OpenAI chats</Button>
            <Button disabled={busy || !accounts.enabled} onClick={() => void run(async () => { const result = await accountApi.listChatGPTModels(account.id); setModels(old => ({ ...old, [account.id]: result.models })); })}>See eligible models</Button>
            <Button disabled={busy} onClick={() => void run(async () => {
              const result = await accountApi.disconnectChatGPTAccount(account.id, account.revision);
              setModels(old => { const next = { ...old }; delete next[account.id]; return next; });
              await load(); changed(); setMessage(result.remoteRevocationConfirmed ? "Disconnected from ChatGPT."
                : "Disconnected locally. Remote revocation was not confirmed; remove access in ChatGPT Settings.");
            })}>Disconnect</Button>
          </> : null}
          <Button disabled={busy || !accounts.enabled || !accounts.canEnroll || attempt !== null} onClick={() => void signIn(account.id)}>Reconnect</Button>
        </div>
        {account.selected && account.state !== "connected" ? <p className="text-xs text-foreground-muted">OpenAI chats are paused until you reconnect or explicitly switch funding below.</p> : null}
        {models[account.id] ? <p className="text-xs text-foreground-muted">{models[account.id].length ? `Eligible models: ${models[account.id].map(model => model.name).join(", ")}` : "No eligible Nautilo models are available for this account."}</p> : null}
      </div>)}
      {accounts.accounts.some(account => account.selected) ? <p className="text-xs text-foreground-muted">Switching to API-key/server funding can incur API charges.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !accounts.enabled || !accounts.canEnroll || attempt !== null} onClick={() => void signIn()}>Continue with ChatGPT</Button>
        {accounts.accounts.some(account => account.selected) ? <Button disabled={busy || !accounts.enabled} onClick={() => void run(async () => { await accountApi.selectChatGPTAccount(null); await load(); changed(); setMessage("OpenAI chats now use your configured API-key/server funding policy. API charges may apply."); })}>Switch to API-key/server funding</Button> : null}
        <a className="text-sm text-primary hover:underline" href="/settings#model">Choose a model for your Genie</a>
      </div>
    </>}
    {attempt ? <div className="flex flex-wrap items-center gap-2"><span role="status" className="text-sm">Waiting for browser sign-in…</span>
      <Button onClick={() => void openSignIn(attempt.authorizationUrl).catch(() => setMessage("The sign-in browser could not be opened."))}>Continue sign-in</Button>
      <Button onClick={() => void run(async () => { await accountApi.cancelChatGPTSignIn(attempt.attemptId); setAttempt(null); setMessage("Sign-in cancelled."); })}>Cancel</Button></div> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}
    <a className="text-xs text-primary hover:underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage ChatGPT usage and app access</a>
  </section>;
}
