/**
 * D448 Phase 6.1.3 — code-adjacent map from the mutation-authority inventory
 * to concrete characterization/compatibility coverage. This is intentionally
 * a reviewed map, not a source-token scan: a test file is evidence only when
 * its listed behavior actually enters the classified authority.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const manifestPath = join(import.meta.dir, "document-mutation-entrypoints.json");
const SUPPORTED_DISPOSITIONS = new Set([
  "planner",
  "coordinator_adapter",
  "compatibility_only",
  "excluded",
]);

type ManifestEntry = { id: string; disposition: string };
type Manifest = { entries: ManifestEntry[] };
type Coverage = {
  /** Human review note describing the exercised authority or narrow deferral. */
  rationale: string;
  /** Concrete behavioral test(s), never a source-wiring check. */
  tests?: readonly string[];
  /** Low-level primitive: its classified caller(s) have the behavioral tests. */
  callerEvidence?: readonly string[];
  /** Deliberate failing state until a behavior test is added. */
  uncovered?: true;
};

const COVERAGE: Record<string, Coverage> = {
  "W-UI-TEXT": {
    rationale: "Exercises artifact and filesystem editor saves, including conflict translation.",
    tests: ["apps/workbench/tests/unit-isolated/editor-io.test.ts"],
  },
  "W-UI-CONFLICT": {
    rationale: "Exercises both filesystem and artifact conflict-copy writes without overwriting the original.",
    tests: ["apps/workbench/tests/unit-isolated/editor-conflict-copy.test.ts"],
  },
  "W-UI-SESSION": {
    rationale: "Exercises patch-first editor persistence, snapshot fallback, rebase, and dirty-draft conflicts.",
    tests: ["apps/workbench/tests/unit-isolated/d448-editor-mdx-characterization.test.tsx"],
  },
  "WRITER-UI": {
    rationale: "Exercises bound artifact and filesystem document writes through the app bridge.",
    tests: ["apps/workbench/tests/unit-isolated/app-bridge.test.ts"],
  },
  "LOCAL-CREATE": {
    rationale: "Exercises FilesTab's local create flow: validation, stat-before-write, explicit baseSha256:null creation, rejection handling, and opening only after the durable write succeeds.",
    tests: ["apps/workbench/tests/unit-isolated/d448-files-tab-create-characterization.test.tsx"],
  },
  "APP-CREATE-CURRENT-FOLDER": {
    rationale: "Exercises the app create-action Current Folder path through stat-before-write, explicit baseSha256:null creation, Workspace non-use, and opening the exact durable local target.",
    tests: ["apps/workbench/src/components/browser-column/apps-panel.test.tsx"],
  },
  "LOCAL-RENAME-TRASH-UI": {
    rationale: "Exercises FileTree rename/trash callbacks with exact destination/target arguments and failure propagation.",
    tests: ["apps/workbench/tests/unit/file-tree-move.test.ts"],
  },
  "ARTIFACT-ROUTES": {
    rationale: "Exercises real route save and anchored patch persistence, artifact bytes, rows, and events.",
    tests: ["packages/server/tests/integration/d448-artifact-save-patch-characterization.integration.test.ts"],
  },
  "OFFICE-LIVE-WS": {
    rationale: "Exercises WOPI PutFile bytes, debounce revision/event behavior, and token/lock/write gates.",
    tests: ["packages/server/tests/unit-isolated/d448-wopi-compatibility.test.ts"],
  },
  "WRITER-AGENT-AND-OFFICE-RUN": {
    rationale: "Exercises Writer document writes and compatibility-only office.run Workspace import/output commits.",
    tests: [
      "packages/server/tests/integration/d448-writer-mutation-characterization.integration.test.ts",
      "packages/server/tests/integration/d448-office-run-workspace-importer.integration.test.ts",
    ],
  },
  "WRITER-ACCEPT": {
    rationale: "Exercises accepted Writer Workspace and Current Folder bytes, including stale rejection.",
    tests: ["packages/server/tests/integration/d448-writer-mutation-characterization.integration.test.ts"],
  },
  "WRITER-ACCEPT-AUTHORITY": {
    rationale: "Exercises the live-local authority behind Writer accepted writes and its stale-base behavior.",
    tests: ["packages/server/tests/integration/d448-writer-mutation-characterization.integration.test.ts"],
  },
  "FILE-WS-COMMANDS": {
    rationale: "Exercises Workspace command routing through artifact-authorized file mutations.",
    tests: ["packages/agent/tests/integration/file-tool-workspace-artifact.integration.test.ts"],
  },
  "FILE-WS-STAGED-COMMITTER": {
    rationale: "Exercises the real staged Workspace write, row-change, revision, and reload-required contract.",
    tests: ["packages/agent/tests/unit/workspace-artifact-document-patch.test.ts"],
  },
  "FILE-WS-STAGED-PLANNER": {
    rationale: "Exercises binary OfficeCLI output entering the generic staged Workspace patch path.",
    tests: ["packages/agent/src/tools/office/d448-officecli-workspace-characterization.test.ts"],
  },
  "WORKSPACE-CONTENT-EXECUTION-REGISTRY": {
    rationale: "Exercises the installed canonical Workspace content commit and same-request recovery executions through real file-tool mutation and recovery flows.",
    tests: ["packages/agent/tests/integration/file-tool-workspace-artifact.integration.test.ts"],
  },
  "WORKSPACE-TEXT-PATCH": {
    rationale: "Exercises text-patch conflicts and the route-level anchored patch persistence contract.",
    tests: [
      "packages/agent/tests/unit/user-patch-conflict-kind.test.ts",
      "packages/server/tests/integration/d448-artifact-save-patch-characterization.integration.test.ts",
    ],
  },
  "WORKSPACE-TEXT-SAVE": {
    rationale: "Exercises the Workspace human-save path and its stale write rejection through the real Writer host.",
    tests: ["packages/server/tests/integration/d448-writer-mutation-characterization.integration.test.ts"],
  },
  "WORKSPACE-BINARY-CREATE": {
    rationale: "Exercises Workspace binary artifact creation through the compatibility importer/output path.",
    tests: ["packages/server/tests/integration/d448-office-run-workspace-importer.integration.test.ts"],
  },
  "WORKSPACE-ROW-CORE": {
    rationale: "Low-level DB row/event primitive; behavior is covered only through classified callers that own byte-to-row ordering.",
    callerEvidence: ["FILE-WS-STAGED-COMMITTER", "WORKSPACE-TEXT-PATCH", "WORKSPACE-TEXT-SAVE", "WORKSPACE-BINARY-CREATE", "PATCH-WS-COMMIT", "OFFICE-CREATE-WS", "MEDIA-GENERATE-WS"],
  },
  "WORKSPACE-BYTE-PRIMITIVE": {
    rationale: "Low-level atomic byte primitive; callers, not the primitive, define document mutation semantics.",
    callerEvidence: ["FILE-WS-STAGED-COMMITTER", "WORKSPACE-TEXT-PATCH", "WORKSPACE-TEXT-SAVE", "WORKSPACE-BINARY-CREATE", "PATCH-WS-COMMIT"],
  },
  "WORKSPACE-FS-ADAPTER": {
    rationale: "Filesystem adapter is transport-only; Workspace commit callers provide the durable behavior coverage.",
    callerEvidence: ["FILE-WS-STAGED-COMMITTER", "WORKSPACE-TEXT-PATCH", "WORKSPACE-TEXT-SAVE", "WORKSPACE-BINARY-CREATE", "PATCH-WS-COMMIT"],
  },
  "WORKSPACE-REVISION-STORAGE": {
    rationale: "Revision storage is a low-level persistence primitive; revision-producing callers own the observable mutation contract.",
    callerEvidence: ["FILE-WS-STAGED-COMMITTER", "WORKSPACE-TEXT-PATCH", "WORKSPACE-TEXT-SAVE", "PATCH-WS-COMMIT"],
  },
  "PATCH-WS-COMMIT": {
    rationale: "Exercises production apply_patch Workspace byte, row, revision, partial, and conflict reconciliation.",
    tests: ["packages/agent/tests/unit/apply-patch-workspace-production-adapter.test.ts"],
  },
  "OFFICE-AGENT-WS": {
    rationale: "Exercises a real Workspace OfficeCLI post-image through the generic binary patch committer and open-editor lockout.",
    tests: ["packages/agent/src/tools/office/d448-officecli-workspace-characterization.test.ts"],
  },
  "OFFICE-CREATE-WS": {
    rationale: "Exercises Workspace Office create/import routing and its artifact output behavior.",
    tests: ["packages/agent/src/tools/office/office-workspace.test.ts"],
  },
  "CONVERT": {
    rationale: "Exercises the convert tool's generated binary patch path and output integrity handling.",
    tests: ["packages/agent/src/tools/convert/convert-tool.test.ts"],
  },
  "MEDIA-GENERATE-WS": {
    rationale: "Exercises generated image Workspace artifact creation and its binary output boundary.",
    tests: ["packages/agent/tests/unit-isolated/generate-image-tool.test.ts"],
  },
  "FILE-LOCAL-COMMIT": {
    rationale: "Exercises typed local writes, durable device revisions, events, and undo/redo.",
    tests: ["apps/desktop/tests/integration/d448-local-document-mutation-characterization.test.ts"],
  },
  "FILE-LOCAL-GUARDED-WRITE": {
    rationale: "Low-level guarded write helper; local command and Office callers own mutation/journal behavior.",
    callerEvidence: ["FILE-LOCAL-COMMIT", "OFFICE-AGENT-LOCAL"],
  },
  "OFFICE-AGENT-LOCAL": {
    rationale: "Exercises Current Folder OfficeCLI final OOXML commits, journal compensation, and events.",
    tests: ["apps/desktop/tests/integration/d448-officecli-current-characterization.test.ts"],
  },
  "PATCH-LOCAL-RECONCILER": {
    rationale: "Exercises actual apply_patch transaction reconciliation for stale human bytes, recovery, revision, and undo.",
    tests: ["apps/desktop/tests/integration/d448-local-document-mutation-characterization.test.ts"],
  },
  "HISTORY-LOCAL": {
    rationale: "Exercises typed local undo/redo and durable history append behavior.",
    tests: ["apps/desktop/tests/integration/d448-local-document-mutation-characterization.test.ts"],
  },
  "STRUCTURED-SSH-CAPABILITY-STORE": {
    rationale: "Exercises compatibility-only local persistence for the exact Human, Genie, relay, Desktop-session, and server-bound SSH capability, including stale writes and fail-closed storage states.",
    tests: ["apps/desktop/tests/unit/structured-ssh-capability-store.test.ts"],
  },
  "STRUCTURED-SSH-CONTRACT-STORAGE": {
    rationale: "Exercises the shared atomic structured-SSH storage adapter through both capability and host-trust persistence without treating either control-plane store as document mutation authority.",
    tests: [
      "apps/desktop/tests/unit/structured-ssh-capability-store.test.ts",
      "apps/desktop/tests/unit/structured-ssh-host-trust-store.test.ts",
    ],
  },
  "STRUCTURED-SSH-HOST-TRUST-STORE": {
    rationale: "Exercises compatibility-only local host-trust persistence, explicit replacement, removal, bounded history, and fail-closed corrupt or unavailable storage.",
    tests: ["apps/desktop/tests/unit/structured-ssh-host-trust-store.test.ts"],
  },
  "COMPUTER-USE-CONTRACT-STORAGE": {
    rationale: "Exercises the compatibility-only Computer Use control-plane storage adapter's injected 0600 atomic filesystem discipline and durable readback without treating local settings or receipts as document bytes.",
    tests: ["apps/desktop/tests/unit-isolated/computer-use-local-store.test.ts"],
  },
  "COMPUTER-USE-LOCAL-STORE": {
    rationale: "Exercises compatibility-only Computer Use policy and receipt persistence, corruption and binding failures, explicit recovery, generation ordering, and concurrent serialization.",
    tests: ["apps/desktop/tests/unit-isolated/computer-use-local-store.test.ts"],
  },
  "LOCAL-STRUCTURAL-IPC": {
    rationale: "Exercises registered local write, rename, and recoverable trash handlers against real temporary files, including SHA-CAS conflict preservation and sender-first/allowed-root no-mutation guards.",
    tests: ["apps/desktop/tests/unit-isolated/d448-local-structural-ipc-characterization.test.ts"],
  },
  "LOCAL-IPC-ATOMIC-PRIMITIVE": {
    rationale: "Low-level IPC atomic write primitive; LOCAL-STRUCTURAL-IPC now characterizes its registered caller with real create, CAS-update, and conflict-preservation behavior.",
    callerEvidence: ["LOCAL-STRUCTURAL-IPC"],
  },
  "OFFICE-RUN-COMPATIBILITY": {
    rationale: "Exercises compatibility-only office.run Workspace importer/output without claiming a coordinator fallback.",
    tests: [
      "packages/server/tests/integration/d448-office-run-workspace-importer.integration.test.ts",
      "apps/desktop/tests/integration/d448-officecli-current-characterization.test.ts",
    ],
  },
};

function readManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function auditCoverage(entries: readonly ManifestEntry[], coverage: Record<string, Coverage>): string[] {
  const knownIds = new Set(entries.map((entry) => entry.id));
  const dispositionById = new Map(entries.map((entry) => [entry.id, entry.disposition]));
  const errors: string[] = [];

  for (const entry of entries) {
    const mapped = coverage[entry.id];
    if (!mapped) {
      errors.push(`${entry.id}: missing coverage map entry`);
      continue;
    }
    if (!SUPPORTED_DISPOSITIONS.has(entry.disposition)) {
      errors.push(`${entry.id}: unsupported disposition ${entry.disposition}`);
    }
    if (mapped.rationale.trim().length === 0) errors.push(`${entry.id}: blank rationale`);
    if (mapped.uncovered === true) {
      errors.push(`${entry.id}: uncovered — ${mapped.rationale}`);
      continue;
    }
    if (entry.disposition === "excluded") {
      if (!mapped.callerEvidence || mapped.callerEvidence.length === 0) {
        errors.push(`${entry.id}: excluded primitive lacks classified caller evidence`);
      }
      for (const callerId of mapped.callerEvidence ?? []) {
        if (!knownIds.has(callerId)) errors.push(`${entry.id}: unknown caller evidence ${callerId}`);
        else if (dispositionById.get(callerId) === "excluded") {
          errors.push(`${entry.id}: caller evidence ${callerId} is also excluded`);
        }
      }
      continue;
    }
    if (!mapped.tests || mapped.tests.length === 0) {
      errors.push(`${entry.id}: no concrete characterization/compatibility test`);
      continue;
    }
    for (const testPath of mapped.tests) {
      if (!/\.test\.(?:ts|tsx)$/.test(testPath)) {
        errors.push(`${entry.id}: non-test coverage path ${testPath}`);
      } else if (!existsSync(join(repoRoot, testPath))) {
        errors.push(`${entry.id}: missing coverage test ${testPath}`);
      }
    }
  }
  for (const id of Object.keys(coverage)) {
    if (!knownIds.has(id)) errors.push(`${id}: coverage references no manifest entry`);
  }
  return errors.sort();
}

describe("D448 mutation characterization coverage", () => {
  test("every inventory authority has grounded behavior coverage or a narrow excluded-caller disposition", () => {
    const errors = auditCoverage(readManifest().entries, COVERAGE);
    expect(errors).toEqual([]);
  });

  test("rejects missing tests, blank rationales, unsupported dispositions, and missing map rows", () => {
    const base: ManifestEntry[] = [
      { id: "A", disposition: "coordinator_adapter" },
      { id: "B", disposition: "excluded" },
      { id: "C", disposition: "not_supported" },
      { id: "D", disposition: "planner" },
    ];
    const errors = auditCoverage(base, {
      A: { rationale: "", tests: ["missing.test.ts"] },
      B: { rationale: "primitive", callerEvidence: ["B"] },
      C: { rationale: "unsupported", tests: ["also-missing.test.ts"] },
    });
    expect(errors).toEqual([
      "A: blank rationale",
      "A: missing coverage test missing.test.ts",
      "B: caller evidence B is also excluded",
      "C: missing coverage test also-missing.test.ts",
      "C: unsupported disposition not_supported",
      "D: missing coverage map entry",
    ]);
  });
});
