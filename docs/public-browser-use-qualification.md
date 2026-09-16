# Public Browser Use qualification — 2026-09-13

This candidate adds anonymous public research to the existing supervised browser operation. Source baseline: `4019353d482f9d1b2d84d4045b15e4d569932a15`. These are local qualification results, not remote CI, release, or deployment evidence.

## Delivered behavior

- `browse_web` is available from hosted runtime readiness and canonical Nautilo authority, independently of connected website inventory. Explicit requests and interactive research select it; ordinary lookup remains Tavily-first.
- Anonymous operations have no account or provider profile. Generated migrations 0289–0291 make that mode explicit and constrain it to read-only hosted/checking operation custody. Existing private account authority, encryption context and session reuse remain separate.
- Existing admission idempotency, supervisor, cost records, wakes, Watch/Stop, and cleanup handle public operations. Public direct takeover is explicitly unavailable. Room-backed task authority is checked; orphan/no-room tasks remain unavailable.
- Workbench/Desktop show current operation state and public results. Failed status reads display unknown status with retry. A finished provider awaiting durable settlement is identified explicitly. Terminal state cannot regress behind a stale poll or original active receipt.
- Authentication checkpoints use the protected website connection flow and retain the requested continuation. Provider responses combining public read and authentication templates project only the validated checkpoint. Missing or malformed public answers cannot become successful research results.
- Mobile's existing generic transcript projects safe public receipts/results. This change does not add a native live-view/control card.

## Live evidence

An isolated populated development clone, authenticated as the delegated tester, had **zero connected website accounts** and a ready hosted provider. No installed application replacement or production mutation was performed.

| Journey | Observed result |
| --- | --- |
| Explicit Browser Use, Books to Scrape science catalogue | Selected `browse_web`, returned the first three titles/prices. Provider cost $0.004979. |
| Restart during pending settlement | The same operation completed after restart; no replacement run. Final result persisted at 11:11:09 UTC, wake delivered, explicit browser cleanup completed. |
| Autonomous interactive selection, Quotes to Scrape dependent dropdowns | Without naming Browser Use, the Genie selected `browse_web`, chose Albert Einstein then learning, submitted the filter and returned the matching quote. Cost $0.009829. |
| Live view | Watch was enabled and opened the live iframe while the interactive run was active; Stop remained enabled. |
| Human cancellation of a paginated catalogue request | Clicking Stop reached a canonical cancelled receipt at 11:20:18 UTC. Card showed stopped; controls disappeared; explicit cleanup completed. Cost $0.004998. |
| Sign-in checkpoint | Fresh rerun reached GitHub sign-in, stopped without credentials, and persisted `authentication_required` / `attention_required` at 11:26:07 UTC. Expanded card offered the protected sign-in button; browser cleanup completed at 11:26:11 UTC. Cost $0.004616. |

Live qualification exposed and corrected: an immediate-check clock race; a SQL terminal-result constraint still requiring an account object; stale running language during failed status retrieval and pending settlement; and a mixed provider authentication response incorrectly appearing completed. The first sign-in probe correctly stopped at GitHub's sign-in page but exposed the latter presentation defect; it is not counted as passing checkpoint-card acceptance.

## Automated qualification

- 343 focused agent/server/contract tests across 33 files passed.
- 27 Workbench browser-card tests passed, including unavailable status/retry, completion after collapse, stopped state, public projection, and pending settlement.
- Owner controller/API tests passed, including exact ownership and ended-provider projection.
- Six real PostgreSQL browser lifecycle integration tests passed, including anonymous admission, terminal result persistence, cleanup, and retained account reuse/custody cases.
- 189 repository invariant tests passed.
- Server, Agent, Workbench and Mobile type checks passed; Workbench production build passed with the existing chunk-size warnings.
- Changed-source ESLint, Mobile ESLint, query inventory, encryption inventory, limits check, and whitespace checks passed.

## Scope and remaining release gates

No remote CI, merge, release, or production deployment is established here. Native physical-device qualification and a newly packaged Desktop are not established by development Electron acceptance. The protected authentication UI was reached without entering credentials; completing website login is not required to qualify anonymous public browsing.

Initial public URL validation rejects credentials and private addresses. Navigation constraints also appear in the hosted task; provider-owned redirect/network enforcement is not a Nautilo firewall guarantee. Private account actions, anonymous direct control, no-room task execution and a native Mobile live-view card remain outside this delivery.
