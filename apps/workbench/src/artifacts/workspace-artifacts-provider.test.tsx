import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { StrictMode, useEffect, type ReactNode } from "react";
import type {
  ArtifactDto,
  ConditionalReadResult,
  ListArtifactsResponse,
  WorkspaceArtifactEvent,
} from "@nautilo/api-client/browser";

const firstArtifact: ArtifactDto = {
  id: "row-1",
  artifactId: "artifact-1",
  path: "notes/first.md",
  mimeType: "text/markdown",
  size: 12,
  revision: 1,
  updatedAt: "2026-07-17T08:00:00.000Z",
  createdAt: "2026-07-17T08:00:00.000Z",
  namespaceIds: [],
};

let viewerGeneration = 1;
let credentialGeneration = 1;
let activeRoomId: string | null = "room-1";
let verified = true;
let policyMode: "plaintext_only" | "shadow_encryption" | "encrypted_only" = "shadow_encryption";
let listImplementation = async (): Promise<{ artifacts: ArtifactDto[] }> => ({
  artifacts: [firstArtifact],
});
let conditionalListImplementation:
  | ((
      options: { roomId: string; ifNoneMatch?: string },
    ) => Promise<ConditionalReadResult<ListArtifactsResponse>>)
  | null = null;

const listWorkspaceArtifacts = mock(
  (options: { roomId: string; ifNoneMatch?: string }) =>
    conditionalListImplementation
      ? conditionalListImplementation(options)
      : listImplementation().then((body) => ({
          status: 200 as const,
          body,
          etag: 'W/"artifacts-v1"',
        })),
);
const listAllWorkspaceArtifacts = mock(
  async (_options: { roomId: string; signal?: AbortSignal }) => listImplementation(),
);
const getEncryptionPolicy = mock(async (_options?: { signal?: AbortSignal }) => ({
  policy: { mode: policyMode },
}));
const eventHandlers: Array<(event: WorkspaceArtifactEvent) => void> = [];
const eventOptions: Array<{ roomId: string; onOpen?: (reconnected: boolean) => void }> = [];
const closeHandlers: Array<ReturnType<typeof mock>> = [];
const subscribeWorkspaceArtifactEvents = mock(
  (
    handler: (event: WorkspaceArtifactEvent) => void,
    options: { roomId: string; onOpen?: (reconnected: boolean) => void },
  ) => {
    eventHandlers.push(handler);
    eventOptions.push(options);
    const close = mock(() => {});
    closeHandlers.push(close);
    return close;
  },
);
const revokeWorkspaceArtifactObjectUrl = mock(() => {});
let desktopCommitted:
  | ((batch: {
      idempotencyKey: string;
      events: WorkspaceArtifactEvent[];
    }) => Promise<void>)
  | null = null;
let desktopReconnect: (() => Promise<void>) | null = null;

mock.module("../hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      isVerified: verified,
      sessionUserId: verified ? "viewer-user" : null,
      sessionActorId: verified ? "viewer-actor" : null,
    },
    viewerGeneration,
    credentialGeneration,
  }),
}));

mock.module("../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ activeRoomId }),
}));

mock.module("../lib/api", () => ({
  apiClient: {
    admin: { encryptionTransition: { getPolicy: getEncryptionPolicy } },
    listAllWorkspaceArtifacts,
    listWorkspaceArtifactsConditional: listWorkspaceArtifacts,
    subscribeWorkspaceArtifactEvents,
    revokeWorkspaceArtifactObjectUrl,
  },
}));

mock.module("../lib/desktop", () => ({
  desktopAPI: {
    documentMutations: {
      onReconnect: (listener: () => Promise<void>) => {
        desktopReconnect = listener;
        return () => {
          desktopReconnect = null;
        };
      },
      onCommitted: (
        listener: (batch: {
          idempotencyKey: string;
          events: WorkspaceArtifactEvent[];
        }) => Promise<void>,
      ) => {
        desktopCommitted = listener;
        return () => {
          desktopCommitted = null;
        };
      },
    },
  },
}));

const {
  WorkspaceArtifactsProvider,
  useWorkspaceArtifactEventHub,
  useWorkspaceArtifacts,
} = await import("./workspace-artifacts-provider");

function Provider({ children }: { children: ReactNode }) {
  return <WorkspaceArtifactsProvider>{children}</WorkspaceArtifactsProvider>;
}

function Consumer({ name }: { name: string }) {
  const artifacts = useWorkspaceArtifacts();
  const subscribe = useWorkspaceArtifactEventHub();
  useEffect(() => subscribe(() => {}), [subscribe]);
  return (
    <div data-testid={name}>
      {artifacts.loading ? "loading" : artifacts.artifacts.map((artifact) => artifact.path).join(",")}
    </div>
  );
}

