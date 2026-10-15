# Connect a ChatGPT subscription

Nautilo can connect an eligible ChatGPT account to a user-owned Nautilo Server.
This integration uses OpenAI's public-client sign-in flow. It is separate from
provider API keys and the Codex agent connection. Commercial managed-server
subscription enrollment is disabled.

## Add an account

1. An administrator enables personal provider funding and grants your Human
   permission to use personal credentials.
2. Open **Settings → Personal API keys and subscriptions** and select
   **Continue with ChatGPT**. Use an updated Nautilo Desktop when connecting a
   remote Server or a Server inside Docker. Remote connections require HTTPS.
3. Complete sign-in and allow plan access in your system browser. Return to
   Nautilo and wait for **Connected**. Receiving the browser callback alone does
   not mean that Nautilo has verified and saved the account.
4. Select **Use for OpenAI chats**, then choose an eligible model for your Genie.
   **See eligible models** lists models available to that account and supported
   by Nautilo's current catalog. A connected account can have no eligible models.
   Once selected, **Used for OpenAI chats** confirms that account is active;
   you do not need to sign in again. Use **Add another ChatGPT account** only
   to connect another account.

Adding an account does not select it automatically. Multiple accounts and
workspaces stay separate. Existing API keys remain available. Browser and mobile
clients can use an account already connected to their Server; they cannot start
this Desktop loopback enrollment themselves on a remote Server. Mobile Settings
→ API keys and subscriptions shows linked accounts, eligible models, selection,
disconnect and an explicit switch back to configured API funding.

Credentials are encrypted on the selected Server. Its operator can decrypt them.
The Server owns token exchange, storage and refresh. Desktop receives the browser
callback code; it does not retain the subscription tokens.

## Funding and limits

An explicitly selected subscription funds eligible OpenAI text and client-tool
conversations. New queued Tasks retain the account and authority admitted at
creation; child work inherits its parent's subscription. Revocation, reconnect
or a changed permission can pause existing work rather than changing its payer.
Unsupported media, provider-hosted tools and separately billed services are not
available inside a subscription-funded Task. Protected workflows retain their
existing funding restrictions.

A subscription limit or outage never silently falls back to a paid API key or
Server credit. To change funding in Desktop or Workbench, choose **Switch funding**,
review the API-charge warning, then confirm the switch to API-key/server funding.
Cancelling keeps the subscription selected. This changes future admissions, not an
existing Task's pinned funding authority.

Personal Costs shows subscription token usage separately. API-equivalent
estimates are comparisons, not extra subscription charges. Nautilo does not
invent a remaining balance, credit allowance or reset time. Review actual limits
and app access in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).
An app-specific limit can apply even when the whole plan is not exhausted.

## Recovery

- **Sign-in unfinished:** choose **Finish sign-in**. Nautilo reuses the issued
  registration with a fresh authorization attempt; the old code is not reused.
- **Reconnect needed:** choose **Reconnect**. The verified account must match
  the saved registration. A temporary provider availability error calls for
  retrying later, without replacing your saved connection.
- **Interrupted response:** review any partial output before continuing. A
  missing completion event remains a failed or uncertain attempt and may have
  consumed plan allowance.
- **Disconnect:** clears local tokens while retaining account identity and
  selection. If remote revocation cannot be confirmed, remove app access in
  ChatGPT Settings too. Other accounts and API keys remain intact.
- **Lost custody or a different Server identity:** disconnect local access, add
  an account again, and explicitly select it. Nautilo cannot recover ciphertext
  without its original custody key.
- **After restoring a backup:** reconnect before subscription work resumes.
  Saved rotating tokens are not replayed from a backup. A QA clone starts with
  no copied personal provider registrations.

The provider contract is documented in OpenAI's [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
and [account and session](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
guides. Support varies by the provider's current eligibility and preview rules.
