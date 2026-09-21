# Nautilo

<div align="center">

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

코드와 문서는 현재 영어로 작성되어 있습니다. 번역 PR을 환영합니다. [번역 기여 안내](CONTRIBUTING.md#translations-and-localization)(영문)를 참고해 주세요. 이 페이지는 README의 한국어 번역이며, 앱 화면이나 링크된 문서가 한국어를 지원한다는 뜻은 아닙니다.

<!-- Translation source: README.md; SHA-256: f6e926f3616a846368e6ef24840b4ea15615b72b0d8a1821ef614448bd7d9115 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### AI가 멀티플레이어가 됩니다.

</div>

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**나만의 슈퍼 에이전트. 함께하는 사람들과 그들의 Genie. 지능의 주인은 당신입니다.**

나만의 Genie를 만나보세요. 개성과 기억, 얼굴과 목소리를 정해 주세요. 함께 쓰고, 조사하고, 만들어 보세요. 사람들과 그들의 Genie를 같은 Room으로 초대하세요. 내 서버. 내 모델. 내 규칙. 오픈 소스. MIT 라이선스.

<a id="get-started"></a>

## 시작하기

**나의 첫 Nautilo. 빈 서버에서 시작해 함께 만든 첫 결과물까지.**

[![Elias와 Lyra가 Writer에서 함께 작업하며 변경 제안을 검토하는 화면입니다. 클릭하면 스크린샷이 포함된 로컬 설치 가이드가 열립니다.](https://nautilo.ai/docs/operator/first-nautilo/writer-review.png)](https://nautilo.ai/docs/operator/deploy/local)

### [내 Mac에서 로컬로 시작하기 →](https://nautilo.ai/docs/operator/deploy/local)

Genie를 만나 나에게 맞게 꾸미고, 첫 문서를 함께 만들어 보세요. 스크린샷 가이드(영문)를 따라가면 됩니다.

**Docker Desktop**과 **모델 제공업체의 API 키**가 필요합니다. Nautilo는 **alpha** 단계입니다.

**팀에서 쓰려면:** [내 데이터센터나 VPS에 배포하기 →](https://nautilo.ai/docs/operator/deploy/linux-server)

**이미 서버가 있나요?** [Mac용 Desktop 다운로드 →](https://nautilo.ai/download/mac) · [Mobile 다운로드 →](https://nautilo.ai/download#download-platforms-title)

## 사람들을 데려오세요. 그들의 Genie도 함께.

사람들과 그들의 Genie를 같은 Room으로 모으세요. 아이디어를 뜯어보고, 초안을 쓰고, 빠진 조각을 찾는 조사는 Genie에게 맡기세요. 내 Genie에게는 함께 시간을 보내고 싶은 개성을 주세요.

그러다 직접 조작하세요. 문단을 고치고, 글자의 위치를 옮기세요. 단어 하나를 왼쪽으로 몇 센티미터 옮기자고 더 나은 프롬프트를 고민할 필요는 없어야죠.

내 집 열쇠도 내가 갖고 있어야 합니다. 모델을 고르고, 서버를 운영하고, 누가 접근할지 정하는 사람은 나입니다. Room 하나를 공유한다고 내 삶 전부를 내줄 필요는 없으니까요.

[모델과 API 키](https://nautilo.ai/docs/operator/provider-keys) · [보안과 개인정보 보호](https://nautilo.ai/docs/security)

## 필요한 정보 찾기

| 안내 | 도움이 되는 내용 |
| --- | --- |
| [문서](https://nautilo.ai/docs) | 사용자, 운영자, 개발자에게 맞는 경로 찾기. |
| [Nautilo 사용하기](https://nautilo.ai/docs/use) | Room, Genie, 창작 도구와 일상적인 작업 흐름 익히기. |
| [Nautilo 운영하기](https://nautilo.ai/docs/operator) | 서버 배포, 설정, 관리, 유지보수. |
| [Nautilo 개발하기](https://nautilo.ai/docs/build) | 아키텍처를 이해하고 소스를 기반으로 개발하기. |
| [스킬 팩](https://nautilo.ai/skills) | AI 어시스턴트를 위한 Nautilo 안내 찾기. |
| [설계 원칙](https://nautilo.ai/principles) | 제품을 만드는 판단 이해하기. |
| [버전 관리 문서 색인](DOCS.md) | 소스 계약, 패키징, 릴리스, 운영 절차서 찾기. |

<a id="explore-the-code"></a>

## 코드 살펴보기

이 모노레포에는 Nautilo를 구성하는 애플리케이션과 공유 패키지가 들어 있습니다. 링크를 따라 이해하거나 수정하려는 부분으로 바로 이동하세요.

### 애플리케이션

| 애플리케이션 | 역할 |
| --- | --- |
| [Workbench](apps/workbench) | Desktop에서도 사용하는 공유 브라우저 UI. |
| [Desktop](apps/desktop/README.md) | Electron 클라이언트, 로컬 워크스테이션 통합, 패키징. |
| [Mobile](apps/mobile/README.md) | React Native / Expo 모바일 클라이언트. |
| [CLI](apps/cli/README.md) | 터미널에서 서버 배포 및 관리. |
| [자체 제공 앱](packages/first-party-apps) | 기본 제공 창작 앱: [Writer](packages/first-party-apps/writer), [Sheets](packages/first-party-apps/spreadsheet), [Slides](packages/first-party-apps/presentation), [Board](packages/first-party-apps/board), [Design](packages/first-party-apps/design), [Video](packages/first-party-apps/video). |

### 핵심 패키지

| 패키지 | 내용 |
| --- | --- |
| [Agent](packages/agent) | 에이전트 그래프, 프롬프트, 모델 제공업체, [내장 도구](packages/agent/src/tools/register-all.ts). |
| [Runtime](packages/runtime) | 대화 조율, 태스크 실행, 작업, 세션, 이벤트. |
| [Server](packages/server) | 클라이언트를 위한 Fastify HTTP 및 WebSocket API. |
| [Database](packages/db) | Drizzle 스키마, 마이그레이션, 영속성. |
| [Reflection](packages/reflection) / [Reflection bridge](packages/reflection-bridge) | 기억 성찰과 Nautilo 통합. |
| [Lattice bridge](packages/lattice-bridge) / [Lattice crypto](packages/lattice-crypto) | 암호화된 기억 통합과 암호화 기본 요소. |
| [Trust](packages/trust) / [Security](packages/security) | 정체성, 기능 권한, 도구 정책, 작업 안전 제어. |
| [Relay](packages/relay) / [Computer Use Host](packages/computer-use-host) | 연결된 워크스테이션에서의 실행과 데스크톱 자동화. |
| [Tool catalog](packages/catalog) / [MCP client](packages/mcp-client) | 도구 검색, 등록, MCP 연결. |
| [API client](packages/api-client) / [Realtime client](packages/realtime-client) | 공유 클라이언트 전송 계층. |
| [Types](packages/types) / [Workbench components](packages/workbench-components) | 공유 계약과 UI 컴포넌트. |

배포와 유지보수는 [deploy](deploy/README.md), [Compose 드라이버](deploy/compose-driver/README.md), [packaging](packaging), [operations](ops/README.md)를 참고하세요. [애플리케이션 브리지](docs/genie-application-bridge.md)는 Genie가 앱 화면과 상호작용하는 방식을 설명합니다.

<a id="develop-from-source"></a>

## 소스에서 개발하기

저장소는 **Bun 1.3.11**과 **Node 24.x**를 사용하도록 지정합니다. 로컬 PostgreSQL과 Logto 인프라를 위해 Docker를 설치하세요. Desktop 준비에는 네이티브 헬퍼용 Rust가 필요할 수도 있습니다.

```bash
git clone https://github.com/agentsea/nautilo.git
cd nautilo
bun install --frozen-lockfile
bun run dev-stack --instance my-nautilo-dev
```

새 환경에는 사용하지 않는 인스턴스 이름을 선택하세요. 해당 터미널을 계속 실행한 상태에서 [소스 개발 안내](https://nautilo.ai/docs/build/development/local-development)에 따라 인스턴스 소유권을 확보하고, 모델을 설정하고, 클라이언트를 연결하세요. 이 안내는 기존 인스턴스, 격리된 복제본, Desktop 프로필도 다룹니다.

코드 변경을 제출하기 전에 변경에 적합한 검사를 실행하세요. 저장소의 표준 검사는 다음과 같습니다.

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run lint:unused
```

범위를 좁힌 검사와 통합 요구사항은 [테스트 안내](https://nautilo.ai/docs/build/development/testing)를 참고하세요. 코딩 어시스턴트는 수정 전에 [AGENTS.md](AGENTS.md)와 [README.ai](README.ai)를 읽어야 합니다.

## 함께 만들어주세요

아직 만들어낼 것이 엄청나게 많습니다. 누구보다 잘 아는 것을 가져오세요. 수년간 씨름해온 끔찍한 작업 흐름, 계속 거슬리는 디자인 디테일, 끝내 포기하지 않았던 버그. 우리는 그 판단력을 프로젝트에 담고 싶습니다.

작은 수정은 환영합니다. 큰 변경이라면 문제부터 짚고, 설계에 합의한 뒤 만드세요. 생성된 코드를 산더미처럼 쌓아도 모호한 아이디어가 명확해지지는 않습니다. 문제를 제대로 이해하면 나아갈 방향이 생깁니다.

[기여 안내](CONTRIBUTING.md)를 읽고, [선별된 문제](https://nautilo.ai/community/problems)를 살펴보거나 [도움과 지원](https://nautilo.ai/community/support)을 찾아보세요. 취약점은 [SECURITY.md](SECURITY.md)에 따라 비공개로 보고해 주세요.

## 라이선스

Nautilo는 [MIT 라이선스](LICENSE)로 제공됩니다. 의존성 라이선스와 저작자 표시는 [제3자 고지](THIRD_PARTY_NOTICES.md)를, 아트워크, 생성 미디어, 문서 테스트 데이터의 출처는 [에셋 출처](ASSET_PROVENANCE.md)를 참고하세요.

[![GitHub Sponsors에서 Nautilo를 후원하세요.](assets/brand/donation-banner.png)](https://github.com/sponsors/agentsea)

[GitHub Sponsors의 agentsea를 통해 Nautilo 후원하기](https://github.com/sponsors/agentsea) · 일회성 또는 월간 후원.

### Bankr 커뮤니티에 감사드립니다

오픈 소스는 서로를 돕는 사람들의 힘으로 움직입니다. Bankr 커뮤니티는 독립적인 [Nautilo 토큰](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3)을 만들고 거래 수수료의 일부를 저희 작업을 지원하는 데 배정해 주었습니다. 계속 만들어 갈 수 있도록 도와주셔서 감사합니다.

이 토큰은 커뮤니티가 만든 것으로, Nautilo가 발행하거나 지지하는 토큰이 아닙니다. 소프트웨어에서 어떤 역할도 하지 않으며, 제품 이용권이나 소유권, 거버넌스 권한을 부여하지 않습니다.
