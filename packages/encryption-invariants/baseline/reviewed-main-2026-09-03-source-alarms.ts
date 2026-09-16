import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/navigation-guards.ts#log_emitter:22cc91395afb3c3e:1",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:a2c097607fc17ff1:1",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:d564d0a1aa531512:1",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:f9989c2fafa6868a:1",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:fd0363cb144e0e47:1",
  "packages/lattice-bridge/src/server/delivery/postgres-human-memory-access-namespace-provisioning-port.ts#network_processor:b84635f56d5d4fce:1",
  "packages/server/src/routes/stt.ts#log_emitter:7ef703451e44cded:1",
  "packages/server/src/routes/stt.ts#log_emitter:7ef703451e44cded:2",
]);

const CONTENT_FREE_EXCLUSIONS = [
  "apps/desktop/electron/crypto-installation-identity.ts#filesystem_write:79f23d204ffc9bc5:1",
  "apps/desktop/electron/crypto-installation-identity.ts#filesystem_write:b10d011bfedcae33:1",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:52de83cd17db4dc1:1",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:9318a4d9f9cc61d8:3",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:9318a4d9f9cc61d8:4",
  "apps/desktop/electron/navigation-guards.ts#log_emitter:9318a4d9f9cc61d8:5",
  "apps/desktop/scripts/vendor-agent-browser.ts#subprocess_processor:efeec715522456c0:1",
  "packages/agent/src/subagents/scope-subagent/run.ts#log_emitter:0ae25e725db4e950:3",
  "packages/db/scripts/finalize-m304-human-device-membership.ts#filesystem_write:3dcc6339408547a4:1",
  "packages/server/src/app.ts#log_emitter:2f2c670d3d97e24d:1",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:11",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:12",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:13",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:14",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:15",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:16",
  "packages/server/src/app.ts#log_emitter:a1436e7c26c240df:14",
  "packages/server/src/app.ts#log_emitter:a1436e7c26c240df:15",
  "packages/server/src/app.ts#log_emitter:c915ecb77b1982e2:1",
  "packages/server/src/app.ts#log_emitter:d0e3502dbae9334e:1",
] as const;

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

export const REVIEWED_MAIN_2026_09_03_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  ...CONTENT_FREE_EXCLUSIONS.map((locator, index) => ({
    locator,
    owner: owner(locator),
    closure: "reviewed_exclusion" as const,
    exclusionId: `exclusion.main-2026-09-03.${String(index + 1).padStart(3, "0")}`,
    reason: locator.includes("crypto-installation-identity")
      ? "The atomic device-local file contains only a random installation UUID under an account-coordinate hash; it contains no Human content, credential, private key, or recovery phrase."
      : locator.includes("navigation-guards")
      ? "The navigation diagnostic emits only a fixed window label, public URL origin or redacted protocol, numeric error code, main-frame boolean, and error class name; paths, query strings, credentials, and exception messages are excluded."
      : locator.includes("vendor-agent-browser")
      ? "This build-only subprocess invokes the fixed macOS codesign executable over a pinned checksum-verified vendor binary with a closed argv and no Human content."
      : locator.includes("finalize-m304")
      ? "This build-only finalizer rewrites the generated M304 migration using fixed SQL constraints and grants; it never reads runtime Human data."
      : locator.includes("scope-subagent")
      ? "This diagnostic is a fixed failure label with no identifiers, message content, tool arguments, or exception text."
      : "This server diagnostic contains only a fixed event or failure label and bounded operational metadata such as an error class, task/tool identifier, enum, counter, or boolean; it excludes Human content, credentials, paths, URLs, and exception messages.",
  })),
  {
    locator: "packages/agent/src/tools/file/workspace-binary-artifact.ts#filesystem_write:efeb5832012963cd:1",
    owner: "packages/agent",
    closure: "declaration",
    declarationId: "source.main-2026-09-03.workspace-binary-artifact-atomic-write",
    reason: "The atomic rename commits bytes exclusively into the canonical Workspace artifact file boundary; that artifact content class is already explicitly inventoried and is not a diagnostic or hidden secondary cache.",
  },
];
