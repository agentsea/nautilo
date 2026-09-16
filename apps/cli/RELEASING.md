# Releasing `@nautilo/cli`

## Supported install paths

- **npm / Bun global**: `npm install -g @nautilo/cli` then `nautilo --version` (Node **24.x** runs `dist/index.js`).
- **npx / bunx**: `npx @nautilo/cli@<version> status` (pin the published semver; no global install).
- **Monorepo**: from repo root, `bun run --filter @nautilo/cli build` then `node apps/cli/dist/index.js …` (or `bun apps/cli/dist/index.js`).

## Runtime assets

The published CLI must be self-contained. `nautilo deploy` resolves the signed stable runtime image from `https://media.nautilo.ai/server/stable/manifest.json`, while `nautilo deploy --image <digest>` selects an exact immutable runtime; neither path may require a Nautilo monorepo checkout. Compose verbs need the templates from `deploy/compose-driver/templates` and runtime assets such as `infra/postgres-init.sh`; for npm/global installs those files must be copied into the CLI package during build/prepack, preserving their source-relative layout under `dist/` (`dist/deploy/compose-driver/templates/...` and `dist/infra/...`). A monorepo path fallback is acceptable only for source/dev execution. Source-build upgrade remains a contributor/dev mode when intentionally run from local Nautilo source.

Before publishing, inspect the package contents:

```bash
cd apps/cli
npm pack --dry-run
```

The listing must include `dist/deploy/compose-driver/templates/docker-compose.yml`, the other compose template files, and `dist/infra/postgres-init.sh`. Do not publish a CLI tarball whose deploy command depends on sibling `deploy/` or `infra/` directories outside the package.

## Signed standalone server-admin channel

The public server-administration candidate has a separate positive-allowlist
entrypoint at `src/server-admin-index.ts`. It contains Compose and hosting
lifecycle commands plus the reviewed identity and member-administration
surfaces below; it does
not import/register TUI/OpenTUI, Desktop, or any **other** ordinary
client/account surfaces.
A native macOS ARM64 source candidate can be built with Bun while disabling
implicit dotenv/bunfig loading:

The signed identity surface is `login`, `logout`, `whoami`, and the narrowly
scoped `change-password` recovery command. They
establish, remove, and inspect a target- and instance-bound Human session; they
are not a generic `auth` namespace. The standalone channel deliberately does
not expose raw identity-provider management, TUI
surfaces, or raw identity-provider administration. Wave 2 adds the bounded
`members` domain: invite create/list/revoke, member list/show, disable/enable,
protected password reset, and plan-confirm-remove with shared-room recovery.
These commands use the target-bound Human client, require `manage_members`,
return bounded server receipts, and never put invite/reset bearer material in
JSON or ordinary output.
For a server-marked first-use session, `change-password` accepts all password
material through hidden TTY input only and sends it directly to the selected
Nautilo server. It has no password flags, environment-variable inputs, or JSON
secret fields. The server enforces the configured Logto policy before writing
the password and keeps every ordinary product route blocked until success.

### Installed identity workflow

Select the deployment profile explicitly for automation. Browser PKCE is the
interactive default; `--remote` forces the device flow, and a headless process
selects the device flow automatically:

```bash
nautilo login --profile production
nautilo login --remote --profile production
nautilo whoami --profile production --format json
nautilo whoami --all --format json
nautilo change-password --profile production
nautilo logout --profile production --format json
```

`login` obtains the Logto issuer, application ID, resource, and verified
instance identity from the selected Nautilo server. It never accepts a
password argument. The resulting refresh session is stored under that profile
with owner-only permissions and is bound to the exact server target and
instance. `whoami` refreshes near-expiry credentials internally and reports
only the server-verified Human identity, groups, role, and effective Nautilo
capabilities. `whoami --all` is deliberately local-only and labels cached
sessions without contacting their servers.

If the selected profile, `--server`, or observed instance differs from the
saved binding, the command fails with `target_mismatch` before exposing the
session to a domain command. Select the original profile or run `logout` and
`login` against the intended server; do not copy session files between
profiles. Revoked or legacy refresh state fails with `login_required` and must
be replaced by a fresh login. Browser launch/callback failures can recover with
`login --remote`; cancellation and timeout save no session. `logout` is
idempotent and removes only the selected profile's session.

