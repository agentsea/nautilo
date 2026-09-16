/**
 * M033 Phase 2C — artifact-store trust-context contract.
 *
 * Runs in its own `bun test` invocation (see `package.json` `test:unit`) so
 * `@nautilo/db` mocks from other unit tests do not pollute the module cache.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const FIXTURE_USER = "10000000-0000-4000-8000-000000000001";
const FIXTURE_AGENT = "20000000-0000-4000-8000-000000000002";

const withTrustContextCalls: Array<{ userId: string; agentId?: string }> = [];
let transactionCallbackFinished: (() => void) | null = null;
let transactionCompletion: Promise<void> | null = null;
let transactionFailure: Error | null = null;
let bumpArtifactResult: Record<string, unknown> | null = null;
let diagnosticsThrow = false;

beforeAll(() => {
  mock.module("@nautilo/config", () => ({
    getArtifactsRoot: () => "/tmp/nautilo-artifacts-test",
  }));
  mock.module("@nautilo/logger", () => ({
    warn: () => {
      if (diagnosticsThrow) throw new Error("logger unavailable");
    },
  }));

  // Barrel `@nautilo/trust` re-exports queries.ts (which imports `agentScopes`
  // from `@nautilo/db`). Stub only the envelope helpers artifact-store needs.
  mock.module("@nautilo/trust", () => ({
    assertCanWriteArtifacts: async () => {},
    envelopeReadableNamespaces: (envelope: { readableNamespaces?: string[] } | null | undefined) =>
      envelope?.readableNamespaces ?? [],
    envelopeMutableNamespaces: (envelope: { mutableNamespaces?: string[] } | null | undefined) =>
      envelope?.mutableNamespaces ?? [],
    envelopeWritableNamespaces: (envelope: { writableNamespaces?: string[] } | null | undefined) =>
      envelope?.writableNamespaces ?? [],
    isScopeMemoryEnvelope: (
      envelope: { memoryMode?: string; scopeId?: string } | null | undefined,
    ) =>
      envelope != null &&
      envelope.memoryMode === "scope" &&
      typeof envelope.scopeId === "string",
  }));

  mock.module("@nautilo/db", () => ({
    agentDb: {},
    attachArtifactToNamespace: async () => {},
    bumpArtifactRevision: async () => bumpArtifactResult,
    findArtifactByPathForNamespaces: async () => null,
    findArtifactByInternalIdForNamespacesIncludingDeleted: async () => null,
    getArtifactNamespaces: async () => [],
    getArtifactPathByInternalId: async () => null,
    insertArtifact: async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      artifactId: "art-1",
      path: "notes.md",
    }),
    listArtifactsForNamespaces: async () => [],
    markArtifactDeleted: async () => {},
    updateArtifactPath: async () => null,
    getSharedDirectAgentDb: () => ({}),
    withTrustContext: async <T>(
      ctx: { userId: string; agentId?: string },
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      if (!ctx.userId || ctx.userId.length === 0) {
        throw new Error(
          "withTrustContext: ctx.userId is required (non-empty string). " +
            "Pass the authenticated speaker's users.id.",
        );
      }
      withTrustContextCalls.push(ctx);
      const result = await fn({});
      transactionCallbackFinished?.();
      if (transactionCompletion) await transactionCompletion;
      if (transactionFailure) throw transactionFailure;
      return result;
    },
  }));
});

afterEach(() => {
  transactionCallbackFinished = null;
  transactionCompletion = null;
  transactionFailure = null;
  bumpArtifactResult = null;
  diagnosticsThrow = false;
});

async function importArtifactStore(): Promise<
  typeof import("../../src/tools/file/artifact-store")
> {
  const href = new URL("../../src/tools/file/artifact-store.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<
    typeof import("../../src/tools/file/artifact-store")
  >;
}

describe("artifact-store trust context", () => {
  test("resolveWorkspaceArtifact calls withAgentTrustContext with envelope userId + agentId", async () => {
    withTrustContextCalls.length = 0;
    const { resolveWorkspaceArtifact } = await importArtifactStore();

    await resolveWorkspaceArtifact({
      logicalPath: "notes.md",
      facts: {
        userId: FIXTURE_USER,
        agentId: FIXTURE_AGENT,
        readableNamespaces: ["read-ns"],
        mutableNamespaces: ["mut-ns"],
        writableNamespaces: ["write-ns"],
      },
      intent: "read",
    });

    expect(withTrustContextCalls).toEqual([
      { userId: FIXTURE_USER, agentId: FIXTURE_AGENT },
    ]);
  });

  test("applyWorkspaceArtifactRowChange rejects empty userId", async () => {
    const { applyWorkspaceArtifactRowChange } = await importArtifactStore();
    return expect(
      applyWorkspaceArtifactRowChange(
        {
          mode: "create",
          artifactId: "art-1",
          logicalPath: "notes.md",
          namespaceId: "ns-1",
          storageUri: "file:///tmp/x",
        },
        10,
        "",
        FIXTURE_AGENT,
        { kind: "agent", agentId: FIXTURE_AGENT },
      ),
    ).rejects.toThrow(/userId is required/);
  });

  test("applyWorkspaceArtifactRowChange emits create only after transaction commit", async () => {
    let releaseCommit!: () => void;
    transactionCompletion = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const callbackFinished = new Promise<void>((resolve) => {
      transactionCallbackFinished = resolve;
    });
    const {
      applyWorkspaceArtifactRowChange,
      setWorkspaceArtifactEventSink,
      setWorkspaceArtifactCreatedSink,
    } =
      await importArtifactStore();
    const events: unknown[] = [];
    const creationFacts: unknown[] = [];
    setWorkspaceArtifactEventSink((event) => events.push(event));
    setWorkspaceArtifactCreatedSink((fact) => { creationFacts.push(fact); });

    const applying = applyWorkspaceArtifactRowChange(
      {
        mode: "create",
        artifactId: "art-1",
        logicalPath: "notes.md",
        namespaceId: "ns-1",
        storageUri: "file:///tmp/x",
      },
      10,
      FIXTURE_USER,
      FIXTURE_AGENT,
      { kind: "agent", agentId: FIXTURE_AGENT },
    );

    await callbackFinished;
    expect(events).toHaveLength(0);
    expect(creationFacts).toHaveLength(0);

    releaseCommit();
    await applying;
    expect(events).toEqual([
      {
        type: "workspace.artifact.changed",
        id: "11111111-1111-4111-8111-111111111111",
        artifactId: "art-1",
        path: "notes.md",
      },
    ]);
    expect(creationFacts).toEqual([{
      artifactInternalId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "ns-1",
      actor: { kind: "agent", agentId: FIXTURE_AGENT },
      occurrenceKey: "artifact.added:create:11111111-1111-4111-8111-111111111111",
    }]);
    setWorkspaceArtifactEventSink(null);
    setWorkspaceArtifactCreatedSink(null);
  });

  test("applyWorkspaceArtifactRowChange contains creation observer failure", async () => {
    const {
      applyWorkspaceArtifactRowChange,
      setWorkspaceArtifactCreatedSink,
    } = await importArtifactStore();
    setWorkspaceArtifactCreatedSink(async () => {
      throw new Error("feed unavailable");
    });
    diagnosticsThrow = true;

    const result = await applyWorkspaceArtifactRowChange(
      {
        mode: "create",
        artifactId: "art-1",
        logicalPath: "notes.md",
        namespaceId: "ns-1",
        storageUri: "file:///tmp/x",
      },
      10,
      FIXTURE_USER,
      FIXTURE_AGENT,
      { kind: "human", userId: FIXTURE_USER },
    );

    expect(result?.internalId).toBe("11111111-1111-4111-8111-111111111111");
    setWorkspaceArtifactCreatedSink(null);
  });

  test("explicit internal suppression and updates emit no creation fact", async () => {
    const {
      applyWorkspaceArtifactRowChange,
      setWorkspaceArtifactCreatedSink,
    } = await importArtifactStore();
    const facts: unknown[] = [];
    setWorkspaceArtifactCreatedSink((fact) => { facts.push(fact); });

    await applyWorkspaceArtifactRowChange(
      {
        mode: "create",
        artifactId: "art-1",
        logicalPath: "internal.md",
        namespaceId: "ns-1",
        storageUri: "file:///tmp/internal",
      },
      10,
      FIXTURE_USER,
      FIXTURE_AGENT,
      null,
    );
    bumpArtifactResult = {
      id: "11111111-1111-4111-8111-111111111111",
      artifactId: "art-1",
      path: "internal.md",
      revision: 2,
    };
    await applyWorkspaceArtifactRowChange(
      {
        mode: "update",
        artifactId: "art-1",
        logicalPath: "internal.md",
        namespaceId: "ns-1",
        storageUri: "file:///tmp/internal",
        rowId: "11111111-1111-4111-8111-111111111111",
      },
      11,
      FIXTURE_USER,
      FIXTURE_AGENT,
      { kind: "agent", agentId: FIXTURE_AGENT },
    );

    expect(facts).toEqual([]);
    setWorkspaceArtifactCreatedSink(null);
  });

  test("applyWorkspaceArtifactRowChange does not emit when commit fails", async () => {
    transactionFailure = new Error("commit failed");
    const { applyWorkspaceArtifactRowChange, setWorkspaceArtifactEventSink } =
      await importArtifactStore();
    const events: unknown[] = [];
    setWorkspaceArtifactEventSink((event) => events.push(event));

    const failure = await applyWorkspaceArtifactRowChange(
      {
        mode: "create",
        artifactId: "art-1",
        logicalPath: "notes.md",
        namespaceId: "ns-1",
        storageUri: "file:///tmp/x",
      },
      10,
      FIXTURE_USER,
      FIXTURE_AGENT,
      { kind: "agent", agentId: FIXTURE_AGENT },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("commit failed");
    expect(events).toHaveLength(0);
    setWorkspaceArtifactEventSink(null);
  });
});
