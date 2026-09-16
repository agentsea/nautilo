# Deploy and Host Nautilo with Railway

Nautilo is an open organization-level harness where people and machine people
work, co-create, and act together. This template creates a complete private
Nautilo server on Railway, with durable data, integrated identity, and a guided
administrator handoff through the signed Nautilo CLI.

## About Hosting Nautilo

Your Railway workspace owns and pays for the deployment. The template creates
five services, three persistent volumes, and two generated HTTPS domains, then
deliberately holds normal application startup until the Nautilo administrator
CLI verifies the topology and adopts it. Internal database passwords and setup
tokens are generated automatically; you do not copy credentials or Railway
resource IDs into Nautilo. After adoption, the same receipt-backed CLI provides
inspect, upgrade, interruption recovery, protected recovery points, and safe
teardown. Model-provider keys are optional during deployment and can be added
later from Nautilo's Server Guide.

Adoption automatically selects the latest signed stable Nautilo release. The
held setup service does not contain a Nautilo runtime version; the CLI attaches
the verified runtime before starting it. You do not choose an image or version.
Running instances use explicit CLI upgrades, and interrupted setup resumes the
release already selected for that operation.

## Common Use Cases

- Run a private workspace where people and AI agents collaborate.
- Host a durable organization-level agent environment under your own Railway account.
- Give a team one governed place for chat, tools, knowledge, and automated work.
- Operate Nautilo with guided upgrades, recovery, inspection, and teardown.

## Dependencies for Nautilo Hosting

- PostgreSQL with pgvector for Nautilo application and agent data.
- PostgreSQL for Logto identity data.
- Logto for authentication and organization identity.
- The signed Nautilo administrator CLI for verification, adoption, and day-two operations.

### Deployment Dependencies

- [Install and use the Nautilo administrator CLI](https://nautilo.ai/docs/operator/deploy/railway)
- [Railway volumes](https://docs.railway.com/reference/volumes)
- [Railway private networking](https://docs.railway.com/reference/private-networking)
- [Nautilo community support](https://nautilo.ai/community/support)

### Implementation Details

Use signed Nautilo CLI **0.1.32 or later**. Check `nautilo --version` and run
`nautilo self-update` before deployment if you have an older CLI.

Leave the generated values, immutable image references, ports, commands,
volumes, and healthcheck unchanged. After Railway finishes creating the held
project, run the mutation-free verification:

```bash
nautilo host adopt --backend railway
```

Continue only when it reports exactly one held Nautilo project is ready and
Railway changes are `none`. Then adopt it:

```bash
nautilo host adopt --backend railway --yes --finish guide
```

The CLI releases services in the required order and remains attached through
first-owner readiness. If interrupted, do not deploy a second template; resume
the saved operation:

```bash
nautilo host resume --backend railway
```

Claim the server in the browser, save the recovery codes, and continue in the
Server Guide. Provider keys are not required for Help, Admin, Settings,
Security, or human-only chat.

## Why Deploy Nautilo on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway
hosts the services, databases, networking, and persistent volumes while keeping
the project in your workspace and under your billing control.

By deploying Nautilo on Railway, you are one step closer to supporting a
complete full-stack application with minimal burden. Host your servers,
databases, AI agents, and more on Railway while Nautilo's signed CLI provides
the product-specific verification, adoption, upgrade, recovery, and teardown
journey.
