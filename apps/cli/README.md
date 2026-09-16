# @nautilo/cli

Administrator and operator CLI for Nautilo. It manages setup, authentication,
profiles, deployments, status, diagnostics, backup/restore, and release
lifecycle operations. It is not an interactive chat client.

## Requirements

- Node **24.x** (matches `engines` in `package.json`; the published `bin` runs `dist/index.js` under Node)
- Bun **1.3.11** optional for monorepo dev (`bun apps/cli/src/index.ts`)
- Loopback-only `nautilo setup` (`127.0.0.1`, `::1`, `localhost`, or a Unix HTTP socket path)

## Install

```bash
npm install -g @nautilo/cli
# or
bun install -g @nautilo/cli
```

From the monorepo:

```bash
bun run --filter @nautilo/cli build
node apps/cli/dist/index.js --version
node apps/cli/dist/index.js deploy --help
```

The built CLI bundles `@nautilo/*` workspace deps via `tsup`. For packaged/global installs, compose deploy templates and runtime assets must ship inside the CLI package (mirroring the source relative layout under `dist/deploy/compose-driver/templates` and `dist/infra`) and be resolved relative to the installed entrypoint. Published `nautilo deploy` resolves the signed stable runtime image from `https://media.nautilo.ai/server/stable/manifest.json`, while `nautilo deploy --image <digest>` selects an exact immutable runtime; neither path may depend on a sibling monorepo checkout. Source-build upgrade remains a contributor/dev mode when intentionally run from local Nautilo source. See `RELEASING.md` for the packaging check.

## Usage

```bash
nautilo --version
nautilo setup --print-template
chmod 600 setup.toml   # after editing secrets
nautilo setup --file setup.toml --delete-file
nautilo login
nautilo status --format human
nautilo status --format json
nautilo --server http://127.0.0.1:3001 status
```

Running `nautilo` with no subcommand prints administrator command help.

Global `--server` wins, then a template `serverUrl` (for `setup` only), then `NAUTILO_SERVER_URL`, then the instance default (see `resolveCliServerUrl` in `@nautilo/api-client`).

Errors go to stderr; exit code **2** on failure, **0** on success. Set `NO_COLOR=1` to disable ANSI coloring where supported.

## Repairing relocated artifact references

If an existing Compose instance's artifact bytes were moved but its stored
`file://` references still name the original root, use `artifacts-relocate`.
This repairs artifact, attachment, and all three document-history physical URI
columns together. It preserves content, revisions, timestamps, ownership,
logical paths, and history hashes. It does not copy files or restart services.

Use a retained version 2 full recovery bundle from this same instance as the
original-byte authority. First verify its manifest SHA-256 against the backup
receipt kept when the bundle was created. Keep the bundle available for both
planning and application. The command runs the canonical full-bundle verifier
and compares each referenced file with its exact regular archive member;
matching file sizes alone are insufficient. It refuses symlinks, encrypted
artifact records, ambiguous paths, missing originals, and changed bytes.

```bash
nautilo --profile my-server artifacts-relocate plan \
  --from-root /old/instance/artifacts \
  --backup /secure/backups/original-full-bundle \
  --plan /secure/repair-plan.json

# Review the owner-only plan and use the planSha256 returned above.
nautilo --profile my-server artifacts-relocate apply \
  --plan /secure/repair-plan.json --sha256 <planSha256>
```

Planning reads the instance and creates a new local mode-0600 plan without
replacing an existing file. The plan contains private artifact metadata: keep it
in a private operator directory and do not post it in logs or issues. Application
rechecks the exact running containers, image, instance identity, original backup,
and target files. It locks the three metadata tables without waiting and refuses
any changed snapshot. A failed SQL operation rolls back the whole transaction.
Concurrent artifact activity can invalidate a plan; investigate, then create a
new plan in a new file rather than editing an existing one.

`rollback` uses the same `--plan` and `--sha256`, but also requires every original
file to be freshly present and byte-identical at the old root inside the server.
It refuses to restore broken references to an absent old directory. If any
non-storage metadata changed after application, rollback also refuses. A
connection or readback failure after commit can leave the result uncertain;
retain the plan and inspect the instance before retrying. Repeating an unchanged
successful plan is idempotent. Finally, verify downloads and document history in
the authenticated app: a metadata commit alone is not UI acceptance.

## Provider setup files

Download a fill-in template from the [local](https://nautilo.ai/docs/operator/deploy/local)
or [Railway](https://nautilo.ai/docs/operator/deploy/railway) guide. The same
templates ship in this package as `templates/nautilo-deploy.toml` and
`templates/nautilo-railway-providers.toml`.

Railway accepts every registered service key: OpenAI, Anthropic, OpenRouter,
Venice, Google, Fireworks, Groq, ElevenLabs, Tavily, Browser Use, CloudConvert,
and a custom OpenAI-compatible gateway. Gateway endpoint configuration remains
separate. Unknown fields and infrastructure credentials are rejected.

Protect the file with mode `0600` before adding secrets. Fill in the enabled
values and delete unused lines. Do not share the completed file.

```bash
# Audit the template and provider file without mutating Railway.
nautilo host adopt --backend railway --provider-config "$HOME/.config/nautilo/providers.toml"

# Adopt the audited template and supply the keys during setup.
nautilo host adopt --backend railway --provider-config "$HOME/.config/nautilo/providers.toml" --yes --finish guide
```

For CLI-created projects, pass `--provider-config` and `--all-providers` to
`host plan` and `host deploy`. Template adoption only reads credentials when
you supply `--provider-config`; ordinary adoption does not import workstation
keys. Resume retains the selected provider identities and uses protected
keychain custody. To change keys after setup, use the Server Guide's
**API Keys** action.

## Related files

- `templates/nautilo-setup.quickstart.toml` — commented sample template
- `RELEASING.md` — manual publish and compile-binary deferral note
