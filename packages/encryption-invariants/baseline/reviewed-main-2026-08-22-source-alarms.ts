import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_22_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "packages/runtime/src/tasks/report-back.ts#log_emitter:89b81c36ea23316a:1",
    "packages/runtime/src/tasks/report-back.ts#log_emitter:89b81c36ea23316a:2",
  ]);

export const REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    "locator": "apps/desktop/electron/system-permissions-onboarding-preference.ts#filesystem_write:9363dfe2ef455d81:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.01",
    "reason": "This owner-local mode-0600 atomic file stores only a version number and one boolean controlling whether the Mac system-permissions onboarding window opens automatically. It contains no identity, Message content, credential, key, prompt, or protected payload."
  },
  {
    "locator": "apps/desktop/electron/system-permissions-onboarding-preference.ts#filesystem_write:70b318ac90f9404d:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.02",
    "reason": "This owner-local mode-0600 atomic file stores only a version number and one boolean controlling whether the Mac system-permissions onboarding window opens automatically. It contains no identity, Message content, credential, key, prompt, or protected payload."
  },
  {
    "locator": "apps/desktop/electron/system-permissions-onboarding-preference.ts#filesystem_write:bbd477cef359a1cf:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.03",
    "reason": "This owner-local mode-0600 atomic file stores only a version number and one boolean controlling whether the Mac system-permissions onboarding window opens automatically. It contains no identity, Message content, credential, key, prompt, or protected payload."
  },
  {
    "locator": "apps/desktop/electron/system-permissions-onboarding-preference.ts#filesystem_write:3f88c0d5905e5977:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.04",
    "reason": "This owner-local mode-0600 atomic file stores only a version number and one boolean controlling whether the Mac system-permissions onboarding window opens automatically. It contains no identity, Message content, credential, key, prompt, or protected payload."
  },
  {
    "locator": "apps/desktop/scripts/after-pack.cjs#subprocess_processor:695f699a2609b902:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.05",
    "reason": "This packaging-only subprocess invokes the repository package-inventory verifier with a generated application archive path; it processes build artifacts, not Human content, credentials, keys, or runtime protected values."
  },
  {
    "locator": "apps/desktop/scripts/verify-package-inventory.ts#log_emitter:c467686340f4efc2:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.06",
    "reason": "This packaging verifier emits only archive paths, entry counts, policy violations, and fixed status text for build diagnostics; it does not inspect or log runtime Human data, credentials, keys, or protected payloads."
  },
  {
    "locator": "apps/desktop/scripts/verify-package-inventory.ts#log_emitter:468c68ed4723a1f2:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.07",
    "reason": "This packaging verifier emits only archive paths, entry counts, policy violations, and fixed status text for build diagnostics; it does not inspect or log runtime Human data, credentials, keys, or protected payloads."
  },
  {
    "locator": "apps/desktop/scripts/verify-package-inventory.ts#log_emitter:468c68ed4723a1f2:2",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.08",
    "reason": "This packaging verifier emits only archive paths, entry counts, policy violations, and fixed status text for build diagnostics; it does not inspect or log runtime Human data, credentials, keys, or protected payloads."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:95c639d13977edfb:1",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.09",
    "reason": "This Browser diagnostic reports a live-shadow recovery/receive failure. The error originates from closed protocol and HTTP failure paths, while plaintext Message and protected byte buffers remain outside the emitted arguments; no credential or private key is logged."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:95c639d13977edfb:2",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.10",
    "reason": "This Browser diagnostic reports a live-shadow recovery/receive failure. The error originates from closed protocol and HTTP failure paths, while plaintext Message and protected byte buffers remain outside the emitted arguments; no credential or private key is logged."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:5",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.11",
    "reason": "This development-only warning is a fixed legacy Session-resolution notice and interpolates no Message, identifier, credential, key, prompt, exception, or protected payload."
  },
  {
    "locator": "packages/db/scripts/finalize-m282-live-shadow-encryption.ts#filesystem_write:3dcc6339408547a4:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.12",
    "reason": "This migration-generation utility rewrites only the current checked-in SQL migration after deterministic M282 hardening; it is build-time schema source, not a runtime data, credential, key, or content store."
  },
  {
    "locator": "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:1",
    "owner": "packages/lattice-bridge",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.13",
    "reason": "This Browser warning interpolates only closed live-shadow stage and reason enums. It emits no Message content, ciphertext, envelope, manifest, identifier, credential, private key, or provider response."
  },
  {
    "locator": "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:c4f22f3fb6bab4a7:1",
    "owner": "packages/lattice-bridge",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.14",
    "reason": "This Browser warning interpolates only closed live-shadow stage and reason enums. It emits no Message content, ciphertext, envelope, manifest, identifier, credential, private key, or provider response."
  },
  {
    "locator": "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:a1436e7c26c240df:5",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.15",
    "reason": "This background-review diagnostic emits only a closed completion status or fixed failure literal; the catch deliberately omits the exception, transcript, Memory content, prompt, identifiers, credentials, and protected values."
  },
  {
    "locator": "packages/server/scripts/run-unit.ts#subprocess_processor:789672205608d10c:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-22.16",
    "reason": "This unit-test runner subprocess launches Bun with repository test file paths and numeric timeouts only; it has no runtime Human content, credential, key, prompt, or protected payload input."
  }
];