`nautilo self-update --rollback` leaves profile sessions in place. The prior
binary either reads the compatible session or fails closed and asks for login;
rollback never justifies weakening file modes, target checks, or session schema
validation.

### Installed invite workflow

Interactive Human output may display one clearly labelled one-time invite URL.
JSON and non-interactive creation require a new absolute `--handoff-file`; the
CLI reserves that owner-only file before asking the server to mint the invite.
Normal output reports only the invite ID, role, expiry, usage cap, audit state,
and recovery receipt.

```bash
nautilo members invite --profile production
nautilo members invite --profile production --format json --handoff-file /secure/new-member.json
nautilo members invite list --profile production --limit 50 --format json
nautilo members invite revoke <invite-id> --profile production --yes --format json
nautilo members provision --handle newperson --display-name "New Person" --role member --handoff-file /secure/newperson.json --profile production --format json
nautilo members rollout plan --file /secure/rollout.json --profile production --format json
nautilo members rollout apply --file /secure/rollout.json --fingerprint <sha256> --idempotency-key <stable-key> --handoff-file /secure/rollout-handoff.json --profile production --format json
nautilo members rollout status <rollout-id> --profile production --format json
nautilo members rollout resume <rollout-id> --handoff-file /secure/resumed-handoff.json --profile production --format json
nautilo members list --profile production --limit 50 --format json
nautilo members show <handle-or-id> --profile production --format json
nautilo members disable <handle-or-id> --profile production --yes --format json
nautilo members enable <handle-or-id> --profile production --yes --format json
nautilo members reset-password <handle-or-id> --profile production --yes --handoff-file /secure/reset.json --format json
nautilo members remove <handle-or-id> --profile production --format json
nautilo access catalogue --profile production --format json
nautilo access effective [user-id] --profile production --format json
nautilo access change plan --file /secure/rbac-operation.json --profile production --format json
nautilo access change apply --file /secure/rbac-operation.json --fingerprint <sha256> --yes --profile production --format json
nautilo security posture show --profile production --format json
nautilo security audit --profile production --limit 100 --format json
nautilo security audit --profile production --all --format jsonl
nautilo security approvals list --profile production --format json
nautilo security approvals revoke <approval-id> --profile production --yes --format json
nautilo security posture set --security-level cautious --profile production
# automation: open a protected descriptor, then select it without putting proof in argv
nautilo security posture set --security-level cautious --proof-fd 3 --profile production 3</secure/admin-proof
nautilo settings models show --profile production --format json
nautilo settings context show --profile production --format json
nautilo settings stenographer --profile production --format json
nautilo settings profile show --profile production --format json
nautilo settings models set --default-chat-model <catalog-model-id> --yes --profile production --format json
nautilo settings context set --max-room-context-percent 60 --yes --profile production --format json
nautilo settings profile set --name "Production" --visibility members --yes --profile production --format json
nautilo integrations providers --profile production --format json
nautilo integrations connections list --profile production --format json
nautilo integrations connections audit --profile production --format json
nautilo integrations connections set github token --profile production
nautilo integrations connections set github token --proof-fd 3 --profile production 3</secure/connection-value
nautilo integrations connections remove github token --yes --profile production --format json
nautilo integrations mcp list --profile production --format json
nautilo integrations mcp tools <server-name> --profile production --format json
nautilo integrations mcp check <server-name> --profile production --format json
nautilo integrations mcp enable <server-name> --yes --profile production --format json
nautilo integrations mcp disable <server-name> --yes --profile production --format json
nautilo integrations mcp tool <server-name> <tool-name> disable --yes --profile production --format json
nautilo integrations google status --profile production --format json
nautilo integrations google configure --proof-fd 3 --profile production 3</secure/google-oauth-client.json
nautilo integrations google remove --yes --profile production --format json
```

If creation disconnects after the request begins, do not blindly retry: list
invites and revoke the newly observed invite first. Revocation is idempotent
and re-observes state after an ambiguous response. Handoff files are never
overwritten and should be transferred once, then securely removed by the
operator after redemption.