function RefreshConsumer() {
  const artifacts = useWorkspaceArtifacts();
  return <button onClick={() => artifacts.refresh("test")}>refresh</button>;
}

function RevisionConsumer() {
  const { artifacts } = useWorkspaceArtifacts();
  return <div data-testid="revision">{artifacts[0]?.revision ?? "none"}</div>;
}

function ReconnectConsumer({ onReconnect }: { readonly onReconnect: () => void }) {
  const subscribe = useWorkspaceArtifactEventHub();
  useEffect(() => subscribe(() => {}, { onReconnect }), [onReconnect, subscribe]);
  return null;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  viewerGeneration = 1;
  credentialGeneration = 1;
  activeRoomId = "room-1";
  verified = true;
  policyMode = "shadow_encryption";
  listImplementation = async () => ({ artifacts: [firstArtifact] });
  conditionalListImplementation = null;
  eventHandlers.length = 0;
  eventOptions.length = 0;
  closeHandlers.length = 0;
  listWorkspaceArtifacts.mockClear();
  listAllWorkspaceArtifacts.mockClear();
  listAllWorkspaceArtifacts.mockImplementation(async () => listImplementation());
  getEncryptionPolicy.mockClear();
  getEncryptionPolicy.mockImplementation(async () => ({ policy: { mode: policyMode } }));
  subscribeWorkspaceArtifactEvents.mockClear();
  revokeWorkspaceArtifactObjectUrl.mockClear();
  desktopCommitted = null;
  desktopReconnect = null;
});

