# nautilo-dev

CLI helpers under `bin/nautilo-dev/` (for example `dev-stack`, `server-start`,
backup/clone, deletion, and checkpoint maintenance).

## Instances, scratch stacks, and Desktop profiles

The canonical default instance is the empty instance ID and stores operator
data under `~/.nautilo`. A named scratch instance such as `d489-review` stores
its server state under `~/.nautilo-d489-review` and uses its own Compose project
and allocated ports. `NAUTILO_PROFILE` is different: it selects an Electron
user-data profile and does not select, copy, or isolate a server database.

To create an absent scratch instance from the canonical default and launch an
isolated Desktop against it in one supported flow:

```bash
bun run dev-stack --instance d489-review --clone-default --electron
```

The command reuses the current verified bounded seed when possible. Add
`--refresh-clone-seed` only when a fresh capture is required. The seed store is
separate from ordinary recovery snapshots and retains only current, one
previous generation, or bounded failure evidence. Clone never compacts
checkpoints and never deletes the source. A populated target is intentionally
not overwritten; reuse it or delete that exact named instance first.

If the named server is already running and built, launch its isolated Desktop
through the same orchestrator:

```bash
bun run dev-stack --instance d489-review --no-infra --no-build --electron
```

The named instance already namespaces Electron user data. Add
`NAUTILO_PROFILE=<slug>` only when you intentionally need another Desktop copy
for that same named server. The standalone `bun run desktop <profile>` launcher
also honors an explicit loopback `NAUTILO_CONNECT_SERVER_URL`; do not enter the
URL manually through the picker for cloned-default acceptance.

## Backup, clone, and checkpoint maintenance

`bun run dev:clone -- --from <named-source> --to <absent-target>` preserves the
historical named-to-named clone workflow. Canonical-default cloning goes
through `dev-stack --clone-default`; both paths share one materialization spine.

`bun run dev:save <snapshot> -- --instance <id> --mode dump` captures both
databases and the instance home, including installed mini-apps, their enabled
state, and Workspace artifact storage. Current Folder files outside that home
remain host-owned and are not included.

To recover the same instance, stop its Desktop and server writers, keep both
PostgreSQL containers and Logto running, then use
`bun run dev:restore <snapshot> -- --instance <id> --require-logto`.
Restore takes an automatic safety snapshot before replacing state. Current V2
backups are verified for artifact hashes, instance identity, PostgreSQL majors,
and compatible migration history before mutation. Their complete database
archive is imported before missing migrations run, preserving the captured
schema, ledger, roles, memberships, and data. Legacy snapshots without a
manifest retain the older selective import path; a malformed V2 manifest is
refused rather than treated as legacy. Recovery finishes only after credential
reconciliation and authoritative runtime acceptance pass. Use cloning to
materialize another identity; a full restore cannot rename the target instance.

Checkpoint maintenance is a standalone, dry-run-first operator action:

```bash
bun run dev:compact-checkpoints -- --instance default
bun run dev:compact-checkpoints -- --instance default --apply --i-know-what-i-am-doing
bun run dev:compact-checkpoints -- --instance default --apply --reclaim-physical --i-know-what-i-am-doing
```

Dry-run inventory supports the canonical default or a named instance. `--apply`
is refused for named instances: it is canonical-default-only and also requires
`--i-know-what-i-am-doing`. Apply creates and verifies a bounded recovery
backup, quiesces writers, performs reference-safe semantic deletion, verifies
the retained state, and restores services. Physical reclamation is a separate
explicit option because it takes stronger locks. Neither server startup nor
`dev-stack` runs checkpoint deletion SQL.

## Shutdown and deletion

Stop only the selected instance's processes and preserve its data with:

```bash
bun run server:stop -- --instance d489-review
bun run infra:stop -- --instance d489-review
```

Delete a disposable named instance, including its volumes and instance root,
only with the explicit destructive command:

```bash
bun run dev:delete-instance d489-review -- --yes
```

The canonical default cannot be deleted by `delete-instance`. Do not use broad
Docker prune or recursive home-directory cleanup as a substitute for exact
instance deletion. On interrupted disposable/live acceptance, retain the
owner-only resource journal until parent-side cleanup has proved zero owned
Docker/filesystem bytes and no attributable containers, images/build cache,
volumes, networks, processes, credentials, or files.

## Troubleshooting

If `dev-stack` fails with `apps/workbench/dist/index.html not found`, your
workbench build produced no output. Run `bun run build:artifacts` to build the
shared Workbench runtime and SPA, then rerun `dev-stack`.
