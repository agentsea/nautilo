# Desktop packaging and artifact trust

The source tree builds contributor packages. Official Desktop signing,
notarization and publication are operated separately by the maintainers.
Contributor builds do not need release credentials.

## Build a contributor package

From the repository root:

```bash
bun install --frozen-lockfile
bun run --cwd apps/desktop package:dev
# Or build a universal macOS installer and ZIP:
bun run --cwd apps/desktop package:mac
```

These commands clear inherited signing credentials, disable certificate discovery
and notarization, and use the explicit ad-hoc identity `-`. The checked-in builder
configuration also defaults to ad-hoc packaging. Its custom hook rejects any
certificate-backed identity before calling the packaging dependency.

Ad-hoc signatures preserve bundle integrity for local builds; they do not identify
the official publisher or establish notarization. Development versions cannot
participate in the production updater. The
[contributor packaging workflow](../../.github/workflows/desktop-package.yml)
runs the same build and smoke checks without release credentials or publication.

## Preserve native helper contracts

The public contract in `scripts/native-helper-contract.cjs` defines stable paths,
identifiers and entitlement files for Cua, Computer Use Host and the Screen
Recording helper. Ad-hoc packaging applies each helper's narrow entitlements only
to its exact bundled executable. The enclosing app retains its permission strings;
Electron helper entitlements exclude host-only Computer Use permissions.

`entitlements.mac.unsigned.plist` and its inherited counterpart permit ad-hoc
libraries to load. The standard entitlement files remain public product contracts
for artifacts that carry a publisher identity. Changing an entitlement or helper
identity requires native qualification of the resulting artifact.

## Inspect and test an artifact

`after-pack.cjs` checks package inventory, permissions and Electron fuses.
`after-sign.cjs` verifies completed signatures, helper identities and entitlements;
it performs no certificate import, signing or notarization. Keep these public
verification checks when changing packaging.

From `apps/desktop`, after building:

```bash
bun run smoke
bun run smoke:ports
bun run smoke:paths
bun run inspect:mac:local-network -- release/mac-arm64/Nautilo.app --expect-signature adhoc
```

Set `SMOKE_APP_PATH` and `APP_PATH` to the absolute app path when testing a
universal package. The smoke harness checks boot, preload surfaces, logs, port
collisions and relocated paths. It does not replace live authentication, paired
server or native permission acceptance. Use an isolated profile and instance;
do not run a competing copy with the same installed production identity.

Official downloads are listed in [GitHub Releases](https://github.com/agentsea/nautilo-public/releases).
Verify their checksums, publisher signature and notarization before installation.
The standard [updater manifest](https://media.nautilo.ai/desktop/stable/mac/latest-mac.yml)
is a consumer contract; its presence in a contributor build does not authorize
publication. See [package inventory](PACKAGE-MANIFEST.md) and
[production architecture](PRODUCTION.md) for runtime boundaries.