describe("WorkspaceArtifactsProvider", () => {
  test("uses complete pages only in plaintext mode", async () => {
    policyMode = "plaintext_only";
    const second = { ...firstArtifact, id: "row-2", path: "notes/second.md" };
    listImplementation = async () => ({ artifacts: [firstArtifact, second] });
    const view = render(<Provider><Consumer name="consumer" /></Provider>);

    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("second.md"));
    expect(listAllWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    expect(listWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  test("retains the legacy conditional list in encrypted-only mode", async () => {
    policyMode = "encrypted_only";
    const view = render(<Provider><Consumer name="consumer" /></Provider>);

    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    expect(listAllWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  test("aborts an in-flight plaintext inventory when Room scope changes", async () => {
    policyMode = "plaintext_only";
    const signals: AbortSignal[] = [];
    listAllWorkspaceArtifacts.mockImplementation(async (options) => {
      signals.push(options.signal!);
      if (options.roomId === "room-1") {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        });
      }
      return { artifacts: [{ ...firstArtifact, id: "row-2", path: "new-room.md" }] };
    });
    const view = render(<Provider><Consumer name="consumer" /></Provider>);
    await waitFor(() => expect(listAllWorkspaceArtifacts).toHaveBeenCalledTimes(1));

    activeRoomId = "room-2";
    view.rerender(<Provider><Consumer name="consumer" /></Provider>);

    await waitFor(() => expect(view.getByTestId("consumer").textContent).toBe("new-room.md"));
    expect(signals[0]?.aborted).toBe(true);
  });

  test("shares one list and one EventSource across multiple consumers", async () => {
    const view = render(
      <StrictMode>
        <Provider>
          <Consumer name="first" />
          <Consumer name="second" />
        </Provider>
      </StrictMode>,
    );

    await waitFor(() => expect(view.getByTestId("first").textContent).toContain("first.md"));
    expect(view.getByTestId("second").textContent).toContain("first.md");
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    expect(subscribeWorkspaceArtifactEvents).toHaveBeenCalledTimes(1);
    expect(subscribeWorkspaceArtifactEvents).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ roomId: "room-1", onOpen: expect.any(Function) }),
    );
  });

  test("reconciles authoritative state when EventSource reopens", async () => {
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    act(() => eventOptions[0]?.onOpen?.(true));
    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2));
  });

  test("initial EventSource open closes the read-to-subscribe gap exactly once", async () => {
    const secondRevision = { ...firstArtifact, revision: 2 };
    const onReconnect = mock(() => {});
    const view = render(
      <Provider>
        <Consumer name="consumer" />
        <RevisionConsumer />
        <ReconnectConsumer onReconnect={onReconnect} />
      </Provider>,
    );
    await waitFor(() => expect(view.getByTestId("revision").textContent).toBe("1"));
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1);

    // Revision 2 commits after the initial list but before the live-only SSE
    // transport is established, so it cannot arrive as an event.
    listImplementation = async () => ({ artifacts: [secondRevision] });
    act(() => eventOptions[0]?.onOpen?.(false));
    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByTestId("revision").textContent).toBe("2"));
    expect(onReconnect).toHaveBeenCalledTimes(1);

    act(() => eventOptions[0]?.onOpen?.(false));
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  test("late subscribers resync once when the event stream is already ready", async () => {
    const onReconnect = mock(() => {});
    const view = render(
      <Provider>
        <div />
      </Provider>,
    );
    await waitFor(() => expect(eventOptions).toHaveLength(1));
    act(() => eventOptions[0]?.onOpen?.(false));
    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2));

    view.rerender(
      <Provider>
        <ReconnectConsumer onReconnect={onReconnect} />
      </Provider>,
    );
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
  });

  test("dedupes a Desktop batch after more than 1024 intervening batches", async () => {
    let accepted = 0;
    function DesktopConsumer() {
      const subscribe = useWorkspaceArtifactEventHub();
      useEffect(() => subscribe(() => { accepted += 1; }), [subscribe]);
      return null;
    }
    render(<Provider><DesktopConsumer /></Provider>);
    await waitFor(() => expect(desktopCommitted).not.toBeNull());
    const event = {
      type: "changed",
      id: "local-only",
      artifactId: "local-only",
      path: "/tmp/local-only",
    } as WorkspaceArtifactEvent;
    await desktopCommitted!({ idempotencyKey: "original", events: [event] });
    for (let index = 0; index < 1_025; index += 1) {
      await desktopCommitted!({ idempotencyKey: `other-${index}`, events: [event] });
    }
    await desktopCommitted!({ idempotencyKey: "original", events: [event] });
    expect(accepted).toBe(1_026);
  });

  test("Desktop reconnect awaits local consumer resync before later batches", async () => {
    const order: string[] = [];
    function LocalConsumer() {
      const subscribe = useWorkspaceArtifactEventHub();
      useEffect(() => subscribe(
        () => { order.push("batch"); },
        {
          onReconnect: async () => {
            await Promise.resolve();
            order.push("resynced");
          },
        },
      ), [subscribe]);
      return null;
    }
    render(<Provider><LocalConsumer /></Provider>);
    await waitFor(() => {
      expect(desktopReconnect).not.toBeNull();
      expect(desktopCommitted).not.toBeNull();
    });
    await desktopReconnect!();
    await desktopCommitted!({
      idempotencyKey: "after-reconnect",
      events: [{
        type: "changed",
        id: "local",
        artifactId: "local",
        path: "/tmp/local",
      } as WorkspaceArtifactEvent],
    });
    expect(order).toEqual(["resynced", "batch"]);
  });

  test("late local subscribers resync once after the Desktop mutation stream is ready", async () => {
    const onReconnect = mock(() => {});
    const view = render(
      <Provider>
        <div />
      </Provider>,
    );
    await waitFor(() => expect(desktopReconnect).not.toBeNull());

    await desktopReconnect!();
    view.rerender(
      <Provider>
        <ReconnectConsumer onReconnect={onReconnect} />
      </Provider>,
    );

    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
  });

  test("dedupes an exact committed SSE event by operation, group, and sequence", async () => {
    let accepted = 0;
    function ExactConsumer() {
      const subscribe = useWorkspaceArtifactEventHub();
      useEffect(() => subscribe(() => { accepted += 1; }), [subscribe]);
      return null;
    }
    render(<Provider><ExactConsumer /></Provider>);
    await waitFor(() => expect(eventHandlers.length).toBeGreaterThan(0));
    const event = {
      type: "document.mutation.committed",
      operationId: "operation-1",
      revisionGroupId: "group-1",
      sequence: 0,
      outcome: "applied",
      actor: { kind: "agent", agentId: "agent-1" },
      mutation: "update",
      before: {
        identity: { kind: "workspace_artifact", artifactId: firstArtifact.id, logicalPath: firstArtifact.path },
        backendVersion: { kind: "artifact_revision", revision: 1 },
        sha256: "a".repeat(64),
      },
      after: {
        identity: { kind: "workspace_artifact", artifactId: firstArtifact.id, logicalPath: firstArtifact.path },
        backendVersion: { kind: "artifact_revision", revision: 2 },
        sha256: "b".repeat(64),
      },
    } as WorkspaceArtifactEvent;
    await act(async () => {
      await eventHandlers[0]?.(event);
      await eventHandlers[0]?.(event);
    });
    expect(accepted).toBe(1);
  });

  test("reconciles the artifact list after a committed create", async () => {
    const createdArtifact: ArtifactDto = {
      ...firstArtifact,
      id: "row-created",
      artifactId: "artifact-created",
      path: "notes/created.md",
    };
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));
    listImplementation = async () => ({ artifacts: [firstArtifact, createdArtifact] });

    await act(async () => {
      await eventHandlers[0]?.({
        type: "document.mutation.committed",
        operationId: "operation-create",
        revisionGroupId: "group-create",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "agent", agentId: "agent-1" },
        mutation: "create",
        path: {
          kind: "create",
          after: {
            kind: "workspace_artifact",
            artifactId: createdArtifact.id,
            logicalPath: createdArtifact.path,
          },
        },
        after: {
          identity: {
            kind: "workspace_artifact",
            artifactId: createdArtifact.id,
            logicalPath: createdArtifact.path,
          },
          backendVersion: { kind: "artifact_revision", revision: 1 },
          sha256: "c".repeat(64),
        },
      });
    });

    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("created.md"));
  });

  test("applies rename and delete locally without refetching", async () => {
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));

    act(() => {
      eventHandlers[0]?.({
        type: "renamed",
        id: firstArtifact.id,
        oldPath: firstArtifact.path,
        newPath: "notes/renamed.md",
      });
    });
    expect(view.getByTestId("consumer").textContent).toContain("renamed.md");
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1);

    act(() => {
      eventHandlers[0]?.({
        type: "deleted",
        id: firstArtifact.id,
        artifactId: firstArtifact.artifactId,
      });
    });
    expect(view.getByTestId("consumer").textContent).toBe("");
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    expect(revokeWorkspaceArtifactObjectUrl).toHaveBeenCalledTimes(2);
  });

  test("merges a changed-event burst into one reconciliation", async () => {
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));

    const changed: WorkspaceArtifactEvent = {
      type: "changed",
      id: firstArtifact.id,
      artifactId: firstArtifact.artifactId,
      path: firstArtifact.path,
    };
    act(() => {
      eventHandlers[0]?.(changed);
      eventHandlers[0]?.(changed);
      eventHandlers[0]?.(changed);
    });

    await waitFor(
      () => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2),
      { timeout: 1_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 175));
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2);
  });

  test("refresh sends the scope ETag and preserves normalized state on 304", async () => {
    const view = render(
      <Provider>
        <Consumer name="consumer" />
        <RefreshConsumer />
      </Provider>,
    );
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));
    conditionalListImplementation = async (options) => {
      expect(options).toEqual({
        roomId: "room-1",
        ifNoneMatch: 'W/"artifacts-v1"',
      });
      return { status: 304, etag: 'W/"artifacts-v1"' };
    };

    act(() => view.getByRole("button").click());

    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2));
    expect(view.getByTestId("consumer").textContent).toBe("notes/first.md");
  });

  test("304 without normalized state performs one unconditional recovery", async () => {
    let call = 0;
    conditionalListImplementation = async (options) => {
      call += 1;
      if (call === 1) return { status: 304, etag: 'W/"orphan"' };
      expect(options).toEqual({ roomId: "room-1" });
      return {
        status: 200,
        body: { artifacts: [firstArtifact] },
        etag: 'W/"artifacts-v1"',
      };
    };
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );

    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2);
  });

  test("room scope change clears the previous list ETag", async () => {
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toContain("first.md"));

    activeRoomId = "room-2";
    view.rerender(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );

    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2));
    expect(listWorkspaceArtifacts.mock.calls[1]?.[0]).toEqual({ roomId: "room-2" });
  });

  test("reconnects once for a credential generation without refetching", async () => {
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    await waitFor(() => expect(subscribeWorkspaceArtifactEvents).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1));

    credentialGeneration = 2;
    view.rerender(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );

    await waitFor(() => expect(subscribeWorkspaceArtifactEvents).toHaveBeenCalledTimes(2));
    expect(closeHandlers[0]).toHaveBeenCalledTimes(1);
    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1);
  });

  test("isolates old room and viewer work from the new scope", async () => {
    let resolveOld:
      | ((result: { artifacts: ArtifactDto[] }) => void)
      | undefined;
    listImplementation = () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      });
    const view = render(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    await waitFor(() => expect(subscribeWorkspaceArtifactEvents).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(1));
    const oldHandler = eventHandlers[0];

    activeRoomId = "room-2";
    viewerGeneration = 2;
    listImplementation = async () => ({
      artifacts: [{ ...firstArtifact, id: "row-2", path: "new-viewer.md" }],
    });
    view.rerender(
      <Provider>
        <Consumer name="consumer" />
      </Provider>,
    );
    expect(view.getByTestId("consumer").textContent).toBe("loading");
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toBe("new-viewer.md"));

    act(() => {
      resolveOld?.({ artifacts: [{ ...firstArtifact, path: "leaked.md" }] });
      oldHandler?.({
        type: "renamed",
        id: "row-2",
        oldPath: "new-viewer.md",
        newPath: "old-room-event.md",
      });
    });
    await Promise.resolve();
    expect(view.getByTestId("consumer").textContent).toBe("new-viewer.md");
    expect(listWorkspaceArtifacts).toHaveBeenNthCalledWith(2, { roomId: "room-2" });
  });
});
