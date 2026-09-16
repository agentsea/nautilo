import { describe, expect, test } from "bun:test";
import type { RelayCapabilities, RelayStatus } from "@nautilo/relay";
import {
  createRelayCapabilityPublisher,
  type RelayCapabilityPublisherOptions,
} from "../../electron/relay-capability-publisher";

type PublisherClient = RelayCapabilityPublisherOptions["client"];

function capabilities(state = "current"): RelayCapabilities {
  return { profile: "desktop-agent", state } as RelayCapabilities;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createClient(options: {
  status?: RelayStatus;
  acknowledgedRevision?: number | null;
  onUpdate?: (next: RelayCapabilities) => Promise<void>;
} = {}): {
  client: PublisherClient;
  updates: RelayCapabilities[];
  setStatus(status: RelayStatus): void;
  setAcknowledgedRevision(revision: number | null): void;
} {
  let status = options.status ?? "connected";
  let acknowledgedRevision = options.acknowledgedRevision === undefined
    ? 0
    : options.acknowledgedRevision;
  const updates: RelayCapabilities[] = [];
  return {
    client: {
      getStatus: () => status,
      getAcknowledgedCapabilityRevision: () => acknowledgedRevision,
      updateCapabilities: async (next) => {
        updates.push(next);
        await options.onUpdate?.(next);
      },
    },
    updates,
    setStatus(next) {
      status = next;
    },
    setAcknowledgedRevision(next) {
      acknowledgedRevision = next;
    },
  };
}

describe("RelayCapabilityPublisher", () => {
  test("rebuilds once and exposes the exact client-acknowledged revision", async () => {
    const mock = createClient({
      acknowledgedRevision: 4,
      onUpdate: async () => {
        mock.setAcknowledgedRevision(7);
      },
    });
    let builds = 0;
    const publisher = createRelayCapabilityPublisher({
      client: mock.client,
      capabilityBuilder: async () => {
        builds += 1;
        return capabilities();
      },
    });

    expect(await publisher.refresh("single success")).toBe(true);
    expect(builds).toBe(1);
    expect(mock.updates).toEqual([capabilities()]);
    expect(publisher.getAcknowledgedCapabilityRevision()).toBe(7);
  });

  test("returns false silently without building for disconnected or closed sessions", async () => {
    const mock = createClient({ status: "disconnected" });
    const warnings: string[] = [];
    let builds = 0;
    const publisher = createRelayCapabilityPublisher({
      client: mock.client,
      capabilityBuilder: async () => {
        builds += 1;
        return capabilities();
      },
      reportWarning: (message) => warnings.push(message),
    });

    expect(await publisher.refresh("offline")).toBe(false);
    publisher.close();
    expect(await publisher.refresh("after close")).toBe(false);

    expect(builds).toBe(0);
    expect(mock.updates).toEqual([]);
    expect(publisher.getAcknowledgedCapabilityRevision()).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("returns false for builder or update failures", async () => {
    const warnings: string[] = [];
    const builderFailure = createRelayCapabilityPublisher({
      client: createClient().client,
      capabilityBuilder: async () => {
        throw new Error("builder failed");
      },
      reportWarning: (message) => warnings.push(message),
    });
    const updateFailure = createRelayCapabilityPublisher({
      client: createClient({
        onUpdate: async () => {
          throw new Error("update rejected");
        },
      }).client,
      capabilityBuilder: async () => capabilities(),
      reportWarning: (message) => warnings.push(message),
    });

    expect(await builderFailure.refresh("builder")).toBe(false);
    expect(await updateFailure.refresh("update")).toBe(false);
    expect(warnings).toEqual([
      "[relay] refreshDesktopRelayCapabilities failed (builder): builder failed",
      "[relay] refreshDesktopRelayCapabilities failed (update): update rejected",
    ]);
  });

  test("requires a non-null accepted revision and delegates revision gaps to the client", async () => {
    const nullAck = createClient({ acknowledgedRevision: null });
    const nullAckPublisher = createRelayCapabilityPublisher({
      client: nullAck.client,
      capabilityBuilder: async () => capabilities(),
      reportWarning: () => {},
    });
    expect(await nullAckPublisher.refresh("missing acknowledgement")).toBe(false);

    const rejected = createClient({
      acknowledgedRevision: 12,
      onUpdate: async () => {
        throw new Error("server rejected revision 13");
      },
    });
    const rejectedPublisher = createRelayCapabilityPublisher({
      client: rejected.client,
      capabilityBuilder: async () => capabilities(),
      reportWarning: () => {},
    });
    expect(await rejectedPublisher.refresh("rejected")).toBe(false);
    expect(rejectedPublisher.getAcknowledgedCapabilityRevision()).toBe(12);
    rejected.setAcknowledgedRevision(19);
    expect(rejectedPublisher.getAcknowledgedCapabilityRevision()).toBe(19);
  });

  test("runs one trailing rebuild from latest local state after a concurrent mutation", async () => {
    const firstUpdate = deferred<void>();
    const secondUpdate = deferred<void>();
    const updates = [firstUpdate, secondUpdate];
    let updateIndex = 0;
    const mock = createClient({
      acknowledgedRevision: 1,
      onUpdate: async () => updates[updateIndex++]!.promise,
    });
    let state = "v1";
    const publisher = createRelayCapabilityPublisher({
      client: mock.client,
      capabilityBuilder: async () => capabilities(state),
      reportWarning: () => {},
    });

    const first = publisher.refresh("first");
    await flush();
    state = "v2";
    const mutation = publisher.refresh("mutation");
    firstUpdate.resolve();
    await flush();
    expect(mock.updates).toEqual([capabilities("v1"), capabilities("v2")]);
    secondUpdate.resolve();

    expect(await Promise.all([first, mutation])).toEqual([true, true]);
  });

  test("coalesces many concurrent callers into one trailing pass", async () => {
    const firstUpdate = deferred<void>();
    const secondUpdate = deferred<void>();
    const updates = [firstUpdate, secondUpdate];
    let updateIndex = 0;
    const mock = createClient({
      acknowledgedRevision: 1,
      onUpdate: async () => updates[updateIndex++]!.promise,
    });
    const publisher = createRelayCapabilityPublisher({
      client: mock.client,
      capabilityBuilder: async () => capabilities(),
      reportWarning: () => {},
    });

    const refreshes = [
      publisher.refresh("first"),
      publisher.refresh("second"),
      publisher.refresh("third"),
      publisher.refresh("fourth"),
    ];
    await flush();
    expect(mock.updates).toHaveLength(1);
    firstUpdate.resolve();
    await flush();
    expect(mock.updates).toHaveLength(2);
    secondUpdate.resolve();

    expect(await Promise.all(refreshes)).toEqual([true, true, true, true]);
    expect(mock.updates).toHaveLength(2);
  });

  test("keeps draining when a mutation arrives during the trailing pass", async () => {
    const firstUpdate = deferred<void>();
    const secondUpdate = deferred<void>();
    const thirdUpdate = deferred<void>();
    const updates = [firstUpdate, secondUpdate, thirdUpdate];
    let updateIndex = 0;
    const mock = createClient({
      acknowledgedRevision: 1,
      onUpdate: async () => updates[updateIndex++]!.promise,
    });
    let state = "v1";
    const publisher = createRelayCapabilityPublisher({
      client: mock.client,
      capabilityBuilder: async () => capabilities(state),
      reportWarning: () => {},
    });

    const first = publisher.refresh("first");
    await flush();
    state = "v2";
    const second = publisher.refresh("second");
    firstUpdate.resolve();
    await flush();
    state = "v3";
    const third = publisher.refresh("third");
    secondUpdate.resolve();
    await flush();
    expect(mock.updates).toEqual([
      capabilities("v1"),
      capabilities("v2"),
      capabilities("v3"),
    ]);
    thirdUpdate.resolve();

    expect(await Promise.all([first, second, third])).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("makes every joined caller observe a trailing failure", async () => {
    const firstUpdate = deferred<void>();
    const trailingUpdate = deferred<void>();
    const updates = [firstUpdate, trailingUpdate];
    let updateIndex = 0;
    const mock = createClient({
      acknowledgedRevision: 1,
      onUpdate: async () => updates[updateIndex++]!.promise,
    });
    const publisher = createRelayCapabilityPublisher({
      client: mock.client,
      capabilityBuilder: async () => capabilities(),
      reportWarning: () => {},
    });

    const first = publisher.refresh("first");
    await flush();
    const joined = publisher.refresh("mutation");
    firstUpdate.resolve();
    await flush();
    trailingUpdate.reject(new Error("trailing failure"));

    expect(await Promise.all([first, joined])).toEqual([false, false]);
  });

  test("fences work when closed during capability building or update", async () => {
    const build = deferred<RelayCapabilities>();
    const buildClient = createClient();
    const buildWarnings: string[] = [];
    const duringBuild = createRelayCapabilityPublisher({
      client: buildClient.client,
      capabilityBuilder: () => build.promise,
      reportWarning: (message) => buildWarnings.push(message),
    });
    const buildRefresh = duringBuild.refresh("during build");
    duringBuild.close();
    build.resolve(capabilities());
    expect(await buildRefresh).toBe(false);
    expect(buildClient.updates).toEqual([]);
    expect(buildWarnings).toEqual([]);

    const update = deferred<void>();
    const updateClient = createClient({ onUpdate: () => update.promise });
    const updateWarnings: string[] = [];
    const duringUpdate = createRelayCapabilityPublisher({
      client: updateClient.client,
      capabilityBuilder: async () => capabilities(),
      reportWarning: (message) => updateWarnings.push(message),
    });
    const updateRefresh = duringUpdate.refresh("during update");
    await flush();
    duringUpdate.close();
    update.resolve();
    expect(await updateRefresh).toBe(false);
    expect(duringUpdate.getAcknowledgedCapabilityRevision()).toBeNull();
    expect(updateWarnings).toEqual([]);
  });

  test("an old late completion cannot affect a replacement publisher", async () => {
    const oldUpdate = deferred<void>();
    const oldClient = createClient({ onUpdate: () => oldUpdate.promise });
    const oldPublisher = createRelayCapabilityPublisher({
      client: oldClient.client,
      capabilityBuilder: async () => capabilities("old"),
      reportWarning: () => {},
    });
    const oldRefresh = oldPublisher.refresh("old");
    await flush();
    oldPublisher.close();

    const replacementClient = createClient({ acknowledgedRevision: 73 });
    const replacement = createRelayCapabilityPublisher({
      client: replacementClient.client,
      capabilityBuilder: async () => capabilities("replacement"),
      reportWarning: () => {},
    });
    expect(await replacement.refresh("replacement")).toBe(true);
    oldUpdate.resolve();

    expect(await oldRefresh).toBe(false);
    expect(oldPublisher.getAcknowledgedCapabilityRevision()).toBeNull();
    expect(replacement.getAcknowledgedCapabilityRevision()).toBe(73);
    expect(replacementClient.updates).toEqual([capabilities("replacement")]);
  });
});
