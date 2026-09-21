# Nautilo

<div align="center">

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

コードとドキュメントは現在、英語で書かれています。翻訳の PR を歓迎します。[翻訳への貢献ガイド](CONTRIBUTING.md#translations-and-localization)（英語）をご覧ください。このページは README の日本語訳です。アプリの画面やリンク先のドキュメントが日本語に対応していることを示すものではありません。

<!-- Translation source: README.md; SHA-256: f499f48faf14451b0ad789240586834589134f100874f840e4d6eb1db9d29cf4 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### AI が、マルチプレイヤーになる。

</div>

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**自分だけのスーパーエージェント。仲間と、その Genie たち。知性を、自分の手に。**

あなたの Genie に出会おう。個性、記憶、顔、声を与える。一緒に書き、調べ、ものを作る。仲間とその Genie たちも同じ Room へ。あなたのサーバー。あなたのモデル。あなたのルール。オープンソース、MIT ライセンス。

<a id="get-started"></a>

## はじめる

**はじめての Nautilo。空っぽのサーバーから、一緒に作った最初の作品へ。**

[![Writer で共同作業する Elias と Lyra。変更案を確認できる画面です。クリックすると画像付きローカルセットアップガイドが開きます。](https://nautilo.ai/docs/operator/first-nautilo/writer-review.png)](https://nautilo.ai/docs/operator/deploy/local)

### [自分の Mac でローカルに試す →](https://nautilo.ai/docs/operator/deploy/local)

Genie と出会い、自分らしくカスタマイズして、最初の文書を一緒に作ろう。画像付きガイド（英語）で順に進められます。

必要なのは **Docker Desktop** と**モデルプロバイダーの API キー**。Nautilo は **alpha** 段階です。

**チームで使うなら：**[自社データセンターや VPS にデプロイ →](https://nautilo.ai/docs/operator/deploy/linux-server)

**すでにサーバーがあるなら：**[Mac 版 Desktop をダウンロード →](https://nautilo.ai/download/mac) · [Mobile をダウンロード →](https://nautilo.ai/download#download-platforms-title)

## 仲間を連れてこよう。仲間の Genie も。

仲間とその Genie たちを同じ Room に集めよう。アイデアを分解し、最初の原稿を書き、足りないピースの調査を Genie に任せる。自分の Genie には、一緒に時間を過ごしたくなる個性を。

そして、自分で操作する。段落を書き直す。文字の位置を動かす。単語を数センチ左にずらすために、もっと良いプロンプトを考える必要なんてないはずだ。

自分の家の鍵も、自分で持とう。モデルを選び、サーバーを運用し、誰にアクセスを許すかを決めるのはあなた。Room を共有することが、自分の暮らしを丸ごと明け渡すことになってはいけない。

[モデルと API キー](https://nautilo.ai/docs/operator/provider-keys) · [セキュリティとプライバシー](https://nautilo.ai/docs/security)

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
| [ファーストパーティーアプリ](packages/first-party-apps) | 同梱の創作アプリ：[Writer](packages/first-party-apps/writer)、[Sheets](packages/first-party-apps/spreadsheet)、[Slides](packages/first-party-apps/presentation)、[Board](packages/first-party-apps/board)、[Design](packages/first-party-apps/design)、[Video](packages/first-party-apps/video)。 |

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

[![GitHub Sponsors で Nautilo を支援する。](assets/brand/donation-banner.png)](https://github.com/sponsors/agentsea)

[GitHub Sponsors の agentsea を通じて Nautilo を支援する](https://github.com/sponsors/agentsea) · 単発または毎月の支援。

[![Bankr コミュニティへの感謝](https://nautilo.ai/community/bankr-thanks-ja.png)](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3)

オープンソースは、人々が互いに支え合うことで成り立っています。Bankr コミュニティは独立した [Nautilo トークン](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3)を作り、取引手数料の一部を私たちの活動への支援に充ててくれました。開発を続ける力をくださり、ありがとうございます。

これはコミュニティが作ったトークンであり、Nautilo が発行・推奨するものではありません。ソフトウェア内での用途はなく、製品の利用権、所有権、ガバナンス権を付与するものでもありません。
