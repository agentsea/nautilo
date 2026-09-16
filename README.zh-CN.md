# Nautilo

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

代码和文档目前以英语编写。欢迎提交翻译 PR；请参阅[翻译贡献指南](CONTRIBUTING.md#translations-and-localization)（英文）。本页为 README 的中文译本，不代表应用界面或链接所指向的文档已支持中文。

<!-- Translation source: README.md; SHA-256: 5c6d085a926391280d5405985c83c3f2236d382ac02895dd292929224f6742a2 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### AI，进入多人模式。

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**你自己的超级智能体。你在乎的人，还有他们的 Genie。智能，掌握在你手中。**

认识一下你的 Genie：一个可以深度定制的智能体，拥有你选择的个性、记忆、面孔和声音。让她写作、研究、浏览网页、协调编程智能体，或者制作一部影片。把朋友、团队和他们的 Genie 带进同一个 Room。一起动手。想自己来？随时接过控制权。

这就是 Nautilo。原生支持多用户，为人类和机器伙伴而建。桌面、移动端、网页。你的服务器，你的模型，你的规则。开源，采用 MIT 许可证。

[网站与演示](https://nautilo.ai) ·
[开始使用](#get-started) ·
[文档](https://nautilo.ai/docs) ·
[下载](https://nautilo.ai/download) ·
[代码包](#explore-the-code) ·
[参与贡献](CONTRIBUTING.md)

<a id="get-started"></a>

## 开始使用

每个 Nautilo 客户端都连接到一个 Nautilo 服务器。选择适合你的方式：

第一次在 Mac 上试用 Nautilo？建议从[本地部署快速入门](https://nautilo.ai/docs/operator/deploy/local)开始。这是一种用于单机试用的配置。如果需要从移动端访问，或让团队连接到同一台服务器，请选择下方的托管部署方案。

| 你想要…… | 从这里开始 |
| --- | --- |
| 加入现有服务器 | [下载 Nautilo](https://nautilo.ai/download)，然后使用服务器地址或邀请，按[安装与连接指南](https://nautilo.ai/docs/use/install-and-connect)操作。 |
| 在 Mac 上运行第一台服务器 | 按[本地部署快速入门](https://nautilo.ai/docs/operator/deploy/local)操作，使用 Docker Desktop 和经过签名的 Nautilo CLI。 |
| 为团队搭建云端服务器 | 使用 [Railway 部署指南](https://nautilo.ai/docs/operator/deploy/railway)。 |
| 在自己的 Docker 基础设施上运行 | 按 [Docker Compose 指南](https://nautilo.ai/docs/operator/deploy/docker-compose)操作，或[比较部署方案](https://nautilo.ai/docs/operator/choose-a-deployment)。 |
| 修改代码 | 跳转到[从源码开发](#develop-from-source)。 |

下载页面提供当前的桌面端、移动端和 CLI 选项。你也可以打开服务器的网页客户端。桌面端连接到服务器；安装桌面端不会安装服务器或数据库。移动端需要能通过 HTTPS 访问的服务器。

对于新服务器，先完成所有者设置并[添加服务商密钥](https://nautilo.ai/docs/operator/provider-keys)。然后定制你的 Genie，打开一个 Room，带上一件你真正想做的事。[你的第一个小时](https://nautilo.ai/docs/use/first-hour)会带你们一起创建文档、亲手编辑并保存成果。

Nautilo 目前处于 **alpha** 阶段。

## 带上你的伙伴，也带上他们的 Genie

人们带着各自的 Genie，在同一个 Room 里一起工作。自然地聊天。Smart Routing 会让合适的 Genie 加入对话；想找谁，就直接点名。分享一份文档。拆解一个想法。一起做出更好的东西。

让 Genie 去问一个人的答案，把任务交给她在后台执行，或者安排到稍后执行。她忙她的，你继续向前。

## 有时候，你就是想亲自动手

重写那一段。移动文字。接管终端。你和 Genie 处理同一份作品，按工作需要随时交接控制权。

把一个词往左挪几厘米，不该需要一条更高明的提示词。

## 给她一件值得做的事

塑造她的个性。选择面孔、声音和模型。给她工具，让她动手：上网研究、协调编程智能体、制作图像、视频和音乐。连接服务和 MCP 工具，拓展她能做的事。

记忆让你们的合作延续下去。权限和审批让控制权始终在你手中。

工具是否可用，取决于客户端、连接的环境、权限和配置的服务商。使用模型和服务可能产生服务商费用；[API 密钥指南](https://nautilo.ai/docs/operator/provider-keys)说明了每种连接能启用哪些功能。

到 [nautilo.ai](https://nautilo.ai) 看看演示影片，或者跟着[你的第一个小时](https://nautilo.ai/docs/use/first-hour)亲手开始。

## 把自己家的钥匙留在自己手里

AI 越了解你，谁掌控这段关系就越重要。你的工作习惯、对话、共同完成的作品：它们正在成为你生活中越来越大的一部分。

Nautilo 把服务器和数据库的控制权交给你。由你决定它在哪里运行、用哪些模型、谁能加入，以及如何备份数据。代码采用 MIT 许可证。读它，改它，在它之上创造。

共享服务器，也意味着必须划清边界。Human 和 Genie 各有身份；Room 有成员关系；记忆有作用范围；工具有权限和审批关卡。邀请一个人加入对话，绝不应该等于把其他一切的钥匙也交出去。

连接的模型和工具服务商会收到完成工作所需的数据。自行托管让你可以选择这些连接；服务商自身的数据政策仍然适用。选择部署方式时，请阅读[安全文档](https://nautilo.ai/docs/security)和[服务器安全加固指南](https://nautilo.ai/docs/operator/security-hardening)。

## 找到你需要的内容

| 指南 | 能帮你做什么 |
| --- | --- |
| [文档](https://nautilo.ai/docs) | 找到适合用户、运维人员或开发者的路线。 |
| [使用 Nautilo](https://nautilo.ai/docs/use) | 了解 Room、Genie、创作工具和日常工作流程。 |
| [运行 Nautilo](https://nautilo.ai/docs/operator) | 部署、配置、管理和维护服务器。 |
| [基于 Nautilo 开发](https://nautilo.ai/docs/build) | 理解架构并基于源码开发。 |
| [技能包](https://nautilo.ai/skills) | 查找供 AI 助手使用的 Nautilo 指南。 |
| [设计原则](https://nautilo.ai/principles) | 理解塑造产品的判断与取舍。 |
| [版本化文档索引](DOCS.md) | 查找源码契约、打包、发布和运维操作手册。 |

<a id="explore-the-code"></a>

## 探索代码

这个 monorepo 包含构成 Nautilo 的应用和共享包。沿着链接，直接找到你想理解或修改的部分。

### 应用

| 应用 | 职责 |
| --- | --- |
| [Workbench](apps/workbench) | 共享的浏览器界面，桌面端也使用它。 |
| [Desktop](apps/desktop/README.md) | Electron 客户端、本地工作站集成与打包。 |
| [Mobile](apps/mobile/README.md) | React Native / Expo 移动客户端。 |
| [CLI](apps/cli/README.md) | 通过终端部署和管理服务器。 |
| [第一方应用](packages/first-party-apps) | 随附的创作应用：[Writer](packages/first-party-apps/writer)、[Sheets](packages/first-party-apps/spreadsheet)、[Slides](packages/first-party-apps/presentation)、[Board](packages/first-party-apps/board)、[Design](packages/first-party-apps/design)、[Video](packages/first-party-apps/video)。 |

### 核心包

| 包 | 内容 |
| --- | --- |
| [Agent](packages/agent) | 智能体图、提示词、模型服务商和[内置工具](packages/agent/src/tools/register-all.ts)。 |
| [Runtime](packages/runtime) | 对话协调、任务执行、作业、会话和事件。 |
| [Server](packages/server) | 为客户端提供服务的 Fastify HTTP 和 WebSocket API。 |
| [Database](packages/db) | Drizzle 数据模型、迁移与持久化。 |
| [Reflection](packages/reflection) / [Reflection bridge](packages/reflection-bridge) | 记忆反思及其与 Nautilo 的集成。 |
| [Lattice bridge](packages/lattice-bridge) / [Lattice crypto](packages/lattice-crypto) | 加密记忆集成与密码学原语。 |
| [Trust](packages/trust) / [Security](packages/security) | 身份、能力、工具策略和操作安全控制。 |
| [Relay](packages/relay) / [Computer Use Host](packages/computer-use-host) | 已连接工作站上的执行与桌面自动化。 |
| [Tool catalog](packages/catalog) / [MCP client](packages/mcp-client) | 工具发现、注册和 MCP 连接。 |
| [API client](packages/api-client) / [Realtime client](packages/realtime-client) | 共享的客户端传输层。 |
| [Types](packages/types) / [Workbench components](packages/workbench-components) | 共享契约和 UI 组件。 |

部署与维护请参阅[部署](deploy/README.md)、[Compose 驱动](deploy/compose-driver/README.md)、[打包](packaging)和[运维](ops/README.md)。[应用桥接文档](docs/genie-application-bridge.md)说明了 Genie 如何与应用界面交互。

<a id="develop-from-source"></a>

## 从源码开发

仓库固定使用 **Bun 1.3.11** 和 **Node 24.x**。安装 Docker，以运行本地 PostgreSQL 和 Logto 基础设施。准备桌面端环境时，还可能需要 Rust 来构建原生辅助程序。

```bash
git clone https://github.com/agentsea/nautilo.git
cd nautilo
bun install --frozen-lockfile
bun run dev-stack --instance my-nautilo-dev
```

为新环境选择一个未使用的实例名称。保持该终端运行，然后按照[源码开发指南](https://nautilo.ai/docs/build/development/local-development)认领实例、配置模型并连接客户端。该指南也介绍了现有实例、隔离克隆和桌面端配置档案。

提交代码修改前，运行适合该改动的检查。仓库的标准检查包括：

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run lint:unused
```

针对性检查和集成要求请参阅[测试指南](https://nautilo.ai/docs/build/development/testing)。编程助手在修改前应阅读 [AGENTS.md](AGENTS.md) 和 [README.ai](README.ai)。

## 一起把它做出来

还有太多东西等待创造。带来你最懂的东西：折磨你多年的糟糕工作流程、一直让你不舒服的设计细节，或者那个你不肯放过的 bug。我们希望项目里有你的判断。

欢迎小幅修正。对于较大的改动，先说清问题，再就设计达成一致，然后动手。堆成山的生成代码不会让一个模糊的想法变清楚。真正理解问题，才能找到前进的方向。

阅读[贡献指南](CONTRIBUTING.md)，探索[精选问题](https://nautilo.ai/community/problems)，或寻找[帮助与支持](https://nautilo.ai/community/support)。请按照 [SECURITY.md](SECURITY.md) 私下报告安全漏洞。

## 许可证

Nautilo 采用 [MIT 许可证](LICENSE)。依赖项的许可证与署名请参阅[第三方声明](THIRD_PARTY_NOTICES.md)；美术资源、生成媒体和文档测试素材的来源请参阅[资源来源说明](ASSET_PROVENANCE.md)。
