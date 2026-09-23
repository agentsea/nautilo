# Nautilo technical documentation

Looking for installation, administration, or everyday use? Start at
[nautilo.ai/docs](https://nautilo.ai/docs).

- **Using Nautilo:** [User guide](https://nautilo.ai/docs/use), including
  [installing and connecting](https://nautilo.ai/docs/use/install-and-connect)
  and [your first hour](https://nautilo.ai/docs/use/first-hour).
- **Running a server:** [Administrator guide](https://nautilo.ai/docs/operator),
  including [deployment choices](https://nautilo.ai/docs/operator/choose-a-deployment).
- **Changing the code:** [Developer guide](https://nautilo.ai/docs/build) and
  this repository's [contribution guide](../CONTRIBUTING.md).

This directory is for contributors. It explains source-level contracts,
component ownership, maintenance, and testing. Read it alongside the code in
the same revision. The [complete documentation index](../DOCS.md) also links
to build, deployment, packaging, and contribution instructions elsewhere in
the repository.

## Find a contract

- **Desktop and execution:** [Relay ownership](relay-host-ownership.md),
  [background authorization](background-authorization-transport.md),
  [patch execution](apply-patch-runtime-boundary.md), and
  [OfficeCLI provisioning](officecli-provisioning.md).
- **Genies and websites:** [tool activation](progressive-tool-activation.md),
  [application navigation](genie-application-bridge.md), and
  [Connected Websites](connected-web-browser-contract.md).
- **Documents and media:** [Office engines](office-engines/README.md),
  [Video media browser](video-media-browser.md), and
  [generation recovery](video-generation-recovery.md).
- **Mobile:** [message times and workspace sharing](mobile-time-and-workspace-sharing.md)
  and the [document/media proposal](contributing/proposals/mobile-document-media-save.md).
- **Security and data:** [browser crypto compatibility](crypto-browser-compatibility.md),
  [encrypted data ownership](encryption-data-operation-ownership.md),
  [security research](security-research.md), and
  [research limits and recovery](security-research-limits.md).
- **Events:** [quiet events](quiet-events.md).
- **Local model QA:** [Nautilo Gateway](nautilo-gateway-local-qa.md).
- **Contributing:** [CI](contributing/ci.md) and the
  [specification template](contributing/spec-template.md).

## Updating documentation

Keep implementation contracts beside the source. Keep user and administrator
walkthroughs on the website, whose technical guides are maintained separately
in `agentsea/nautilo-site`, under `content/docs/`. Neither tree automatically
updates the other. When a change affects a documented workflow, update both
the relevant contract and the website guide; link between them instead of
copying a second manual.

Public documentation should explain behavior, instructions, limitations, and
recovery. Test commands and reproducible fixtures belong here; individual
test-session diaries, private planning identifiers, local machine details,
and deployment bookkeeping do not. Design studies and proposals must be
clearly distinguished from installed features.
