# Personal provider keys server policy

The server stores two settings in its database: **Allow personal provider keys**
and **Funding priority**. A first installation or upgrade keeps personal keys
off and defaults to **Personal keys first**. A missing policy row has the same
defaults. An unavailable policy store is an error, not a compatibility default.

A Human with `manage_server_settings` can save these settings in **Admin →
Server**. A reader with `read_server_settings` can inspect the saved values.
Failed saves leave the displayed effective policy intact. Priority remains
visible and can be saved while personal keys are off; it takes effect only
when both sources are available and permitted for an eligible member's model.

## Model choice and payment

When enabled, eligible members can manage personal keys in **Settings →
Personal API keys**, select a compatible model, and use their own Genie in a
private Room for supported foreground text chat. Model choices come from the
same signed catalogue and include both permitted server and personal routes
under either priority. Priority orders sources for the selected model; it does
not select one catalogue for the account.

| Available and permitted sources for the model | Personal keys first | Server keys first |
| --- | --- | --- |
| Both | Personal | Server |
| Personal only | Personal | Personal |
| Server only | Server | Server |
| Neither | Unavailable | Unavailable |

Personal funding requires the live enable switch and
`use_personal_provider_credentials`. Server funding requires
`use_server_provider_credentials`. Priority grants neither permission. An
OpenRouter model needs an OpenRouter credential rather than a direct key for
its upstream model brand. Server gateway routes remain server-only. Existing
server model qualification and narrower personal text-chat capabilities still
apply; personal vision, tools, background work and other paid capabilities
are not enabled by this preference.

Each new operation reads the saved policy without a restart. An admitted turn
keeps its funding source through retry or model fallback. Provider errors,
quota exhaustion, unavailable custody or credential replacement do not unlock
cross-source payment failover. Live permission, switch, ownership and
credential revision checks can stop the operation. Turning personal keys off
must never send a personal-only Human's request through a server key. Usage
records identify the source actually used; full keys never enter Job or
checkpoint state.

## API and deployment compatibility

The authenticated API is `GET /api/admin/server-provider-policy` and
`POST /api/admin/server-provider-policy`. Responses include
`allowPersonalProviderKeys` and `fundingPreference` (`personal_first` or
`server_first`). Updates accept a nonempty subset of those two fields and
reject unknown fields. For example, a legacy switch-only request
`{"allowPersonalProviderKeys": false}` preserves the saved preference.
Concurrent changes preserve omitted fields under the singleton row lock.

Normal deployment applies the additive migration. It does not enable personal
keys, enroll users, generate custody or rewrite provider credentials. Older
clients can still change the enable switch. Older server binaries use their
original personal-first behavior and cannot enforce a saved server-first
preference after binary rollback. A database restore restores both settings;
inspect them before opening a restored server to users.

Keep production activation deferred until the complete personal-key rollout
has been qualified. Use an isolated instance to check policy persistence and
routing. Soul setup, embeddings and shared-memory maintenance retain their
existing server service policies.
