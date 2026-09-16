# Ops conventions

This doc is the single canonical reference for **where things go** in the `nautilo/` repo when adding deploy / ops / runbook content. Read it once; refer back when you're about to create a new file.

## File-suffix convention

| Pattern | Meaning | Tracked in git? |
|---|---|---|
| `*.example.<ext>` | Reference file. Operator copies, edits, saves under a different name (or outside repo). | Yes |
| `*.template.<ext>` | Reference with templating syntax (`${VAR}`) substituted at runtime. | Yes |
| `*.<ext>` (no suffix) | Working file. May contain secrets. | **No** — gitignored |

The repo's `.gitignore` enforces this for `.env`, `.toml`, and `.txt` files in known sensitive locations. If you add a new file pattern, update `.gitignore` AND mention it in this doc.

## Directory map

| Path | Purpose |
|---|---|
| `nautilo/infra/` | Local-dev docker-compose for OSS bring-up. `infra/compose/nautilo.yml` is profile-gated (postgres / +logto) and deliberately omits nautilo-server. `infra/caddy/` holds LAN-only D048 local-CA Caddyfiles. |
| `nautilo/deploy/` | Managed-mode IaC and deploy drivers. `deploy/compose-driver/templates/` houses the production Dockerfile + docker-compose.yml + Caddyfile that the compose driver scp's to the target. |
| `nautilo/ops/` | Operational scripts: rotation, audits, security probes. Operator-facing. |
| `nautilo/ops/runbooks/` | TypeScript orchestration for repeatable operator or private-maintainer procedures. Public instructions live on Nautilo.ai; version-coupled notes live beside the script. |
| `nautilo/scripts/` | Legacy one-off dev scripts (`red-team-env-var.sh`, `google-key-probe.sh`). Will consolidate into `ops/security/` post-Milestone-A; for now both coexist. |
| `nautilo/examples/` | Reference files used in docs. `.example.<ext>` only. |

## Documentation split

Public operator documentation lives on Nautilo.ai:

| Destination | Audience |
|---|---|
| [Operator documentation](https://nautilo.ai/docs/operator/choose-a-deployment) | OSS self-host operators bringing up and maintaining an instance |
| A companion README beside a script | Version-coupled implementation notes |
| Script source, tests, and `--help` | Private-maintainer procedures that are not product workflows |

## Where to put a new script

| Type | Goes in |
|---|---|
| Provider-key rotation | `nautilo/ops/secrets/rotate-<provider>.sh` |
| Security audit / probe | `nautilo/ops/security/<probe>.sh` |
| Backup helper | `nautilo/deploy/<driver>/backup.sh` (driver-specific) or `nautilo/ops/backup/` (driver-agnostic) |
| Deploy driver | `nautilo/deploy/<driver>/index.ts` (always TypeScript; bash is the exception, see below) |
| Private maintainer procedure run from an operator laptop | `nautilo/ops/runbooks/<procedure>.ts`; keep machine-specific defaults explicit and document them as non-product tooling |
| Bash that runs ON the deployment target (Droplet, container) | OK to ship as `.sh` — `host-setup.sh`, `backup.sh` are legitimate examples |
| Bash that runs ON the operator's machine | NO. Use TypeScript. The driver class shells out internally as needed. |

## When to ask vs. ship

If a new file's location isn't obvious from this doc, **add a row to the relevant table here as part of the PR that introduces the file**. Don't ask; document.
