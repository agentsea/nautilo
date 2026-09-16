# @nautilo/operator-secrets

Shared parser / loader / atomic-appender for operator secrets files
(`~/.config/nautilo/secrets.env` and friends). Consumed by both the
operator-facing `@nautilo/cli` and the developer-facing
`@nautilo/dev-tools` binaries.

Conventions enforced (§13.2 / §13.3 of the security playbook):

- **Mode 0600** on POSIX, refused otherwise.
- **Refusal of paths inside any git work tree** (walks up looking for
  `.git`).
- **Symlink targets** must resolve inside `$HOME`.
- **Key regex**: `/^[A-Z][A-Z0-9_]*$/`.
- **Atomic write**: write to `tmp` → `chmod 0600` → `rename`. Never
  any other order.

## Why this is its own package

Before this package existed, the appender lived in `bin/nautilo-dev`
and reached into `apps/cli/src/lib/` via four-deep relative imports
(`../../../../apps/cli/src/lib/operator-secrets-shared.ts`). That
made `bin/nautilo-dev` depend on `apps/cli`'s source-tree layout
rather than its package contract, broke the workspace's
`bin/*`-should-never-touch-`apps/*` rule, and was invisible to the
TypeScript project-references graph. Extracting the logic here
makes the dependency declared (`workspace:*`) and surface-only.

See `tests/unit/loader.test.ts` and `tests/unit/appender.test.ts`
for the spec; both consumers share the same fixture set via this
package's own test suite.

## Forward-compat

`appendOperatorSecrets` is `async` even though its body is sync
today — the `await Promise.resolve()` placeholder is intentional,
satisfying `require-await` lint without changing the `Promise<void>`
return shape. D115 plans to add atomic-rotation I/O behind the same
signature. Do not "simplify" this to a sync function.
