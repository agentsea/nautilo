# Nautilo

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

コードとドキュメントは現在、英語で書かれています。翻訳の PR を歓迎します。[翻訳への貢献ガイド](CONTRIBUTING.md#translations-and-localization)（英語）をご覧ください。このページは README の日本語訳です。アプリの画面やリンク先のドキュメントが日本語に対応していることを示すものではありません。

<!-- Translation source: README.md; SHA-256: 38ba2d4823ffa6b42ffd19c987a12db0cdc049b162ce618653a4b57366a3862f -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### AI が、マルチプレイヤーになる。

https://github.com/user-attachments/assets/a48c97b4-6e75-4d17-9c7d-6b921514eb20

**自分だけのスーパーエージェント。仲間と、その Genie たち。知性を、自分の手に。**

あなたの Genie を紹介します。性格、記憶、顔、声まで自分で選べる、徹底的にカスタマイズ可能なエージェントです。文章を書き、調べ、ウェブを巡り、コーディングエージェントをまとめ、映画を作る。友人やチームと、その Genie たちを同じ Room に招きましょう。一緒に作業する。自分でやりたくなったら、いつでも操作を引き継ぐ。

それが Nautilo。最初から複数人で使うために、人間と機械の仲間のために作られています。デスクトップ、モバイル、ウェブ。あなたのサーバー、あなたのモデル、あなたのルール。オープンソース。MIT ライセンス。

[ウェブサイトとデモ](https://nautilo.ai) ·
[はじめる](#get-started) ·
[ドキュメント](https://nautilo.ai/docs) ·
[ダウンロード](https://nautilo.ai/download) ·
[パッケージ](#explore-the-code) ·
[貢献する](CONTRIBUTING.md)

<a id="get-started"></a>

## はじめる

どの Nautilo クライアントも Nautilo サーバーに接続します。自分に合う方法を選んでください。

Mac で初めて Nautilo を試すなら、[ローカルデプロイのクイックスタート](https://nautilo.ai/docs/operator/deploy/local)から始めてください。これは1台のマシンで評価するための構成です。モバイルからアクセスしたい場合や、チームで使えるサーバーが必要な場合は、以下のホスティング方法を選んでください。

| やりたいこと | ここから始める |
| --- | --- |
| 既存のサーバーに参加する | [Nautilo をダウンロード](https://nautilo.ai/download)し、サーバーのアドレスまたは招待を使って[インストールと接続](https://nautilo.ai/docs/use/install-and-connect)を進めます。 |
| Mac で初めてのサーバーを動かす | Docker Desktop と署名済み Nautilo CLI を使い、[ローカルデプロイのクイックスタート](https://nautilo.ai/docs/operator/deploy/local)に従います。 |
| チーム用のサーバーをクラウドに用意する | [Railway デプロイガイド](https://nautilo.ai/docs/operator/deploy/railway)を使います。 |
| 自分の Docker 基盤で動かす | [Docker Compose ガイド](https://nautilo.ai/docs/operator/deploy/docker-compose)を読むか、[デプロイ方法を比較](https://nautilo.ai/docs/operator/choose-a-deployment)します。 |
| コードを変更する | [ソースから開発する](#develop-from-source)へ進みます。 |

ダウンロードページには、現在の Desktop、モバイル、CLI の選択肢が掲載されています。サーバーのウェブクライアントを開くこともできます。Desktop はサーバーに接続するクライアントです。インストールしてもサーバーやデータベースは導入されません。モバイルには HTTPS でアクセスできるサーバーが必要です。

新しいサーバーでは、オーナー設定を完了し、[プロバイダーキーを追加](https://nautilo.ai/docs/operator/provider-keys)してください。それから Genie をカスタマイズし、Room を開き、本当に作りたいものを持ち込みましょう。[最初の1時間](https://nautilo.ai/docs/use/first-hour)では、一緒に文書を作成し、自分で編集して、成果を保存するところまで案内します。

Nautilo は **alpha** 段階です。

## 仲間を連れてこよう。仲間の Genie も。

人と、それぞれの Genie が、同じ Room で一緒に働く。自然に話しましょう。Smart Routing が適切な Genie を会話に呼び込みます。特定の相手に頼みたいときは、直接呼びかければいい。文書を共有する。アイデアを分解する。一緒にもっとよいものを作る。

Genie に誰かの答えを聞きに行ってもらう。バックグラウンドの仕事を任せる。あとで実行するよう予約する。その間も、あなたは先へ進めます。

## 自分の手で片づけたいときだってある

段落を書き直す。文字を動かす。ターミナルの操作を引き継ぐ。あなたと Genie は同じものに取り組み、作業に合わせて操作を渡し合います。

単語を数センチ左へ動かすために、もっと上手なプロンプトを書く必要はないはずです。

## やりがいのある仕事を任せよう

性格を形作る。顔、声、モデルを選ぶ。ツールを渡して、仕事を任せましょう。ウェブを調べ、コーディングエージェントをまとめ、画像や映像、音楽を作る。サービスや MCP ツールをつなげば、できることが広がります。

記憶が一緒に進める仕事をつなぎ、権限と承認があなたのコントロールを守ります。

使えるツールは、クライアント、接続環境、権限、設定したプロバイダーによって異なります。モデルやサービスの利用には、プロバイダーの料金が発生する場合があります。[API キーガイド](https://nautilo.ai/docs/operator/provider-keys)で、各接続により何が使えるかを説明しています。

[nautilo.ai](https://nautilo.ai) の紹介映像を見るか、[最初の1時間](https://nautilo.ai/docs/use/first-hour)を参考に自分で始めてみてください。

## 自分の家の鍵は、自分で持つ

AI があなたを深く知るほど、その関係を誰が管理するかが重要になります。仕事の習慣、会話、一緒に作ってきたもの。それは、あなたの人生の一部として大きくなっていきます。

Nautilo では、サーバーとデータベースをあなたが管理します。どこで動かすか、どのモデルを使うか、誰が参加するか、データをどうバックアップするかを選べます。コードは MIT ライセンスです。読んで、変えて、その上に作ってください。

サーバーを共有するには、境界を正しく設けることも必要です。Human と Genie にはそれぞれの ID があり、Room にはメンバーシップがあり、記憶にはスコープがあり、ツールには権限と承認の仕組みがあります。会話に誰かを招くことが、それ以外のすべての鍵を渡すことになってはいけません。

接続したモデルやツールのプロバイダーには、作業に必要なデータが送られます。セルフホストなら、その接続先を自分で選べます。ただし、各プロバイダーのデータポリシーは適用されます。構成を選ぶ際は、[セキュリティドキュメント](https://nautilo.ai/docs/security)と[サーバーのセキュリティ強化ガイド](https://nautilo.ai/docs/operator/security-hardening)を読んでください。

## 必要な情報を見つける

| ガイド | わかること |
| --- | --- |
| [ドキュメント](https://nautilo.ai/docs) | ユーザー、運用者、開発者それぞれの入り口。 |
| [Nautilo を使う](https://nautilo.ai/docs/use) | Room、Genie、創作ツール、日々のワークフロー。 |
| [Nautilo を運用する](https://nautilo.ai/docs/operator) | サーバーのデプロイ、設定、管理、保守。 |
| [Nautilo を開発する](https://nautilo.ai/docs/build) | アーキテクチャとソースを使った開発。 |
| [スキルパック](https://nautilo.ai/skills) | AI アシスタント向けの Nautilo ガイダンス。 |
| [設計原則](https://nautilo.ai/principles) | 製品の形を決める判断。 |
| [バージョン管理されたドキュメントの索引](DOCS.md) | ソースの契約、パッケージング、リリース、運用手順書。 |

<a id="explore-the-code"></a>

## コードを探索する

このモノレポには、Nautilo を動かすアプリケーションと共有パッケージが含まれています。理解したい、変更したい部分へ、リンクから直接進んでください。

### アプリケーション

| アプリケーション | 役割 |
| --- | --- |
| [Workbench](apps/workbench) | Desktop 内でも使用する共有ブラウザー UI。 |
| [Desktop](apps/desktop/README.md) | Electron クライアント、ローカルワークステーションとの連携、パッケージング。 |
| [Mobile](apps/mobile/README.md) | React Native / Expo のモバイルクライアント。 |
| [CLI](apps/cli/README.md) | ターミナルからのサーバーデプロイと管理。 |
| [ファーストパーティーアプリ](packages/first-party-apps) | [Writer](packages/first-party-apps/writer) や [Design](packages/first-party-apps/design) など、同梱の創作アプリ。 |

### コアパッケージ

| パッケージ | 内容 |
| --- | --- |
| [Agent](packages/agent) | エージェントグラフ、プロンプト、モデルプロバイダー、[組み込みツール](packages/agent/src/tools/register-all.ts)。 |
| [Runtime](packages/runtime) | 会話の調整、タスク実行、ジョブ、セッション、イベント。 |
| [Server](packages/server) | クライアントに提供する Fastify HTTP / WebSocket API。 |
| [Database](packages/db) | Drizzle スキーマ、マイグレーション、永続化。 |
| [Reflection](packages/reflection) / [Reflection bridge](packages/reflection-bridge) | 記憶の振り返り処理と Nautilo への統合。 |
| [Lattice bridge](packages/lattice-bridge) / [Lattice crypto](packages/lattice-crypto) | 暗号化された記憶の統合と暗号プリミティブ。 |
| [Trust](packages/trust) / [Security](packages/security) | ID、ケイパビリティ、ツールポリシー、操作の安全制御。 |
| [Relay](packages/relay) / [Computer Use Host](packages/computer-use-host) | 接続されたワークステーションでの実行とデスクトップ自動操作。 |
| [Tool catalog](packages/catalog) / [MCP client](packages/mcp-client) | ツールの検出、登録、MCP 接続。 |
| [API client](packages/api-client) / [Realtime client](packages/realtime-client) | 共有クライアント通信層。 |
| [Types](packages/types) / [Workbench components](packages/workbench-components) | 共有契約と UI コンポーネント。 |

デプロイと保守については、[deploy](deploy/README.md)、[Compose ドライバー](deploy/compose-driver/README.md)、[packaging](packaging)、[operations](ops/README.md) を参照してください。[アプリケーションブリッジ](docs/genie-application-bridge.md)では、Genie がアプリの画面とどのようにやり取りするかを説明しています。

<a id="develop-from-source"></a>

## ソースから開発する

このリポジトリでは **Bun 1.3.11** と **Node 24.x** を指定しています。ローカルの PostgreSQL と Logto 基盤のために Docker をインストールしてください。Desktop の準備では、ネイティブヘルパー用に Rust が必要になる場合もあります。

```bash
git clone https://github.com/agentsea/nautilo.git
cd nautilo
bun install --frozen-lockfile
bun run dev-stack --instance my-nautilo-dev
```

新しい環境には、未使用のインスタンス名を選んでください。そのターミナルを動かしたまま、[ソース開発ガイド](https://nautilo.ai/docs/build/development/local-development)に従ってインスタンスの所有権を取得し、モデルを設定してクライアントを接続します。このガイドでは、既存インスタンス、隔離されたクローン、Desktop プロファイルも扱います。

コード変更を提出する前に、変更内容に合ったチェックを実行してください。リポジトリの標準チェックは次のとおりです。

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run lint:unused
```

対象を絞ったチェックと統合テストの要件は、[テストガイド](https://nautilo.ai/docs/build/development/testing)を参照してください。コーディングアシスタントは編集前に [AGENTS.md](AGENTS.md) と [README.ai](README.ai) を読んでください。

## 一緒に作ろう

まだ発明すべきことが山ほどあります。あなたが誰よりもよく知るものを持ち込んでください。何年も格闘してきたひどいワークフロー、ずっと気になるデザインの細部、どうしても放っておけなかったバグ。その判断力を、このプロジェクトに迎えたいのです。

小さな修正は歓迎します。大きな変更なら、まず問題から始め、設計に合意してから作りましょう。生成されたコードを山ほど積んでも、曖昧なアイデアは明確になりません。問題をよく理解すれば、進む先が見えてきます。

[貢献ガイド](CONTRIBUTING.md)を読む、[厳選された課題](https://nautilo.ai/community/problems)を探す、または[ヘルプとサポート](https://nautilo.ai/community/support)を利用してください。脆弱性は [SECURITY.md](SECURITY.md) に従って非公開で報告してください。

## ライセンス

Nautilo は [MIT ライセンス](LICENSE)です。依存関係のライセンスと帰属表示は[サードパーティー通知](THIRD_PARTY_NOTICES.md)、アートワーク、生成メディア、文書フィクスチャの出典は[アセットの来歴](ASSET_PROVENANCE.md)を参照してください。
