# Provider funding policy contract

`server_provider_policy` is the database-backed singleton owned by the Server.
Its fields are `allowPersonalProviderKeys` and `fundingPreference`
(`personal_first` or `server_first`). A missing row resolves to personal keys
disabled and personal-first. Storage errors propagate; they are not missing-row
defaults. The additive funding-preference migration preserves the existing
allow flag and gives existing rows personal-first.

## API and authority

`GET /api/admin/server-provider-policy` requires `read_server_settings` or
`manage_server_settings`. `POST` requires `manage_server_settings` and accepts
a nonempty subset of the two fields. Both return the complete policy. Unknown
fields and invalid values are rejected. Updates lock the singleton row,
preserve omitted fields, and audit the previous and effective policy.

Legacy switch-only requests preserve a saved funding preference. An older
strict response decoder does not accept the extended response; a loaded older
Workbench must refresh after upgrade. The current client defaults a missing
funding field in an older server response to personal-first. Older binaries
retain their original personal-first behavior after rollback and cannot enforce
a stored server-first preference.

## Runtime ownership

Fresh supported own-Genie private-Room text-chat admission resolves the selected
model's provider route through `resolveModelFunding`. The live enable flag and
`use_personal_provider_credentials` govern personal funding;
`use_server_provider_credentials` governs server funding. Priority grants no
Capability. With both matching sources permitted and configured, the saved
preference selects the source. Exclusive routes remain available through the
caller-specific union of the signed catalogue under either preference.
Server-first usable server routes require no personal-row lookup or custody.

Admitted operations retain their source through retry and model fallback.
Provider, quota, credential or custody failures do not authorize payment
failover. Live switch, Capability, ownership and credential-revision checks
remain authoritative. Usage records the actual funding source; decrypted keys
stay at the trusted provider boundary, outside Job and checkpoint state.

This policy does not extend personal funding to background work or paid
auxiliaries. Soul setup, embeddings and shared-memory maintenance retain their
existing server service policies. Database restore restores the saved policy;
restore does not establish credential custody readiness.

Tests cover policy storage/concurrency, authenticated routes and client
contracts, funding resolution, dispatch, catalogue union and foreground
execution. Provider-boundary integration tests use distinct synthetic server
and personal credentials with a fake transport.