Member selectors accept a stable ID or an exact normalized handle/display
name; ambiguous names fail before mutation and the bounded list/search output
provides stable IDs. Disable and enable observe current state first and are
idempotent. Password reset always reserves a new owner-only handoff file before
issuing the Logto one-time token.

`members remove` is plan-only without `--yes`. Its plan reports federated,
last-owner, self-target, and shared-room ownership boundaries. Resolve every
fresh shared-room blocker with exactly one `--archive-room <room-id>` or
`--transfer-room <room-id>=<new-owner-id>`, then execute with `--yes`; the CLI
re-observes blockers and the member immediately before permanent deletion. The
result preserves whether Logto revocation actually succeeded. A false or
unknown `logtoRevoked` value requires identity-provider reconciliation and
must not be reported as complete cleanup.

`members provision` sends only non-secret identity and role intent. The server
generates a Logto-policy-compliant temporary password and PIN, reuses the
canonical invite-redemption transaction to create the Human, personal Genie,
private room, recovery codes, and Group membership, and arms the first-use
gate. The CLI reserves a new `0600` handoff before mutation; temporary
credentials and recovery codes are written only there. Repeating the same
intent with the same idempotency key returns the existing receipt and never
reissues credentials. If the original handoff is lost, use `reset-password`.

`members rollout plan` accepts a versioned, secret-free JSON manifest containing
1–100 member identity/role intents. Planning is server-side and write-free. It
normalizes identities, rejects local and Logto collisions, enforces the caller's
delegation ceiling, and returns a fingerprint bound to the selected server's
durable identity and canonical role/group catalogue. A successful preview is
not authorization to mutate and explicitly reports that no changes were made.
Passwords, PINs, tokens, passphrases, secrets, and recovery codes are forbidden
at any depth; later rollout execution generates each credential server-side and
uses owner-only handoff files.

`rollout apply` re-plans on the server and rejects a stale fingerprint before
creating its durable operation. The idempotency key identifies one batch;
reusing it with another fingerprint is rejected, while repeating the same
batch returns its existing status and never reissues credentials. Credential
bytes are returned only by the request that created them, written to the
reserved handoff, fsynced, and then acknowledged. `rollout status` is always
secret-free. `rollout resume` advances only items whose durable state proves a
safe next step; ambiguous external work becomes `unknown`/`repair_required`
instead of being replayed.

`access catalogue` reads Nautilo's canonical capability, Role, and Group
catalogue and labels built-in versus custom definitions. `access effective`
returns only the server-computed projection for the verified caller or an
explicit stable user ID, including each granted capability's Group→Role
provenance. These commands never read or write Logto organizations or roles;
Nautilo remains the sole product-authorization authority.

`access change plan` submits one typed, secret-free Role/Group/membership
operation to Nautilo's canonical mutation engine and returns its authoritative
checks, consequences, audit preview, and opaque state fingerprint without
writes. `access change apply` requires both `--yes` and that exact fingerprint;
the server re-resolves authorization and state in one transaction, rejecting
stale, protected, last-owner, or anti-escalation violations.

`security posture show` returns the server's effective deployment, policy,
sandbox, and access facts. `security audit` requires `view_audit_log`, supports
actor, kind, time, and correlation filters, and follows opaque server cursors.
`--all --format jsonl` emits each page as it arrives and finishes with an
explicit `end` record; it is bounded retrieval, not a live stream. If the
retained snapshot changes during traversal, the command emits a typed stale
continuation failure and the operator restarts from page one.

Standing approvals are always scoped by the server to the signed-in Human.
Revocation previews the observed rule unless `--yes` is supplied and remains
idempotent if the rule is already absent. Posture mutation exposes only the
supported deployment/security intents. The current/proposed values are shown
before an interactive hidden prompt; the PIN itself is the confirmation, so
there is no redundant `--yes`. Automation must deliberately pass an already
open descriptor with `--proof-fd`; PIN values are never accepted through argv,
environment variables, JSON, help, completion, or ordinary output. The CLI
re-reads posture after apply and reports the verified state.

