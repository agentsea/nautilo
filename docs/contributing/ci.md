# Contributor CI

Ordinary pull requests run the same lint, inventory, typecheck, unit-test and
database-migration gates. The default Linux runner is GitHub-hosted
`ubuntu-24.04`. Fork and Dependabot pull requests always use that default and
receive no Turbo or Socket credential through these workflows.

Maintainers may set `CI_LINUX_RUNNER` to an approved disposable larger runner
for same-repository pull requests. Its measured compiler parallelism belongs
in `CI_TYPECHECK_CONCURRENCY`; without both settings, typechecks run one
compiler at a time. The existing 5 GiB compiler heap is unchanged. GitHub's
[standard hosted Linux runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
provide at least 8 GiB. Runner access, fork-token permissions and integration
installation still need repository/organization settings; workflow conditions
are not a replacement for those controls. Do not grant fork jobs private
runner access or writable tokens to make them pass.

`TURBO_TOKEN` and `TURBO_TEAM` are optional cache acceleration for trusted
same-repository work. Missing credentials do not waive any build or test.
Socket's authenticated dependency scan needs `SOCKET_SECURITY_API_KEY`.
When that credential is absent, the scan writes **coverage: unavailable** to
the job summary and retained log, and never starts the authenticated scanner.
This advisory result is not a clean security verdict. The independent Socket
Firewall frozen-install check still runs, blocking findings still fail, and
ambiguous scanner failures still fail closed. Maintainers must obtain the
authenticated scan before treating its coverage as complete; a green advisory
job alone does not establish that coverage.

The separate **Contributor build** workflow runs on dependency/build-harness
changes and can also be dispatched manually. It starts from the exact source
archive as an unprivileged user in a fresh Linux container, runs ordinary `bun install
--frozen-lockfile` including postinstall, repository invariants, Workbench/CLI
builds and the server typecheck. It restores no dependency or Turbo cache and
passes no credentials, host home, Git history or Docker socket into the
container. The local Git commit exists only for build tooling. Source/tree IDs,
the archive hash, build output hashes and logs are retained as workflow
artifacts; failures remain failures. This is Linux source-build evidence, not
Desktop packaging, Mobile/store qualification or permission to publish an
official release.
