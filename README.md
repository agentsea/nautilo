# Nautilo

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

Code and documentation are currently in English. Translation PRs are welcome;
see [translation contributions](CONTRIBUTING.md#translations-and-localization).

### AI goes multiplayer.

**Your own super agent. Your people and their Genies. You own the intelligence.**

Meet your Genie: a radically customizable agent with a personality, memory,
face, and voice you choose. Put her to work writing, researching, browsing,
coordinating coding agents, or making a film. Bring your friends, your team,
and their Genies into the same Room. Work together. Grab the controls whenever
you want to do it yourself.

That's Nautilo. Natively multi-user. Built for people and machine people.
Desktop, mobile, and web. Your server, your models, your rules.
Open source. MIT licensed.

[Website & demos](https://nautilo.ai) ·
[Get started](#get-started) ·
[Documentation](https://nautilo.ai/docs) ·
[Download](https://nautilo.ai/download) ·
[Packages](#explore-the-code) ·
[Contribute](CONTRIBUTING.md)

## Bring your people. Bring their Genies.

People and their Genies, working in the same Room. Talk naturally. Smart
Routing brings the right Genie into the conversation; address someone directly
when you want their attention. Share a document. Pull an idea apart. Build
something better together.

Send your Genie to get someone’s answer, delegate a background job, or schedule
work for later. Keep moving while she works.

## Sometimes you want to do the damn thing yourself

Rewrite the paragraph. Move the lettering. Take over the terminal. You and your
Genie work on the same thing, handing control back and forth as the work demands.

You shouldn’t need a better prompt to move a word three inches to the left.

## Give her something worth doing

Shape her personality. Choose her face, voice, and models. Give her tools and
put her to work: research the web, coordinate coding agents, make images, video,
and music. Connect services and MCP tools to expand her reach.

Memory gives your work together continuity. Permissions and approvals keep you
in control.

Tool availability depends on the client, connected environment, permissions,
and configured providers. Model and service usage may carry provider charges;
the [API key guide](https://nautilo.ai/docs/operator/provider-keys) explains
what each connection enables.

See the films on [nautilo.ai](https://nautilo.ai), or start doing it yourself
with [Your first hour](https://nautilo.ai/docs/use/first-hour).

## Get started

Every Nautilo client connects to a Nautilo server. Choose the path that fits
where you are:

| You want to… | Start here |
| --- | --- |
| Join an existing server | [Download Nautilo](https://nautilo.ai/download), then [install and connect](https://nautilo.ai/docs/use/install-and-connect) with your server address or invite. |
| Run your first server on your Mac | Follow the [Local Deploy Quickstart](https://nautilo.ai/docs/operator/deploy/local), using Docker Desktop and the signed Nautilo CLI. |
| Give your team a server in the cloud | Use the [Railway deployment guide](https://nautilo.ai/docs/operator/deploy/railway). |
| Run on your own Docker infrastructure | Follow the [Docker Compose guide](https://nautilo.ai/docs/operator/deploy/docker-compose), or [compare deployment options](https://nautilo.ai/docs/operator/choose-a-deployment). |
| Change the code | Jump to [Develop from source](#develop-from-source). |

The download page carries the current Desktop, mobile, and CLI options.
You can also open your server's web client. Desktop connects to your server;
installing it does not install the server or its database. Mobile needs a
server reachable over HTTPS.

For a new server, finish the owner setup and
[add your provider keys](https://nautilo.ai/docs/operator/provider-keys).
Then make your Genie, open a Room, and bring something you actually want to
make. [Your first hour](https://nautilo.ai/docs/use/first-hour) walks you through
creating a document together, editing it yourself, and saving the result.

Nautilo is in **alpha**. Check [release status](https://nautilo.ai/product-release-status)
for the current artifacts and availability.

## Keep the keys to your own house

The better your AI gets to know you, the more it matters who controls the
relationship. Your working habits, your conversations, the things you've
made together: that is a growing piece of your life.

Nautilo puts the server and its database under your control. You choose where
it runs, which models it uses, who joins, and how the data is backed up.
The code is MIT licensed. Read it. Change it. Build on it.

Sharing a server also means getting the boundaries right. Humans and Genies
have identities; Rooms have membership; memory has scopes; tools have
permissions and approval gates. Inviting someone into a conversation should
never mean handing them the keys to everything else.

Connected model and tool providers receive the data needed for their work.
Self-hosting lets you choose those connections; their own data policies still
apply. Read the [security documentation](https://nautilo.ai/docs/security)
and [server hardening guide](https://nautilo.ai/docs/operator/security-hardening)
when choosing your setup.

## Find your way around

| Guide | What it helps you do |
| --- | --- |
| [Documentation](https://nautilo.ai/docs) | Find the user, operator, or builder path. |
| [Use Nautilo](https://nautilo.ai/docs/use) | Learn Rooms, Genies, creative tools, and everyday workflows. |
| [Run Nautilo](https://nautilo.ai/docs/operator) | Deploy, configure, administer, and maintain a server. |
| [Build on Nautilo](https://nautilo.ai/docs/build) | Understand the architecture and develop against the source. |
| [Entity model](https://nautilo.ai/docs/build/concepts/entity-model) | Understand Humans, Agents, Rooms, Groups, and the relationships between them. |
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
| [First-party apps](packages/first-party-apps) | Bundled creative applications, including [Writer](packages/first-party-apps/writer) and [Design](packages/first-party-apps/design). |

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
git clone https://github.com/agentsea/nautilo-public.git nautilo
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
