# Nautilo Gateway local QA

Nautilo can route signed `openrouter:*` chat and embedding models through a
locally operated Nautilo Gateway. This integration is intended for an isolated
internal QA machine. It does not add a hosted deployment target or make the
Gateway an ordinary Nautilo hosting provider.

## Configure the server

The Gateway operator supplies two values:

- `NAUTILO_MANAGED_GATEWAY_BASE_URL` is the Gateway API root. It must end in
  `/v1`. HTTPS is required except for `http://localhost` or
  `http://127.0.0.1` on the QA machine.
- `NAUTILO_MANAGED_GATEWAY_API_KEY` is the one-time `ngw_...` credential shown
  by the local Gateway portal.

In **Admin → API Keys**, enter the API root in **Nautilo Gateway API URL
(coming soon)** and paste the credential into **Nautilo Gateway key (coming
soon)**. Nautilo saves both values through its protected server configuration,
validates the credential against the configured `/v1/key` endpoint, and
subsequently displays only a masked credential. Neither value needs to be
passed in local process configuration or activated with a server restart.

Do not place either value in a CLI adoption template or hosting-provider
configuration. The API root is operator-supplied; Nautilo has no default
production Gateway endpoint.

## Expected routing

When both values are valid, signed OpenRouter chat routes and automatic chat or
background roles prefer the Gateway. A Gateway request is never retried through
the SDK, repeated against the same model, or continued through a paid fallback
chain after a failure because the first request may already have incurred cost.
Direct credentials for explicitly selected unrelated providers keep their
existing behavior.

Existing automatic embedding identity remains stable. If the server already
uses Venice, direct OpenRouter, or OpenAI embeddings, adding the Gateway does
not change the provider, model, or dimensions that define the existing index.
A Gateway-only server can use the signed OpenRouter embedding route. Explicit
embedding selections retain their exact provider and model meaning.

The managed credential does not enable image, video, music, speech, search, or
other media routes. Those features still require their existing direct
credentials.

## Check and remove the setup

Use **Validate all** in the administrator API Keys section to confirm credential
admission. This proves that the key and configured endpoint are accepted; it
does not prove available inference capacity.

For the bounded QA pass, exercise one signed chat model with streaming and a
tool call, one background operation, and the configured embedding route. A
Gateway error should be visible without raw upstream diagnostics, and no direct
provider fallback should occur.

To return to direct-provider behavior, remove
`NAUTILO_MANAGED_GATEWAY_API_KEY` and `NAUTILO_MANAGED_GATEWAY_BASE_URL` from
the canonical server configuration and restart the local server. Removing the
Gateway configuration does not rewrite content or embedding indexes.
