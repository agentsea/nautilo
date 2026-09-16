# @nautilo/operator-secrets

Shared parsing, loading and atomic updates for operator secrets files, used by
the administrator CLI and developer tools.

## Default location

`defaultOperatorSecretsPath()` returns `~/.config/nautilo/secrets.env`.
This is the standard per-user default: `~` means the home directory of the
user running the command. It is not a maintainer-specific path. Callers can
pass an explicit path to the loader or appender.

The file contains local credentials and must remain outside source control.
This package documents its location and handling rules, not credential values.

## File handling

- On POSIX, existing files must have mode `0600`.
- Paths inside a Git worktree are refused.
- On POSIX, a file symlink's resolved target must be inside the user's home
  directory and satisfy the same file-mode check.
- Keys must match `^[A-Z][A-Z0-9_]*$`.
- Parsing supports comments, quoted values and an optional `export` prefix,
  without variable interpolation.
- A missing file loads as an empty object. Appending creates it by default;
  callers can disable creation with `createIfMissing: false`.
- Updates write a sibling temporary file with mode `0600`, then rename it
  into place.

The loader and appender return promises; consumers should await them.
See the [public exports](src/index.ts), [loader tests](tests/unit/loader.test.ts)
and [appender tests](tests/unit/appender.test.ts) for the API and edge cases.
