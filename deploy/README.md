# Deployment code

This directory contains deployment drivers and release-qualification tooling.
It is distinct from `infra/`, which contains the Compose services used for
local development.

## Current layout

```text
deploy/
├── compose-driver/          # local and remote Compose deployment driver
├── contracts/               # shared deployment contracts
└── releases/qualification/  # release-candidate qualification tooling
```

`compose-driver/` implements the host-side deployment lifecycle used by the
Nautilo CLI: deploy, status, restart, logs, upgrade, backup, restore, and
destroy. It supports local Compose targets and SSH-managed remote targets.

For operator-facing deployment instructions, use the public documentation:

- [Choose a deployment](https://nautilo.ai/docs/operator/choose-a-deployment)
- [Local deployment](https://nautilo.ai/docs/operator/deploy/local)
- [Docker Compose deployment](https://nautilo.ai/docs/operator/deploy/docker-compose)
- [Linux server deployment](https://nautilo.ai/docs/operator/deploy/linux-server)

Repository-level implementation details are documented in
[`compose-driver/README.md`](compose-driver/README.md) and
[`releases/qualification/README.md`](releases/qualification/README.md).

## Boundaries

- Local-development Compose definitions belong in `infra/compose/`.
- Deployment-driver code and its target templates belong here.
- Repeatable operational scripts that are not deployment drivers belong in
  `ops/`.
- User and operator procedures belong in the public Nautilo.ai documentation;
  version-coupled implementation contracts stay beside the source.
- User-authored connection secrets are application data, not deployment code.

Do not add future infrastructure scaffolding until executable code or a
versioned contract needs it.
