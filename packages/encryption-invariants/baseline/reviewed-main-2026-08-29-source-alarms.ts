import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/main.ts#filesystem_write:9d488e79a14c69f8:1",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:29",
  "apps/desktop/electron/relay.ts#filesystem_write:c2b508ec908efd15:1",
  "apps/workbench/src/pages/admin/sections/server-section.tsx#network_processor:ef993855494c1601:1",
  "apps/workbench/src/pages/admin/sections/server-section.tsx#network_processor:ef993855494c1601:2",
  "packages/agent/src/providers/models.ts#log_emitter:5f777c5c1195885a:1",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:a1436e7c26c240df:5"
]);

export const REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    "locator": "apps/desktop/electron/main.ts#filesystem_write:218fe5ecdd80c5db:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.001",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/main.ts#filesystem_write:3b0a9b3ba0efccb7:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.002",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:86dfa121e0954a46:2",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.003",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:86dfa121e0954a46:3",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.004",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:86dfa121e0954a46:4",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.005",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:86dfa121e0954a46:5",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.006",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:14",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.92ef12e59de75625",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:14 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:14 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:0d2ab469d7540d61:8",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.008",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:0d2ab469d7540d61:9",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.009",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:6e30eac9e1dfdc48:5",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.818ccd9978afbc54",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:6e30eac9e1dfdc48:5 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:6e30eac9e1dfdc48:5 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:1d20e50546d0320b:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.011",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:02d6d32a757bab9d:5",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.923f6b5e1b23c375",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:02d6d32a757bab9d:5 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:02d6d32a757bab9d:5 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:3483715c79228f92:2",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.f8c330de951ca44c",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:3483715c79228f92:2 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:3483715c79228f92:2 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:6e30eac9e1dfdc48:6",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.c6ee4eb140257de1",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:6e30eac9e1dfdc48:6 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:6e30eac9e1dfdc48:6 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:02d6d32a757bab9d:6",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.fd79b11fb611c425",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:02d6d32a757bab9d:6 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:02d6d32a757bab9d:6 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:6eab313eca52a747:10",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.7e68e2724d17d287",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:6eab313eca52a747:10 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:6eab313eca52a747:10 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:468c68ed4723a1f2:13",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.8b9b42471a6221fd",
    "surface": "log",
    "reason": "apps/desktop/electron/main.ts#log_emitter:468c68ed4723a1f2:13 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/main.ts#log_emitter:468c68ed4723a1f2:13 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-protected-receipt.ts#filesystem_write:d4be315881d61559:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.018",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-protected-receipt.ts#filesystem_write:70b318ac90f9404d:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.019",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-protected-receipt.ts#filesystem_write:1d9cd071660f2125:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.020",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-protected-receipt.ts#filesystem_write:cdf27617097dd647:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.021",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-store.ts#filesystem_write:1f8b94ec5dbc7a8c:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.022",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-store.ts#filesystem_write:70b318ac90f9404d:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.023",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-store.ts#filesystem_write:7eb1b6af5e8b4970:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.024",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/ready-to-work-store.ts#filesystem_write:d45f91bcf9838951:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.025",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/relay-identity.ts#filesystem_write:66e0f3723b7ca406:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.026",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scan/ledger.ts#filesystem_write:fda32526d64b4cb2:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.027",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scan/ledger.ts#filesystem_write:cd760dfd57153ca8:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.028",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scan/ledger.ts#filesystem_write:684b20b3a4b025e9:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.029",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scan/probes.ts#subprocess_processor:58e0f0247dd6f0a6:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.030",
    "reason": "This exact subprocess launches a pinned local build, security-scanner, or test executable with bounded arguments and does not send runtime Human content to an undeclared processor."
  },
  {
    "locator": "apps/desktop/electron/security-scan/probes.ts#filesystem_write:5ccd26a6f7811f29:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.031",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#filesystem_write:8b9a09b3159d9b76:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.032",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#network_processor:435ae3163d057b39:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.033",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#filesystem_write:ba5d2c12455eb4f1:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.034",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#filesystem_write:a0aec14f6f16671c:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.035",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#filesystem_write:0450917f904629c9:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.036",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#filesystem_write:0d9b712464fb4166:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.037",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#filesystem_write:381011b71566d644:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.038",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#filesystem_write:6f926038a613c7fe:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.039",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#subprocess_processor:9a3c20b325b23ae4:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.040",
    "reason": "This exact subprocess launches a pinned local build, security-scanner, or test executable with bounded arguments and does not send runtime Human content to an undeclared processor."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#network_processor:6c24ec35de6f4868:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.041",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/acquisition.ts#network_processor:4d7083c0e2acb6f0:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.042",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/security-scanner-runtime/contracts.ts#network_processor:3faa351deeb4d7eb:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.043",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "apps/desktop/electron/terminal-host.ts#log_emitter:02d6d32a757bab9d:1",
    "owner": "apps/desktop",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.0d789d3d67a7c2ff",
    "surface": "log",
    "reason": "apps/desktop/electron/terminal-host.ts#log_emitter:02d6d32a757bab9d:1 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/desktop/electron/terminal-host.ts#log_emitter:02d6d32a757bab9d:1 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/desktop/electron/working-folder-bootstrap.ts#filesystem_write:1dae418539de8cb8:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.045",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/desktop/electron/working-folder-bootstrap.ts#filesystem_write:846fcc8dd2d54d26:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.046",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:2",
    "owner": "apps/workbench",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.543884e464cdf59b",
    "surface": "log",
    "reason": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:2 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:2 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:3",
    "owner": "apps/workbench",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.f605fc401909657a",
    "surface": "log",
    "reason": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:3 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:3 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:6",
    "owner": "apps/workbench",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.aaad25c01e92982f",
    "surface": "log",
    "reason": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:6 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:6 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:4",
    "owner": "apps/workbench",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.a9e88f753b279308",
    "surface": "log",
    "reason": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:4 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:4 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:5",
    "owner": "apps/workbench",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.fd00d8f3dbc4d01c",
    "surface": "log",
    "reason": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:5 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:5 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:8",
    "owner": "apps/workbench",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.614b80e86a8ba1f4",
    "surface": "log",
    "reason": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:8 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:8 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:9",
    "owner": "apps/workbench",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.820941bf38cbe934",
    "surface": "log",
    "reason": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:9 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:9 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "apps/workbench/src/pages/settings/sections/integrations-section.tsx#network_processor:0d2ab469d7540d61:1",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.065",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:739fc3280a2bc297:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.066",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/agent/src/providers/models.ts#log_emitter:7992bdae5d3847b8:1",
    "owner": "packages/agent",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.3a3a1a89002c22c0",
    "surface": "log",
    "reason": "packages/agent/src/providers/models.ts#log_emitter:7992bdae5d3847b8:1 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/agent/src/providers/models.ts#log_emitter:7992bdae5d3847b8:1 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/agent/src/tools/invocation-service.ts#log_emitter:a1436e7c26c240df:6",
    "owner": "packages/agent",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.ac94def94d38ebdc",
    "surface": "log",
    "reason": "packages/agent/src/tools/invocation-service.ts#log_emitter:a1436e7c26c240df:6 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/agent/src/tools/invocation-service.ts#log_emitter:a1436e7c26c240df:6 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/agent/src/tools/invocation-service.ts#log_emitter:89b81c36ea23316a:12",
    "owner": "packages/agent",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.9910f32b4fa45a11",
    "surface": "log",
    "reason": "packages/agent/src/tools/invocation-service.ts#log_emitter:89b81c36ea23316a:12 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/agent/src/tools/invocation-service.ts#log_emitter:89b81c36ea23316a:12 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/db/scripts/finalize-m275-history-read-observations.ts#filesystem_write:3dcc6339408547a4:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.070",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/db/scripts/finalize-m290-namespace-key-authority.ts#filesystem_write:62924c159468268e:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.071",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/db/scripts/finalize-m291-grant-domain-authority.ts#filesystem_write:3dcc6339408547a4:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.072",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/db/scripts/finalize-m295-human-peer-shadow-encryption.ts#filesystem_write:3dcc6339408547a4:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.073",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/db/scripts/finalize-m296-shared-agent-shadow-encryption.ts#filesystem_write:3dcc6339408547a4:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.074",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/db/scripts/finalize-m298-runtime-foreground-authority.ts#filesystem_write:3dcc6339408547a4:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.075",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/db/scripts/finalize-m299-runtime-conductor.ts#filesystem_write:3dcc6339408547a4:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.076",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:2",
    "owner": "packages/lattice-bridge",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.077",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:3",
    "owner": "packages/lattice-bridge",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.078",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:4",
    "owner": "packages/lattice-bridge",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.079",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#network_processor:ecdb74deb380f50e:1",
    "owner": "packages/lattice-bridge",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.080",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:2e4fde9b770ba976:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.081",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:350c0237cb789809:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.082",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:23b71105b44a571d:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.083",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:3f7bffaaeb905342:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.084",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:e093c37728b553a7:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.085",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:42fcfc8385eee45e:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.086",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:d7ad263b84b6f0ee:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.087",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/limit-invariants/src/node/cli.ts#filesystem_write:5539bf9372b30e46:1",
    "owner": "packages/limit-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.088",
    "reason": "This exact filesystem write is either deterministic build output or an owner-local bounded state/receipt with explicit lifecycle controls; it is not a server-side plaintext Human-content store."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.089",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.090",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:5",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.091",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.092",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.093",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:9",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.094",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:10",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.095",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.86e6f11db3e9f8cb",
    "surface": "log",
    "reason": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:1 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:1 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.a092ef68a5969c76",
    "surface": "log",
    "reason": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:2 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:2 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.fd85df3f1cda6a04",
    "surface": "log",
    "reason": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:3 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/server/src/messaging/message-deletion.ts#log_emitter:a1436e7c26c240df:3 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/server/src/realtime/ws-publisher.ts#log_emitter:a1436e7c26c240df:6",
    "owner": "packages/server",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.054568d37b7e014f",
    "surface": "log",
    "reason": "packages/server/src/realtime/ws-publisher.ts#log_emitter:a1436e7c26c240df:6 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/server/src/realtime/ws-publisher.ts#log_emitter:a1436e7c26c240df:6 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/server/src/realtime/ws-publisher.ts#log_emitter:a1436e7c26c240df:7",
    "owner": "packages/server",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.a47878e028637974",
    "surface": "log",
    "reason": "packages/server/src/realtime/ws-publisher.ts#log_emitter:a1436e7c26c240df:7 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/server/src/realtime/ws-publisher.ts#log_emitter:a1436e7c26c240df:7 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  },
  {
    "locator": "packages/server/src/routes/device-wrapped-namespace-authority.ts#network_processor:f7c0cebe3e9d3558:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.101",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "packages/server/src/routes/device-wrapped-namespace-authority.ts#network_processor:5422109854fd482e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.102",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "packages/server/src/routes/device-wrapped-namespace-authority.ts#network_processor:77c81f8f4ed0b82f:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.103",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "packages/server/src/routes/grant-domain-authority.ts#network_processor:f7c0cebe3e9d3558:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.104",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "packages/server/src/routes/grant-domain-authority.ts#network_processor:f5e3151a7fa038d3:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.105",
    "reason": "This exact network processor carries a closed authenticated control-plane or protected-crypto protocol already covered by DTO and route tests; it does not create an undeclared persistence channel."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message.ts#log_emitter:2f2c670d3d97e24d:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.106",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message.ts#log_emitter:d0e3502dbae9334e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-08-29.107",
    "reason": "This exact diagnostic emits only fixed status text and closed lifecycle codes or counts; plaintext content, credentials, private keys, prompts, and protected byte buffers are excluded."
  },
  {
    "locator": "packages/server/src/routes/sessions.ts#log_emitter:2f2c670d3d97e24d:1",
    "owner": "packages/server",
    "closure": "baseline_debt",
    "debtId": "debt.source-alarm.log.log_emitter.0347b39b1117f1b6",
    "surface": "log",
    "reason": "packages/server/src/routes/sessions.ts#log_emitter:2f2c670d3d97e24d:1 remains an explicit log-emitter alarm because the diagnostic can include an identifier, path, endpoint, or sanitized exception string; no claim is made that this dynamic text is encrypted today.",
    "remediationState": "planned",
    "releaseImpact": "blocks_whole_product_claim",
    "evidenceGap": "packages/server/src/routes/sessions.ts#log_emitter:2f2c670d3d97e24d:1 needs log-emitter alarm evidence proving every dynamic argument is content-free or a later protected logging boundary before this debt can close."
  }
];
