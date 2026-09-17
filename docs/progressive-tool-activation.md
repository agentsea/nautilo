# Progressive tool activation

Nautilo exposes only the small core tool set on a normal model step. Deferred
tools become available through an explicit `activate_tools` selection or a
reviewed, narrow intent pack. This reduces provider-bound schema size without
changing what an actor is authorized to use.

## Turn-based activation retention

Deferred schemas can remain selected across a short owner conversation window.
Configure the number of subsequent owner foreground turns in the checked-in
`nautilo.config.ts` file:

```ts
export default {
  tools: {
    activationRetentionTurns: 3,
  },
};
```

The default is `3`; accepted values are whole numbers from `0` through `20`.
There is deliberately no environment-variable alias for this setting. A value
of `0` preserves one-turn behavior: a lease created in turn `N` is absent on
the next owner foreground turn.

For the default `X = 3`, an activation or eligible dispatch in turn `N` starts
or renews the concrete tool's lease at idle age zero. Each new owner foreground
turn ages it once; model/tool loops and approval resumes within that turn do
not age it.

| Owner foreground turn | Lease idle age before selection | Schema selected when unused since `N` |
|---|---:|---|
| `N` (activation or eligible use) | `0` | yes |
| `N+1` | `1` | yes |
| `N+2` | `2` | yes |
| `N+3` | `3` | yes |
| `N+4` | `4` | no — expired before selection |

An eligible discoverable-tool dispatch renews only that concrete tool to age
zero; it does not renew unused family siblings. A current-turn intent pack
may select a deferred schema through the remaining graph loops, but it creates
no cross-turn lease until that eligible tool is used. `deactivate_tools`
removes both the current selection and its retained lease.

Retention is a selection hint, not authority or a promise of executability.
Each prompt/provider/execution site still applies the current catalog's policy,
role, health, relay capability, readable namespace, whitelist,
model-capability, approval, and dispatch gates. If a leased tool becomes
ineligible, its schema disappears immediately; it must not be described as
executable merely because it was retained.

Guest turns use an empty activation projection. They do not expose, age,
clear, create, or renew an owner's leases on a shared checkpoint. In eager
mode, every currently eligible schema remains selected regardless of lease
state; leases can still be seeded by eligible discoverable use for a later
return to progressive mode, but they do not broaden eager eligibility.

Older checkpoints may contain only the previous name list. The one-time
legacy migration recognizes missing lease metadata with its initialization
sentinel, seeds eligible names at age zero, and marks the lease state
initialized. A deliberately empty initialized lease list is not migrated again.

This residency feature does not own runtime-binding expiry, stale-plan recovery,
or a relay changing mid-turn. A retained schema never bypasses those live
admission checks.

## Inventory and classification

The authoritative inventory is
`packages/agent/src/tools/exposure/manifest.ts`.

- **Core** tools are always selected after normal eligibility checks. They
  include discovery and activation controls, skills and command discovery,
  memory coordination, turn control, basic research, and identity verification.
- **Families** group deferred tools by purpose: `memory`, `orchestration`,
  `filesystem`, `shell`, `desktop`, `browser`, `productivity`, `device`,
  `configuration`, `voice_media`, `time`, `research`, `skill_authoring`, and
  `command_authoring`.
- A family activation expands only its reviewed manifest members. The catalog
  then decides which of those members are eligible in this turn.

When adding a tool, classify it before registration:

1. Add a built-in to exactly one core/family manifest membership and register
   its matching `exposure` (`core` or `discoverable`). The manifest validation
   rejects missing, duplicate, and unknown built-in memberships.
2. Register an MCP or plugin tool with its source metadata, capabilities,
   namespace, health, approval metadata, and an explicit exposure decision.
   External tools are not silently made core; use `discoverable` unless the
   product review explicitly requires a small always-on control.
3. Add tests for its intended activation path and any unavailable relay,
   namespace, policy, whitelist, or model-capability condition. Registration
   metadata is not an authorization bypass.

## Reading the activation trace

With `NAUTILO_LOG_TOOL_CALLS=true`, both model nodes emit an aggregate-only
line such as:

```text
[nautilo/pre_model] tool-exposure mode=progressive registered=… eligible=… core=… intent=… activated=… retained=… prompt_schemas=… provider_schemas=… exclusions={…}
```

- `registered` is the catalog size before eligibility.
- `eligible` passed normal health, policy, namespace, and relay checks.
- `core`, `intent`, and `activated` explain overlapping selection categories.
  `retained` is the aggregate count of eligible selected schemas with live
  leases. It is a subset of `activated` and can overlap it; it is not an
  exclusive source classification.
- `prompt_schemas` and `provider_schemas` must match: descriptions and schemas
  are bound from the same selected set.
- `exclusions` is an aggregate count by gate (`policy_forbidden`,
  `relay_capability_missing`, `namespace_unreadable`, `whitelist_excluded`,
  `model_capability_missing`, and similar). It intentionally contains no tool
  names, user text, prompts, arguments, paths, namespace identifiers, or
  secrets.

An `eager` trace should increase selected schemas, not `eligible`; a change to
the latter indicates an authorization/runtime condition changed independently
of exposure selection.

## Temporary eager rollback

Progressive exposure is the default. To temporarily restore all schemas that
are otherwise eligible, set:

```bash
export NAUTILO_TOOL_EXPOSURE_MODE=eager
```

Restart the affected server process, reproduce the issue, and inspect the
activation trace for `mode=eager`. Remove the environment variable (or set
`NAUTILO_TOOL_EXPOSURE_MODE=progressive`) to return to the default.

The rollback changes selection only. It reuses the catalog resolver and cannot
expose tools rejected by actor policy, relay availability/capabilities,
namespace visibility, explicit tool whitelist, or required model capabilities.
It also does not change approval, dispatch, or execution policy.

Remove the rollback once the progressive-path defect is reproduced, fixed, and
covered by a regression test; the eager trace should no longer be needed to
complete the affected workflow.
