import { describe, expect, test } from "bun:test";
import type {
  BackendCommitPlan,
  BackendCommitOutcome,
  BackendCommitReceipt,
  DesktopFileMutationBackend,
  WorkspaceArtifactMutationBackend,
} from "../../src/backend";

type Assert<T extends true> = T;

interface WorkspacePrepared {
  readonly token: "workspace-prepared";
}

interface WorkspaceReceipt extends BackendCommitReceipt<"workspace"> {
  readonly storageTransactionId: string;
}

type WorkspaceBackend = WorkspaceArtifactMutationBackend<
  WorkspacePrepared,
  WorkspaceReceipt
>;
type DesktopBackend = DesktopFileMutationBackend<{ readonly token: "desktop-prepared" }>;

type WorkspaceKindIsRefined = Assert<
  WorkspaceBackend["kind"] extends "workspace" ? true : false
>;
type DesktopKindIsRefined = Assert<
  DesktopBackend["kind"] extends "desktop" ? true : false
>;
type WorkspacePlanRejectsDesktop = Assert<
  BackendCommitPlan<"desktop"> extends Parameters<WorkspaceBackend["prepare"]>[0]
    ? false
    : true
>;

const localIdentity = {
  kind: "local_file" as const,
  relayId: "relay-1",
  canonicalPath: "/tmp/d448/backend-contract.md",
};
const localSha256 = "a".repeat(64);
const localVersion = {
  identity: localIdentity,
  backendVersion: { kind: "local_sha" as const, sha256: localSha256 },
  sha256: localSha256,
};

describe("D448 document mutation backend contract", () => {
  test("exposes one read-only preparation seam and explicit write/recovery seams", () => {
    const methodNames: Array<keyof WorkspaceBackend> = [
      "kind",
      "prepare",
      "commitPrepared",
      "compensate",
    ];

    expect(methodNames).toEqual([
      "kind",
      "prepare",
      "commitPrepared",
      "compensate",
    ]);
  });

  test("carries an explicit commit receipt through compensation", async () => {
    const receipt: WorkspaceReceipt = {
      backend: "workspace",
      operationId: "operation-1",
      revisionGroupId: "revision-group-1",
      entries: [],
      storageTransactionId: "transaction-1",
    };
    let compensated: WorkspaceReceipt | undefined;
    const enlistedEventBatch = {
      operationId: "operation-1",
      revisionGroupId: "revision-group-1",
      idempotencyKey:
        'document-mutation:v1:["operation-1","revision-group-1"]',
      events: [],
    };

    const backend: WorkspaceBackend = {
      kind: "workspace",
      prepare: async () => ({
        kind: "prepared",
        prepared: { token: "workspace-prepared" },
      }),
      commitPrepared: async (input) => {
        expect(input.revisionGroupId).toBe("revision-group-1");
        expect(input.buildCommittedEventBatch(receipt)).toBe(enlistedEventBatch);
        return { kind: "committed", receipt, enlistedEventBatch };
      },
      compensate: async (input) => {
        compensated = input.receipt;
        return {
          kind: "compensated",
          operationId: "operation-1",
          revisionGroupId: "revision-group-1",
          disposition: "rolled_back",
          entries: [],
        };
      },
      disposePrepared: () => undefined,
    };

    const plan = {
      operationId: "operation-1",
      actor: { kind: "agent" as const, agentId: "agent-1" },
      entries: [],
    } as unknown as BackendCommitPlan<"workspace">;
    const prepared = { token: "workspace-prepared" as const };
    const committed = await backend.commitPrepared({
      plan,
      prepared,
      revisionGroupId: "revision-group-1",
      buildCommittedEventBatch: () => enlistedEventBatch,
    });
    expect(committed).toEqual({ kind: "committed", receipt, enlistedEventBatch });
    if (committed.kind !== "committed") throw new Error("expected commit");

    expect(
      await backend.compensate({
        plan,
        prepared,
        revisionGroupId: "revision-group-1",
        receipt: committed.receipt,
      }),
    ).toMatchObject({ kind: "compensated", disposition: "rolled_back" });
    expect(compensated).toBe(receipt);
  });

  test("represents prepare, commit, and compensation failures without throwing", async () => {
    const backend: DesktopBackend = {
      kind: "desktop",
      prepare: async () => ({
        kind: "failed",
        code: "backend_unavailable",
        diagnostics: [{ code: "relay_offline", message: "relay is offline" }],
      }),
      commitPrepared: async () => ({
        kind: "conflict",
        code: "stale_version",
        evidence: [{
          path: { kind: "update", before: localIdentity, after: localIdentity },
          currentVersion: localVersion,
        }],
        diagnostics: [{ code: "cas_failed", message: "version changed" }],
      }),
      compensate: async () => ({
        kind: "failed",
        code: "inconsistent_outcome",
        diagnostics: [{ code: "rollback_unknown", message: "rollback could not be proven" }],
      }),
      disposePrepared: () => undefined,
    };

    expect((await backend.prepare({} as BackendCommitPlan<"desktop">)).kind).toBe(
      "failed",
    );
    expect(
      (
        await backend.commitPrepared({
          plan: {} as BackendCommitPlan<"desktop">,
          prepared: { token: "desktop-prepared" },
          revisionGroupId: "group-1",
          buildCommittedEventBatch: () => {
            throw new Error("not reached by a conflict");
          },
        })
      ).kind,
    ).toBe("conflict");
    expect(
      (
        await backend.compensate({
          plan: {} as BackendCommitPlan<"desktop">,
          prepared: { token: "desktop-prepared" },
          revisionGroupId: "group-1",
        })
      ).kind,
    ).toBe("failed");
  });

  test("distinguishes pre-write conflicts from failures requiring recovery", () => {
    const conflict: BackendCommitOutcome<"desktop", BackendCommitReceipt<"desktop">> = {
      kind: "conflict",
      code: "stale_version",
      evidence: [{
        path: { kind: "update", before: localIdentity, after: localIdentity },
        currentVersion: localVersion,
      }],
      diagnostics: [],
    };
    const commitStartedFailure: BackendCommitOutcome<
      "desktop",
      BackendCommitReceipt<"desktop">
    > = {
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: true,
      diagnostics: [{ code: "replace_failed", message: "commit may have started" }],
    };
    const preWriteFailure: BackendCommitOutcome<
      "desktop",
      BackendCommitReceipt<"desktop">
    > = {
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
      diagnostics: [{ code: "admission_failed", message: "no write started" }],
    };

    expect("requiresCompensation" in conflict).toBe(false);
    expect(commitStartedFailure.requiresCompensation).toBe(true);
    expect(preWriteFailure.requiresCompensation).toBe(false);
  });
});

void (0 as unknown as WorkspaceKindIsRefined);
void (0 as unknown as DesktopKindIsRefined);
void (0 as unknown as WorkspacePlanRejectsDesktop);
