# Nautilo

<div align="center">

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

Code and documentation are currently in English. Translation PRs are welcome;
see [translation contributions](CONTRIBUTING.md#translations-and-localization).

### AI goes multiplayer.

</div>

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**Your own super agent. Your people and their Genies. You own the intelligence.**

Meet your Genie. Give her a personality, memory, face, and voice. Write, research,
and make things together. Bring your people and their Genies into the same Room.
Your server. Your models. Your rules. Open source. MIT licensed.

## Get started

**Your first Nautilo. From an empty server to something you made together.**

[![Elias and Lyra working together in Writer, with changes ready to review. Open the illustrated local setup guide.](https://nautilo.ai/docs/operator/first-nautilo/writer-review.png)](https://nautilo.ai/docs/operator/deploy/local)

### [Try it locally on your Mac →](https://nautilo.ai/docs/operator/deploy/local)

Meet your Genie, make her yours, and create your first document together.
Follow the illustrated guide.

You'll need **Docker Desktop** and **a model API key**. Nautilo is in **alpha**.

**For your team:** [Deploy to your datacenter or VPS →](https://nautilo.ai/docs/operator/deploy/linux-server)

**Already have a server?** [Download Desktop for Mac →](https://nautilo.ai/download/mac) · [Download Mobile →](https://nautilo.ai/download#download-platforms-title)

## Bring your people. Bring their Genies.

Bring your people and their Genies into the same Room. Pull an idea apart, write the first draft, send a Genie off to research the missing piece. Give yours a personality you want to spend time with.

Then grab the controls. Rewrite the paragraph. Move the lettering. You shouldn’t need a better prompt to move a word three inches to the left.

And keep the keys to your own house. You choose the models, run the server, and decide who gets access. Sharing a Room shouldn’t mean handing over your whole life.

[Models & API keys](https://nautilo.ai/docs/operator/provider-keys) · [Security & privacy](https://nautilo.ai/docs/security)

## Find your way around

| Guide | What it helps you do |
| --- | --- |
| [Documentation](https://nautilo.ai/docs) | Find the user, operator, or builder path. |
| [Use Nautilo](https://nautilo.ai/docs/use) | Learn Rooms, Genies, creative tools, and everyday workflows. |
| [Run Nautilo](https://nautilo.ai/docs/operator) | Deploy, configure, administer, and maintain a server. |
| [Build on Nautilo](https://nautilo.ai/docs/build) | Understand the architecture and develop against the source. |
| [Skill pack](https://nautilo.ai/skills) | Find Nautilo guidance for AI assistants. |
| [Design principles](https://nautilo.ai/principles) | Understand the judgments that shape the product. |
| [Versioned documentation index](DOCS.md) | Find source contracts, packaging, releases, and operational runbooks. |

## Explore the code

This monorepo contains the applications and shared packages that make Nautilo
work. Follow the links straight to the part you want to understand or change.

### Applications

| Application | Role |
| --- | --- |
| [Workbench](apps/workbench) | The shared browser UI, also used inside Desktop. |
| [Desktop](apps/desktop/README.md) | Electron client, local workstation integration, and packaging. |
| [Mobile](apps/mobile/README.md) | The React Native / Expo mobile client. |
| [CLI](apps/cli/README.md) | Server deployment and administration from the terminal. |
| [First-party apps](packages/first-party-apps) | Bundled creative applications: [Writer](packages/first-party-apps/writer), [Sheets](packages/first-party-apps/spreadsheet), [Slides](packages/first-party-apps/presentation), [Board](packages/first-party-apps/board), [Design](packages/first-party-apps/design), [Video](packages/first-party-apps/video). |

### Core packages

| Package | What lives here |
| --- | --- |
| [Agent](packages/agent) | Agent graphs, prompts, model providers, and [built-in tools](packages/agent/src/tools/register-all.ts). |
| [Runtime](packages/runtime) | Conversation coordination, task execution, jobs, sessions, and events. |
| [Server](packages/server) | Fastify HTTP and WebSocket APIs serving the clients. |
| [Database](packages/db) | Drizzle schema, migrations, and persistence. |
| [Reflection](packages/reflection) / [Reflection bridge](packages/reflection-bridge) | Memory reflection and its Nautilo integration. |
| [Lattice bridge](packages/lattice-bridge) / [Lattice crypto](packages/lattice-crypto) | Encrypted memory integration and cryptographic primitives. |
| [Trust](packages/trust) / [Security](packages/security) | Identity, capabilities, tool policy, and action safety controls. |
| [Relay](packages/relay) / [Computer Use Host](packages/computer-use-host) | Connected workstation execution and desktop automation. |
| [Tool catalog](packages/catalog) / [MCP client](packages/mcp-client) | Tool discovery, registration, and MCP connections. |
| [API client](packages/api-client) / [Realtime client](packages/realtime-client) | Shared client transports. |
| [Types](packages/types) / [Workbench components](packages/workbench-components) | Shared contracts and UI components. |

For deployment and maintenance, see [deploy](deploy/README.md),
[the Compose driver](deploy/compose-driver/README.md),
[packaging](packaging), and [operations](ops/README.md).
The [application bridge](docs/genie-application-bridge.md) explains how Genies
interact with application surfaces.

## Develop from source

The checkout pins **Bun 1.3.11** and **Node 24.x**. Install Docker for local
PostgreSQL and Logto infrastructure. Desktop preparation may also need Rust
for its native helper.

```bash
git clone https://github.com/agentsea/nautilo.git
cd nautilo
bun install --frozen-lockfile
bun run dev-stack --instance my-nautilo-dev
```

Choose an unused instance name for a fresh environment. Keep that terminal
running, then follow the [source development guide](https://nautilo.ai/docs/build/development/local-development)
to claim the instance, configure a model, and connect a client. That guide
also covers existing instances, isolated clones, and Desktop profiles.

Before submitting a code change, run the checks appropriate to it. The standard
repository checkpoint is:

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run lint:unused
```

See the [testing guide](https://nautilo.ai/docs/build/development/testing)
for focused checks and integration requirements. Coding assistants should
read [AGENTS.md](AGENTS.md) and [README.ai](README.ai) before editing.

## Help build it

There is an enormous amount left to invent. Bring the thing you understand
better than anyone: the ugly workflow you've fought for years, the design
detail that keeps bothering you, the bug you refused to walk away from.
We want that judgment in the project.

Small corrections are welcome. For larger changes, start with the problem
and agree on the design before building. A mountain of generated code won't
make a confused idea clearer. A well-understood problem gives us somewhere
to go.

Read [Contributing](CONTRIBUTING.md), explore the
[curated problems](https://nautilo.ai/community/problems), or find
[help and support](https://nautilo.ai/community/support).
Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

Nautilo is [MIT licensed](LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses and
attribution, and [asset provenance](ASSET_PROVENANCE.md) for artwork, generated
media, and document fixtures.

[![Keep the future open. The open, organization-level harness for everyone needs your support. Support Nautilo on GitHub Sponsors.](assets/brand/donation-banner.png)](https://github.com/sponsors/agentsea)

[Support Nautilo through agentsea on GitHub Sponsors](https://github.com/sponsors/agentsea) · One-time or monthly.

[![A thank-you to the Bankr community](https://nautilo.ai/community/bankr-thanks-en.png)](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3)

Open source runs on people showing up for each other. The Bankr community created an independent [Nautilo token](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3) and directed a share of its trading fees to support our work. Thank you for helping us keep building.

This is a community token, not issued or endorsed by Nautilo. It has no role in the software and grants no product, ownership, or governance rights.
