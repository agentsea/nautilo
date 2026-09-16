# Contributing to Nautilo

Start with the problem. Earn agreement on the shape. Then build.

Nautilo is open source, but it is not directionless. Code is cheap now.
Coherence, trust, and long-term stewardship are not. A giant generated diff is
not evidence that a change belongs in the product.

We welcome people who can bring judgment, hard-won domain knowledge, careful
research, sharp design work, and code they understand. We also reserve the
right to close a large unsolicited implementation without performing a
line-by-line review. That is scope protection, not a judgment on the effort
behind it.

## Choose the right track

| Change                                                            | Start with                                                                     | Implementation before approval? |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| Typo, broken link, isolated test correction                       | A small ordinary pull request                                                  | Yes                             |
| Reproducible defect with known intended behavior                  | The reproducible-defect form, or a focused pull request with the same evidence | Usually                         |
| Feature in an approved public problem                             | A problem proposal and spec-only pull request                                  | No                              |
| New direction, integration, deployment target, or major extension | A problem proposal and spec-only pull request                                  | No                              |
| UI, UX, or mobile workflow                                        | A problem proposal, spec, and interaction evidence                             | No                              |
| Security-sensitive architecture                                   | Private maintainer coordination and a threat-aware spec                        | No                              |

Browse the [curated problems](https://nautilo.ai/community/problems) and read
the [contribution path](https://nautilo.ai/community/contribute) before
proposing a meaningful feature. Those pages say whether a direction is seeking
research, a shaped proposal, maintainer-led work, or no implementation yet.

## Small corrections stay small

You do not need a manifesto to fix a typo, broken link, misleading example, or
isolated test defect. Open a focused pull request. Explain what was wrong, what
changed, and how you checked it.

Do not smuggle a redesign, new architecture, or broad generated rewrite into a
"cleanup" pull request.

## Translations and localization

Code and documentation are currently in English. We welcome translation PRs
for the READMEs, documentation, UI/UX, and other user-facing content, including
onboarding, help, accessibility labels, errors, and release guidance.

Small translation corrections can go straight to a focused PR. A new language
or broader UI localization should be dedicated work: start with a public
proposal that agrees on scope, coverage, review, and ongoing maintenance.
Deliver complete, useful journeys in stages toward broad coverage across
Workbench/Desktop, Mobile, bundled apps, and relevant operator surfaces. State
what is translated and what remains in English; a translated README does not
mean the application or linked documentation supports that language.

For translation work:

- Use the English source as the reference and keep product meaning, security
  instructions, commands, identifiers, and link destinations intact. Translate
  prose naturally and use consistent terminology; preserve product names such
  as Nautilo, Genie, Room, Writer, and Design so readers can find them in the UI.
- Translate complete documents or agreed user journeys, including onboarding,
  settings, help, accessibility text, empty/loading states, errors, and recovery.
  Record coverage and remaining gaps in the PR instead of calling a few screens
  a supported language.
- For UI work, agree on a shared localization approach before implementation.
  Use reusable message resources, English fallback, interpolation, plurals,
  locale-aware dates and numbers, and text direction where applicable. Keep
  Workbench and Desktop on their shared UI; avoid copied screens or scattered
  language conditionals.
- Have a fluent speaker review meaning, tone, and terminology. AI-assisted
  translation is welcome, but disclose any outstanding language review. For UI
  changes, verify complete flows on affected clients, text expansion, keyboard
  and screen-reader behavior, and layouts with the target language enabled.
- Name who will maintain the language and how source changes, missing strings,
  stale pages, and terminology updates will be found and reviewed. Update
  affected translations with English changes, or explicitly flag them as stale
  in the PR and the affected document until they are refreshed.

### README maintenance

[`README.md`](README.md) is the English source. The other editions live beside
it as `README.zh-CN.md` (Simplified Chinese), `README.ja.md`, `README.fr.md`,
`README.es.md`, and `README.ko.md`. Each edition includes the same six-language
navigation, sections, commands, and destinations. Keep repository links
relative, and use explicit anchors for navigation to translated headings.

Each translated README records the SHA-256 of the English source in an HTML
comment. Compare it with `shasum -a 256 README.md` when reviewing source changes;
refresh the translation before updating its hash. The hash records source
alignment, not fluent-speaker review. Include that review status in the PR.
Check all local paths and anchors, preserve the source's external destinations,
and verify command blocks remain identical before submitting.

## Reproducible defects

Use the **Reproducible defect** issue form when behavior is broken and the
intended result is already clear. Include:

- the Nautilo version or commit;
- the smallest reliable reproduction;
- expected and observed behavior;
- the affected surface and environment; and
- redacted diagnostics that do not expose Room content, tokens, provider keys,
  private paths, credentials, or full configuration files.

A narrow fix may arrive with the report when the blast radius is understood.
If the fix changes product behavior, data ownership, permissions, or system
shape, it moves to the proposal track.

## Meaningful features begin as proposals

Use the **Problem proposal** issue form before writing substantial production
code. Maintainers may ask for research, narrow the experiment, redline the
shape, approve a prototype, approve implementation, or decline.

If the direction is worth specifying, open a draft pull request using
`.github/PULL_REQUEST_TEMPLATE/specification.md` and
[`docs/contributing/spec-template.md`](docs/contributing/spec-template.md).
That pull request contains the spec and its supporting evidence—not the
production implementation.

Approval belongs to the recorded scope. It is not a blanket promise to merge
whatever code follows, and it expires when product reality or an external
dependency changes materially.

## Evidence required before implementation

A strong spec:

1. names the public problem and user or operator outcome;
2. describes verified current behavior with repository `path:line` evidence;
3. separates proposed requirements from verified facts;
4. states constraints, non-goals, unknowns, and real design forks;
5. traces identity, ownership, data flow, permissions, trust, and failure;
6. identifies touched modules, compatibility boundaries, migrations, and
   operating consequences;
7. defines automated proof, manual QA, rollback, and documentation; and
8. names who will maintain the capability as dependencies and product reality
   change.

You may use Codex, Nautilo, or another capable agent to investigate and draft
the proposal. You still own every claim, citation, decision, and line you
submit. "The model wrote it" is not a maintenance plan.

## Extra evidence for UI, UX, and mobile

Make the interaction inspectable before production code. Include what the
scope needs:

- the user journey and state transitions;
- ASCII or annotated wireframes;
- empty, loading, denied, disconnected, error, and recovery states;
- keyboard, focus, accessibility, and reduced-motion behavior;
- narrow-screen and mobile behavior;
- screenshots or a short prototype when space or motion matters; and
- design-system components reused, changed, or proposed.

Open source does not mean design by committee. Product and design stewards own
the interaction direction; contributors help make it sharper, more powerful,
and better proven.

## Extra evidence for third-party integrations

An API client or MCP server is not an integration contract. Integration
proposals must define:

- the user outcome and integration mode;
- Connection identity and ownership;
- authorization, token storage, refresh, rotation, revocation, and redaction;
- data entering or leaving Nautilo, including external retention and logs;
- Capabilities, approvals, denied actions, and destructive actions;
- idempotency, retries, partial success, rate limits, and reconciliation;
- setup, connection state, progress, results, errors, and disconnection UX;
- provider/API compatibility and deprecation;
- fixtures, contract tests, failure tests, and CI-safe secrets; and
- ongoing stewardship for provider drift, docs, examples, and releases.

The design must fit Nautilo's existing entities and trust boundaries. Do not
invent a parallel identity, permission, or secret system because it makes one
demo easier.

## Security reports are not public proposals

Do not open a public issue containing a vulnerability, exploit, credential,
private conversation, or sensitive infrastructure detail. Follow the current
[`SECURITY.md`](SECURITY.md) and the
[security reporting page](https://nautilo.ai/security) before sharing details.
Security-sensitive product design may use the proposal process only after
disclosure risk has been removed.

## From approved spec to implementation

An implementation pull request links the approved proposal and spec, states
any deviation, and includes tests, manual evidence, migration and documentation
effects, and rollback behavior. Material deviations return to spec review.

Maintainers merge work that is wanted, understood, tested, recoverable, and
maintainable. Volume alone does not move it closer to the line.
