import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_M301_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  ...[
    "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:6",
    "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:7",
  ].map((locator, index) => ({
    locator,
    owner: "apps/workbench",
    closure: "declaration" as const,
    declarationId: `source.m301.domain-key-runtime-failure-${index + 1}`,
    reason:
      "This V2 Domain-key catch-up diagnostic emits a fixed stage label plus only an exception type name or primitive type. It excludes exception text, Message content, ciphertext, keys, grants, credentials, identifiers, and provider responses.",
  })),
  {
    locator:
      "apps/workbench/src/pages/settings/sections/genie-backup-restore.tsx#backup_export:d52d07ff87142c91:1",
    owner: "apps/workbench",
    closure: "declaration",
    declarationId: "source.m301.encrypted-profile-backup-export",
    reason:
      "This user-initiated download receives only the password-encrypted profile archive produced on the device. Plain profile and Memory records are encrypted before the browser creates the downloadable Blob, and temporary passphrase and avatar buffers are wiped in the finally path.",
  },
  ...[
    "packages/agent/src/tools/utilities/web-search.ts#log_emitter:89b81c36ea23316a:1",
    "packages/agent/src/tools/utilities/web-search.ts#log_emitter:89b81c36ea23316a:2",
    "packages/agent/src/tools/utilities/web-search.ts#log_emitter:89b81c36ea23316a:3",
  ].map((locator, index) => ({
    locator,
    owner: "packages/agent",
    closure: "reviewed_exclusion" as const,
    exclusionId: `exclusion.m301.web-search-timing-${index + 1}`,
    reason:
      "This exact Web Search lifecycle line contains only a closed stage code, elapsed and remaining millisecond counters, and a closed outcome code. It emits no query, URL, search result, page content, prompt, response, credential, or exception text.",
  })),
  {
    locator:
      "packages/db/scripts/finalize-m301-domain-key-authority.ts#filesystem_write:3dcc6339408547a4:1",
    owner: "packages/db",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.m301.generated-migration-finalizer",
    reason:
      "This build-time finalizer rewrites only the generated M301 SQL migration with deterministic table privileges, RLS policies, triggers, and validation functions derived from the checked-in schema contract. It never reads or writes runtime product data, Human content, keys, credentials, or instance state.",
  },
];
