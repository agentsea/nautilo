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

Fresh supported foreground and native Task admission resolves the selected
model's provider route through `resolveModelFunding`. Ordinary permitted group
Rooms, another Human's Genie, addressed turns, forks and the active Conductor
retain the initiating Human. Exact membership, content and invocation authority
are checked independently of funding; the addressed Genie's model remains
configured and its owner does not sponsor the caller. The live enable flag and
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

Native background, nested/delegated and scheduled Tasks retain canonical
causal lineage and their own admitted binding. Caller-funded schedule shortcuts
report back to their original Room. Child Tasks and paid capabilities admit
fresh work independently under the same policy; a failed parent cannot change
its payer by launching a replacement attempt.

Supported research/decisions, Browser Use, CloudConvert, generated media and
direct speech/transcription have capability-specific funding owners. Those
owners preserve the creating account through approvals, polling, cancellation
and recovery; a personal-only caller cannot spend server credentials. Ordinary
connected-account/local tools keep their existing authority, while hosted
platform-key actions independently require server-spending permission.
Surplus is an eligible transport within the chosen funding class. Its direct
recovery keeps that payer and exact model, with each uncertain or failed attempt
retained in Costs. Speech/transcription remain direct rather than Surplus.

Protected chat, Artifact handoff through caller-funded peer Tasks and live
mini-app Task adapters retain their current personal-funding exclusions. Memory
review/reflection/summarization and common embeddings retain server-service
funding until complete Memory-input provenance admission is implemented.
A private Room or Record ownership alone does not prove personal Memory
eligibility. Personal selections never change the common embedding model or
vector space. Database restore restores the saved policy; restore does not
establish credential custody readiness.

Key save/validation/deletion notifications refresh account readiness projections.
Personal historical Costs remain readable when spending is disabled. Attempt
records retain actual, estimated, pending or unknown evidence rather than
reporting an interrupted request as free. Content-free process leases recover
abandoned direct-personal attempts without repeating model inference.

Tests cover policy storage/concurrency, authenticated routes and client
contracts, funding resolution, dispatch, catalogue union, multi-user foreground/Conductor admission,
native Task lineage and attempt recovery. Provider-boundary integration tests use distinct synthetic server
and personal credentials with a fake transport.