`settings models` and `settings context` use the existing server-owned policy
APIs; model IDs and numeric bounds are validated by the server. Reads require
`read_server_settings`; writes require `manage_server_settings`, explicit
`--yes`, and re-read the effective value after apply. `settings stenographer`
is content-free and bounded to operational counts plus five typed recent
failures; degraded output gives recovery guidance but never claims repair.
`settings profile` always names the selected server target so its public
identity cannot be confused with the local CLI deployment profile. Profile
writes expose only name, description, and visibility intents and re-read the
canonical server profile after apply.

`integrations providers` projects only configured readiness by provider class;
it never forwards internal environment names, masked fragments, signup URLs,
provider URLs, validation hints, or upstream bodies. `integrations connections`
is scoped by the server to the signed-in Human's readable Namespaces. List and
audit return metadata and typed finding classes only. Set/rotate values are
write-only and accepted through a hidden prompt or deliberate `--proof-fd`
after target/session verification; they never enter argv, environment, or
ordinary output. Removal requires `--yes` and reports `missing` as an
idempotent no-op. The server continues to enforce its owner-or-loopback
boundary for Connection set/remove, so registering these commands does not
widen remote authority.

`integrations mcp list/tools/check/enable/disable/tool` uses typed client projections that intentionally
discard transport configuration, environment passthrough names, commands,
arguments, headers, URLs, and relay internals. It reports only stable identity,
tier/host class, enablement, typed health/check state, timestamps, and tool
enablement. Lifecycle operations are server-authorized, confirm-first where
they activate code or remove configuration, and followed by a fresh redacted
observation. `integrations google status` uses only the redacted status
endpoint and labels the OAuth client secret write-only and user tokens
excluded. Configure reads bounded OAuth JSON only from `--proof-fd`, uploads it
without echoing it, and then rereads redacted status. Remove requires `--yes`
and does not delete existing per-user Google tokens. The older full
OAuth-client JSON read remains deliberately unregistered because it can contain
the client secret. Generic MCP add/update remain excluded: their transport
configuration is not a safe secret-free intent contract. MCP install, generic
update, and delete remain excluded from the CLI surface.

```bash
bun build --compile src/server-admin-index.ts \
  --target=bun-darwin-arm64 \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  --outfile /tmp/nautilo
```

That compile alone is **not** a releasable standalone artifact. The release
candidate is instead a versioned bundle with a real filesystem layout:

```text
nautilo-cli-<version>-<platform>/
├── bin/nautilo
├── share/nautilo/
│   ├── deploy/compose-driver/templates/docker-compose.yml
│   ├── infra/postgres-init.sh
│   └── bin/host-port-probe
└── artifact-manifest.json
```

Build a local Darwin ARM64 candidate into an empty external directory:

```bash
bun run build:standalone -- --output /tmp/nautilo-cli-candidate
```

The normal build records a clean `git HEAD`; it refuses a dirty checkout so
the manifest never labels uncommitted bytes as a committed source revision.
`--source` exists only for isolated builder tests, not release candidates.
This slice builds only for the running native macOS arm64/x64 host and rejects
cross-target, Linux, and Windows requests; those platform contracts remain 0C.2.
The builder also writes a CycloneDX SBOM and an exact license inventory beside
the archive. They come from Bun's compiler metafile—the dependency closure
actually embedded in the executable—not from the entire checkout or declared
but unused dependencies.

To run the local no-Docker qualification after building, append `--qualify`:

```bash
bun run qualify:standalone -- --output /tmp/nautilo-cli-candidate
```

It extracts the archive beneath a fresh temporary directory, runs version/help,
executes the verified native port-probe helper through a named Compose profile,
and gives a fake Docker executable the first read-only `compose ... ps` call.
It asserts that Docker received the packaged `share/nautilo` template path;
the expected later local HTTP health failure proves no stack was started.

The builder compiles the positive-allowlist entrypoint with dotenv/bunfig
autoload disabled, compiles the existing host-port probe into a companion native
helper, copies only assets reached by the locked Compose lifecycle,
generates an exact path/size/SHA-256/mode manifest, verifies it, and writes a
deterministic `.tar.gz` beside the directory. A compiled binary resolves only
the sibling `share/nautilo` tree and verifies every file before it creates a
Compose driver; it never falls back to a source checkout. The manifest is
integrity metadata only in 0C.3—it is not a signature and does not authenticate
an artifact. D488 0C.6/0C.8 binds it to the Ed25519 release root before any
public install path may trust it.

