# Working on Nautilo

Read [`README.ai`](README.ai) for the current architecture and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution scope. This file gives
repository-wide working rules; apply more specific guidance such as
[`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md) when working in that subtree.
The public documentation index is [`DOCS.md`](DOCS.md).

## Establish scope and current reality

- Start from the user's request, current source/tests, and public issue/PR
  evidence. Historical planning IDs and old verification dates are context,
  not proof that a feature is present or deployed.
- Small, understood defects can be fixed directly. New features, integrations,
  deployment targets, UI workflows, and substantial refactors follow the
  [proposal and specification process](CONTRIBUTING.md).
- Do not require a private roadmap, unpublished skill, sibling repository, or
  maintainer's local path to build or understand the public source.
- Inspect the checkout, branch, and dirty state before editing. Preserve other
  work; use an isolated worktree for substantial changes and stage only owned
  paths. Resolve routine implementation choices from evidence. Ask when a
  missing decision would change product behavior or authority.
- Do not start services, mutate databases, publish releases, or change external
  infrastructure outside the authorized task. Keep credentials, real user
  content, private paths, and signing material out of source, logs, and PRs.

## Preserve the execution boundaries

- **Workbench** (`apps/workbench`) is the shared browser UI served by the
  server. Desktop connects to it through Electron; do not create a duplicate
  Desktop UI or embed a server/database in the production app.
- **Mobile** (`apps/mobile`) owns native clients and Mobile Web. Use shared
  API/realtime contracts and explicit platform adapters. A native release's
  supported server modes come from its checked-in release contract.
- **Server / Agent / Runtime** own semantic admission, canonical task identity,
  routing, durable execution, and results. External agent, browser, and
  connected-app runtimes remain adapters to those owners.
- **Relay Host** owns Desktop's authenticated server WebSocket through
  `RelayClient`; Electron owns Human/session/grant/policy/native authority.
  The headless Relay is a separate consumer, not a Desktop feature-parity path.
- **Computer Use Host** owns Cua process supervision and provider parsing.
  Electron brokers admitted requests using attested runtime paths and private
  inherited pipes. Peekaboo is removed. Preserve generation fencing and do not
  replay ambiguous mutations through a fallback provider.
- Read [Relay/Host ownership](docs/relay-host-ownership.md) before altering local
  execution and [Connected Websites](docs/connected-web-browser-contract.md)
  before altering server-owned authenticated browser work.
- Preserve canonical Human, Genie, Room, Task, Namespace, Memory, Artifact,
  and device identities. Authorization, PIN/biometric consent, and encryption
  admission are distinct requirements. Do not bypass one with another or add
  plaintext/default-owner fallbacks.
- Office Core/Sheets are owned workspace source. Preserve upstream provenance,
  app lifecycle, document versions, and commit ownership. See
  [Office engines](docs/office-engines/README.md).

## Find the canonical implementation

The ownership table in [`README.ai`](README.ai) maps packages to concerns.
Trace the producer, authority check, persistent state, executor, and consumer
before editing a cross-package flow.

Product tool schemas/catalogue live under `packages/agent/src/tools` and their
shared contract packages. Contributor harness personas/commands live under
`dev/tools/<tool>/`; edit those canonical sources and follow their regeneration
instructions instead of changing generated `.claude/` projections. Remote
catalogues carry metadata, not permission to add executable routes or handlers.

Change the Drizzle schema before generating migrations with repository tools.
Never hand-write a generated migration substitute or disable row-level security
to fix a query. Preserve the typed query boundaries and close owned DB clients.

## Build and verify

Use Bun from the repository/workflow pin and the workspace lockfile:

```bash
bun install --frozen-lockfile
```

Run focused tests for changed behavior first. Unit tests must not require a
live server, database, provider account, or network service. Integration and
packaged acceptance are separate evidence, with explicitly owned dependencies.
For live development, inspect named instance resources before starting or
stopping anything; the default instance can contain real user data.

The standard full checks are:

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run lint:unused
```

[CI](.github/workflows/ci.yml) and
[`dev/scripts/ci-gates.sh`](dev/scripts/ci-gates.sh) also run the relevant
invariant inventories and affected package graph. Do not equate one focused
suite with all of CI. Report exact checks, skips, prerequisites, and failures.
Do not weaken checks to obtain a green result.

Run local Git hooks normally. Explicit maintainer authorization may select a
workflow that bypasses a local push hook while retaining full remote CI.
Never bypass required remote checks/reviews or force-push a shared base branch.
After a permitted feature rebase, use a recovery ref and `--force-with-lease`.

## Limits and hard-coded bounds

A local constant, comment, legacy observation, or existing test is not policy
authority for a timeout, retry, truncation, retention, page/batch size, payload,
or concurrency ceiling.

Run `bun run limits:check` when adding or changing a production/operator
boundary. Investigate producer-to-consumer behavior and record the evidenced
decision in local, ignored `*.limit-audit.*` files. Never commit audit inventories,
decision ledgers, generated reports, or `*.agent-notes.*` working notes. Public
CI compares source revisions and requires an exact-commit `limit-policy-reviewed`
status for new or changed limits; maintainers publish it with the limit package
`review` command only after the strict local check passes. Scanner output is an observation,
not a policy decision. Surface unresolved policy choices rather than inventing
authority. See [limit tooling](packages/limit-invariants/README.md) for commands.

Partial results must disclose completeness and continuation. Termination must
preserve truthful state, cleanup, and safe recovery.

## Release and documentation changes

Use [`RELEASE.md`](RELEASE.md) for channel-specific procedures. Desktop versions
come from release tags; CLI and Mobile have their own source-owned version
contracts. Merging does not establish artifact publication, public CDN/store
availability, or installed runtime adoption.

Update [`CHANGELOG.md`](CHANGELOG.md) for user-visible behavior. When bundled or
downloadable components change, reconcile manifests, checksums, provenance, and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Desktop and Server OfficeCLI
pins and their shared artifacts must stay aligned. Keep architecture and agent
guidance consistent with source; do not preserve obsolete instructions just
because they appear in an older document.

## Bun lockfile normalization

The contributor Bun runtime may add only `"configVersion": 0` to `bun.lock` in
a fresh worktree. If that is the entire diff, do not commit it as a dependency
change. Any other lockfile change requires ordinary review.

## Security reports

Follow [`SECURITY.md`](SECURITY.md) and
[private reporting instructions](https://nautilo.ai/security). Never place a
vulnerability, exploit, credential, or private conversation in a public issue.
