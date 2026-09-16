# `ops/` — operator and fleet ops scripts

> **Status:** Operator tooling for independently managed Nautilo instances.

This directory is for **executable** operations tooling that
isn't infrastructure-as-code (see `deploy/` for that) and
isn't application code (see `apps/`, `packages/`, `bin/` for
those). Two operator audiences share this tree:

| Audience | Examples |
|---|---|
| **OSS operator** (someone running their own Nautilo) | `ops/secrets/rotate-provider-key.sh` running locally against `~/.nautilo-<id>/config.env` |
| **Fleet operator** (us, running managed mode) | Future managed-mode rotation tooling calling `deploy/`-provisioned KMS / Pulumi outputs |

When a script is meaningfully different between the two
audiences, name them apart (`-managed` suffix is fine). When
the same script works for both, prefer the operator-facing
form and document fleet adaptations inline.

## Layout

```
ops/
├── secrets/                  ← provider key + Logto admin rotation
├── backup/                   ← snapshot/restore beyond what bin/nautilo-dev exposes
├── runbooks/                 ← repeatable TypeScript procedures
├── security/                 ← red-team probes + key-leak scans (D116 P3 — landed Stack 6)
└── README.md                 ← this file
```

## Anti-goals (do NOT put here)

- IaC (Pulumi, Terraform, k8s manifests) → `deploy/`.
- Local-dev docker-compose stacks → `infra/`.
- Build / lint / test scripts that wire into turbo or
  package.json → `scripts/` (existing) or per-package
  `package.json scripts`.
- One-off security probes / red-team scripts → `ops/security/`
  (`red-team-env-var.sh`, `google-key-probe.sh` and friends).
- Operator-facing **documentation** (vs. executable scripts) belongs in the
  [public operator docs](https://nautilo.ai/docs/operator/choose-a-deployment);
  version-coupled notes belong beside the script in `ops/runbooks/`.

## Existing material that may eventually relocate here

These are not moved yet (would create churn against active
issues / playbooks); flagging for D116 to decide:

- `bin/nautilo-dev/src/commands/save.ts`, `restore.ts`,
  `verify.ts`, `gen-setup-template.ts` — these are dev-ops
  flavored but live in `bin/nautilo-dev/` because the
  `nautilo-dev` binary is the dev surface for them. Likely
  stays where it is; `ops/` would call them, not host them.

Instance-specific maintenance scripts and machine configuration belong outside
this repository. Retained scripts must accept explicit operator configuration
and be usable without access to a maintainer's machines or private records.
