# Nautilo

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

코드와 문서는 현재 영어로 작성되어 있습니다. 번역 PR을 환영합니다. [번역 기여 안내](CONTRIBUTING.md#translations-and-localization)(영문)를 참고해 주세요. 이 페이지는 README의 한국어 번역이며, 앱 화면이나 링크된 문서가 한국어를 지원한다는 뜻은 아닙니다.

<!-- Translation source: README.md; SHA-256: 0ef174a2326fa118f5d801b5d7147cd73fca94ff3a1ef5550c82979edb493bb4 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### AI가 멀티플레이어가 됩니다.

**나만의 슈퍼 에이전트. 함께하는 사람들과 그들의 Genie. 지능의 주인은 당신입니다.**

당신의 Genie를 만나보세요. 성격, 기억, 얼굴, 목소리까지 직접 고를 수 있는, 자유롭게 맞춤 설정할 수 있는 에이전트입니다. 글쓰기, 조사, 웹 탐색, 코딩 에이전트 조율, 영화 제작을 맡겨보세요. 친구와 팀, 그들의 Genie를 같은 Room으로 초대하세요. 함께 일하세요. 직접 하고 싶어지면 언제든 조작을 넘겨받으세요.

이것이 Nautilo입니다. 처음부터 여러 사용자를 위해, 사람과 기계 동료를 위해 만들었습니다. 데스크톱, 모바일, 웹에서. 당신의 서버, 당신의 모델, 당신의 규칙. 오픈 소스. MIT 라이선스.

[웹사이트와 데모](https://nautilo.ai) ·
[시작하기](#get-started) ·
[문서](https://nautilo.ai/docs) ·
[다운로드](https://nautilo.ai/download) ·
[패키지](#explore-the-code) ·
[기여하기](CONTRIBUTING.md)

## 사람들을 데려오세요. 그들의 Genie도 함께.

사람들과 각자의 Genie가 같은 Room에서 함께 일합니다. 자연스럽게 대화하세요. Smart Routing이 알맞은 Genie를 대화에 참여시킵니다. 특정 상대의 관심이 필요하면 직접 불러주세요. 문서를 공유하고, 아이디어를 뜯어보고, 함께 더 나은 것을 만드세요.

Genie에게 누군가의 답을 받아오게 하거나, 백그라운드 작업을 맡기거나, 나중에 할 일을 예약하세요. Genie가 일하는 동안 당신도 계속 나아가세요.

## 가끔은 그냥 내 손으로 하고 싶잖아요

문단을 다시 쓰세요. 글자를 옮기세요. 터미널 조작을 넘겨받으세요. 당신과 Genie는 같은 작업물을 다루며, 작업에 맞춰 조작을 주고받습니다.

단어 하나를 왼쪽으로 몇 센티미터 옮기려고 더 좋은 프롬프트를 쓸 필요는 없어야 합니다.

## 해볼 만한 일을 맡기세요

성격을 만들고, 얼굴과 목소리, 모델을 고르세요. 도구를 주고 일을 맡기세요. 웹을 조사하고, 코딩 에이전트를 조율하고, 이미지와 영상, 음악을 만들게 하세요. 서비스와 MCP 도구를 연결해 할 수 있는 일을 넓히세요.

기억은 함께하는 작업에 연속성을 더합니다. 권한과 승인은 당신이 통제권을 갖도록 합니다.

사용 가능한 도구는 클라이언트, 연결된 환경, 권한, 설정된 제공업체에 따라 달라집니다. 모델과 서비스 사용에는 제공업체 요금이 발생할 수 있습니다. [API 키 안내](https://nautilo.ai/docs/operator/provider-keys)에서 각 연결로 무엇을 할 수 있는지 설명합니다.

[nautilo.ai](https://nautilo.ai)에서 소개 영상을 보거나, [첫 한 시간](https://nautilo.ai/docs/use/first-hour)을 따라 직접 시작해 보세요.

<a id="get-started"></a>

## 시작하기

모든 Nautilo 클라이언트는 Nautilo 서버에 연결됩니다. 상황에 맞는 방법을 고르세요.

| 원하는 일 | 시작할 곳 |
| --- | --- |
| 기존 서버에 참여하기 | [Nautilo를 다운로드](https://nautilo.ai/download)한 뒤 서버 주소나 초대장을 사용해 [설치 및 연결 안내](https://nautilo.ai/docs/use/install-and-connect)를 따르세요. |
| Mac에서 첫 서버 실행하기 | Docker Desktop과 서명된 Nautilo CLI를 사용해 [로컬 배포 빠른 시작](https://nautilo.ai/docs/operator/deploy/local)을 따르세요. |
| 팀을 위한 클라우드 서버 마련하기 | [Railway 배포 안내](https://nautilo.ai/docs/operator/deploy/railway)를 사용하세요. |
| 자체 Docker 인프라에서 실행하기 | [Docker Compose 안내](https://nautilo.ai/docs/operator/deploy/docker-compose)를 따르거나 [배포 옵션을 비교](https://nautilo.ai/docs/operator/choose-a-deployment)하세요. |
| 코드 수정하기 | [소스에서 개발하기](#develop-from-source)로 이동하세요. |

다운로드 페이지에서 현재 Desktop, 모바일, CLI 옵션을 확인할 수 있습니다. 서버의 웹 클라이언트를 열어도 됩니다. Desktop은 서버에 연결하는 클라이언트입니다. Desktop을 설치해도 서버나 데이터베이스가 설치되지는 않습니다. 모바일에는 HTTPS로 접근할 수 있는 서버가 필요합니다.

새 서버에서는 소유자 설정을 마치고 [제공업체 키를 추가](https://nautilo.ai/docs/operator/provider-keys)하세요. 그다음 Genie를 만들고 Room을 열어, 정말 만들고 싶은 것을 가져오세요. [첫 한 시간](https://nautilo.ai/docs/use/first-hour)에서 함께 문서를 만들고, 직접 편집하고, 결과를 저장하는 과정을 안내합니다.

Nautilo는 **alpha** 단계입니다. 현재 배포물과 이용 가능 여부는 [릴리스 상태](https://nautilo.ai/product-release-status)를 확인하세요.

## 내 집 열쇠는 내가 갖고 있어야죠

AI가 당신을 잘 알게 될수록, 누가 그 관계를 통제하는지가 더 중요해집니다. 일하는 습관, 나눈 대화, 함께 만든 것들. 당신 삶에서 점점 더 큰 부분을 차지하는 것들입니다.

Nautilo는 서버와 데이터베이스의 통제권을 당신에게 줍니다. 어디서 실행할지, 어떤 모델을 쓸지, 누가 참여할지, 데이터를 어떻게 백업할지 직접 선택합니다. 코드는 MIT 라이선스입니다. 읽고, 고치고, 그 위에 만드세요.

서버를 공유하려면 경계도 제대로 세워야 합니다. Human과 Genie에게는 정체성이 있고, Room에는 멤버십이 있으며, 기억에는 범위가 있고, 도구에는 권한과 승인 절차가 있습니다. 누군가를 대화에 초대하는 것이 다른 모든 것의 열쇠까지 건네는 일이 되어서는 안 됩니다.

연결된 모델과 도구 제공업체는 작업에 필요한 데이터를 받습니다. 직접 호스팅하면 연결할 제공업체를 선택할 수 있지만, 각 업체의 데이터 정책은 여전히 적용됩니다. 환경을 선택할 때 [보안 문서](https://nautilo.ai/docs/security)와 [서버 보안 강화 안내](https://nautilo.ai/docs/operator/security-hardening)를 읽어보세요.

## 필요한 정보 찾기

| 안내 | 도움이 되는 내용 |
| --- | --- |
| [문서](https://nautilo.ai/docs) | 사용자, 운영자, 개발자에게 맞는 경로 찾기. |
| [Nautilo 사용하기](https://nautilo.ai/docs/use) | Room, Genie, 창작 도구와 일상적인 작업 흐름 익히기. |
| [Nautilo 운영하기](https://nautilo.ai/docs/operator) | 서버 배포, 설정, 관리, 유지보수. |
| [Nautilo 개발하기](https://nautilo.ai/docs/build) | 아키텍처를 이해하고 소스를 기반으로 개발하기. |
| [엔티티 모델](https://nautilo.ai/docs/build/concepts/entity-model) | Human, Agent, Room, Group과 서로의 관계 이해하기. |
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
| [자체 제공 앱](packages/first-party-apps) | [Writer](packages/first-party-apps/writer), [Design](packages/first-party-apps/design) 등 기본 제공 창작 앱. |

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