Do not publish this local candidate, treat its checksum as a signature, or work
around a missing bundle with a source checkout. Local qualification establishes
native behavior and audit evidence; official release authenticity and public
availability are separate checks.

The standalone compiler resolves `@napi-rs/keyring` directly to the exact
native package installed on the current macOS runner. It rejects cross-target
builds and version mismatches. The finished executable is then audited for the
target Mach-O CPU, the exact native binding, absence of foreign bindings,
absence of foreign client runtimes, and absence of checkout or generated
absolute `node_modules` loader paths. `qualify:standalone` additionally performs a
random, qualification-only Keychain write/read/delete and proves absence after
deletion; it never prints the service, account, or value. This is native
runtime acceptance, not artifact authenticity or publication evidence.

After a qualified build, install D490's checksum-pinned scanners into a fresh
temporary directory and generate the platform evidence into another empty
directory:

```bash
bun packaging/docker/exact-image-audit-tools-cli.ts --destination /tmp/nautilo-audit-tools
bun run --cwd apps/cli audit:standalone -- \
  --build-receipt /tmp/nautilo-cli-build-receipt.json \
  --tools /tmp/nautilo-audit-tools \
  --output /tmp/nautilo-cli-evidence
```

The audit requires the exact pinned Syft and Grype versions, a checksum-bound
valid vulnerability database, zero unexcepted high/critical findings, complete
license metadata for every compiler-reachable package, bounded disclosure
coverage of every shipped byte, the compiler's no-autoload receipt, native
audit, and the checkout-free runtime receipt. It emits eight indexed reports
plus one unsigned platform gate receipt bound to source, version, platform and
archive SHA-256. Syft currently identifies no packages inside Bun's executable;
that zero result is retained explicitly as independent scanner coverage and is
never presented as the SBOM. The compiler-closure CycloneDX document is the
authoritative dependency inventory. Official manifest signing is maintained
outside this repository.

### Public release sequence

Official signing and publication are maintained outside the product repository.
Contributors can build and audit local candidates without release credentials;
these candidates do not carry Nautilo's official Developer ID signature.

The signed standalone channel preserves the version in `package.json`, generated
`src/version.ts`, the lock importer and the immutable `cli-vX.Y.Z` tag. Its exact
eight-asset handoff contains the signed manifest, release record and native
installer/archive/evidence for ARM64 and Intel. Hosting/server manifests belong
to the separate server release channel.

The installed CLI and installer verify pinned public keys, version/source,
platform and exact artifact hashes. A source merge or internal asset upload does
not prove that the ordinary stable manifest has advanced. Verify the public
manifest and a fresh installer before reporting release completion. Never reuse
a published version for changed bytes.

The stable installers are [ARM64](https://media.nautilo.ai/cli/stable/install-nautilo-darwin-arm64)
and [Intel](https://media.nautilo.ai/cli/stable/install-nautilo-darwin-x64).
The installer and `nautilo self-update` embed the independently committed CLI
public key. They accept only the exact HTTPS release origin, reject redirects,
verify the manifest signature and artifact size/SHA-256/SHA-512, extract beneath
a temporary directory, smoke the new binary, then atomically activate it under
`~/.local/share/nautilo-cli`. The prior version remains available through
`nautilo self-update --rollback`; ordinary update refuses a downgrade. Failed
download, signature, extraction or smoke checks leave the active executable
untouched.

## Local ESM package checks

Contributors can build and inspect the ESM package from an installed workspace:

```bash
bun run --cwd apps/cli build
bun run --cwd apps/cli test:unit
cd apps/cli
npm pack --dry-run
```

The build copies Compose templates and PostgreSQL initialization assets into
`dist/` through `scripts/copy-compose-templates.ts`. Check the package contents
against [Runtime assets](#runtime-assets). These commands build, test and inspect
local files; official distribution follows the
[public release sequence](#public-release-sequence) and the
[standalone administrator CLI contract](../../RELEASE.md#standalone-administrator-cli).

## Version string

`nautilo --version` prints `nautilo <cli-version> (api <api-client-version>)`, both baked in at build time (not read from disk at runtime).
