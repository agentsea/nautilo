/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  createSettingsDataState,
  settingsScopeForVerifiedViewer,
  type SettingsDataScope,
} from "./settings-data-state";

const viewerOne: SettingsDataScope = {
  serverId: "server-one",
  userId: "user-one",
  actorId: "actor-one",
};
const viewerTwo: SettingsDataScope = {
  serverId: "server-two",
  userId: "user-two",
  actorId: "actor-two",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Deterministic deadline seam; Settings tests never sleep on wall-clock time. */
function deadlineClock() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    schedule: (callback: () => void) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (handle: ReturnType<typeof setTimeout>) => {
      callbacks.delete(handle as unknown as number);
    },
    fireNext: () => {
      const next = callbacks.entries().next().value as [number, () => void] | undefined;
      if (!next) throw new Error("expected an active Settings read deadline");
      callbacks.delete(next[0]);
      next[1]();
    },
    activeCount: () => callbacks.size,
  };
}

describe("Settings data-state scope fence", () => {
  test("accepts only an active server with a verified signed-in viewer", () => {
    expect(
      settingsScopeForVerifiedViewer(
        { id: "server-one" },
        { status: "signed-in", viewerState: "verified", viewer: viewerOne },
      ),
    ).toEqual(viewerOne);
    expect(
      settingsScopeForVerifiedViewer(
        { id: "server-one" },
        { status: "signed-in", viewerState: "cached", viewer: viewerOne },
      ),
    ).toBeNull();
  });

  test("ignores a slow read after a server switch and clears drafts and secrets", async () => {
    const state = createSettingsDataState<{ label: string }, { name: string }>();
    const read = deferred<{ label: string }>();
    state.setScope(viewerOne);
    state.setDraft({ name: "unsaved" });
    expect(state.revealSecret("one-time-code")).toBe(true);

    const completion = state.load(async () => read.promise);
    state.setScope(viewerTwo);
    read.resolve({ label: "from server one" });

    expect(await completion).toEqual({ status: "ignored" });
    expect(state.getState()).toMatchObject({
      scope: viewerTwo,
      data: null,
      draft: null,
      secret: { status: "hidden", secret: null },
      loading: false,
    });
  });

  test("switching away and back never revives the previous server's completion", async () => {
    const state = createSettingsDataState<string, string>();
    const firstRead = deferred<string>();
    state.setScope(viewerOne);
    const first = state.load(async () => firstRead.promise);

    state.setScope(viewerTwo);
    state.setScope(viewerOne);
    firstRead.resolve("old account data");

    expect(await first).toEqual({ status: "ignored" });
    expect(state.getState().data).toBeNull();
  });

  test("a newer read fences an older completion within the same verified account", async () => {
    const state = createSettingsDataState<string, string>();
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    state.setScope(viewerOne);
    const oldCompletion = state.load(async () => oldRead.promise);
    const newCompletion = state.retryLoad(async () => newRead.promise);

    oldRead.resolve("stale value");
    newRead.resolve("canonical value");

    expect(await oldCompletion).toEqual({ status: "ignored" });
    expect(await newCompletion).toEqual({ status: "applied", data: "canonical value" });
    expect(state.getState().data).toBe("canonical value");
  });

  test("a stalled Settings read becomes a retryable failure at its finite deadline", async () => {
    const clock = deadlineClock();
    const state = createSettingsDataState<string, null>({
      readDeadlineMs: 1,
      scheduleReadDeadline: clock.schedule,
      clearReadDeadline: clock.clear,
    });
    const read = deferred<string>();
    state.setScope(viewerOne);
    const completion = state.load(async () => read.promise);

    expect(state.getState()).toMatchObject({ loading: true, loadError: null });
    expect(clock.activeCount()).toBe(1);
    clock.fireNext();

    const result = await completion;
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toBeInstanceOf(Error);
    expect(state.getState()).toMatchObject({
      loading: false,
      data: null,
      loadError: new Error("Nautilo did not respond. Try again."),
    });
    expect(clock.activeCount()).toBe(0);
  });

  test("a late read completion cannot overwrite a deadline failure", async () => {
    const clock = deadlineClock();
    const state = createSettingsDataState<string, null>({
      scheduleReadDeadline: clock.schedule,
      clearReadDeadline: clock.clear,
    });
    const read = deferred<string>();
    state.setScope(viewerOne);
    const completion = state.load(async () => read.promise);
    clock.fireNext();

    expect((await completion).status).toBe("failed");
    read.resolve("must stay inert");
    await Promise.resolve();

    expect(state.getState()).toMatchObject({
      loading: false,
      data: null,
      loadError: new Error("Nautilo did not respond. Try again."),
    });
  });

  test("retry, scope change, and disposal cancel pending read deadlines", async () => {
    const clock = deadlineClock();
    const state = createSettingsDataState<string, null>({
      scheduleReadDeadline: clock.schedule,
      clearReadDeadline: clock.clear,
    });
    const firstRead = deferred<string>();
    const secondRead = deferred<string>();
    state.setScope(viewerOne);
    const first = state.load(async () => firstRead.promise);
    expect(clock.activeCount()).toBe(1);

    const second = state.retryLoad(async () => secondRead.promise);
    expect(await first).toEqual({ status: "ignored" });
    expect(clock.activeCount()).toBe(1);

    state.setScope(viewerTwo);
    expect(await second).toEqual({ status: "ignored" });
    expect(clock.activeCount()).toBe(0);

    const third = state.load(async () => new Promise<string>(() => {}));
    expect(clock.activeCount()).toBe(1);
    state.dispose();
    expect(await third).toEqual({ status: "ignored" });
    expect(clock.activeCount()).toBe(0);
  });

  test("logout, auth-dead, and unmount make slow reads inert", async () => {
    for (const transition of ["logout", "auth-dead", "unmount"] as const) {
      const state = createSettingsDataState<string, string>();
      const read = deferred<string>();
      state.setScope(viewerOne);
      state.setDraft("keep no data");
      state.revealSecret("recovery-code");
      const completion = state.load(async () => read.promise);

      if (transition === "unmount") state.dispose();
      else state.setScope(null);
      read.resolve("must not render");

      expect(await completion).toEqual({ status: "ignored" });
      expect(state.getState()).toMatchObject({
        scope: null,
        data: null,
        draft: null,
        secret: { status: "hidden", secret: null },
      });
    }
  });

  test("a stale write completion cannot mutate or refresh the next account", async () => {
    const state = createSettingsDataState<string, { displayName: string }>();
    const write = deferred<void>();
    let reloads = 0;
    state.setScope(viewerOne);
    state.setDraft({ displayName: "Nautilo" });
    const completion = state.mutate(
      async () => write.promise,
      async () => {
        reloads += 1;
        return "canonical";
      },
    );

    state.setScope(viewerTwo);
    write.resolve();

    expect(await completion).toEqual({ status: "ignored" });
    expect(reloads).toBe(0);
    expect(state.getState()).toMatchObject({ scope: viewerTwo, data: null, draft: null });
  });

  test("retry keeps a non-secret draft, clears a reveal, and claims success only after canonical reload", async () => {
    const state = createSettingsDataState<{ saved: string }, { displayName: string }>();
    const firstAttempt = deferred<void>();
    const canonical = deferred<{ saved: string }>();
    state.setScope(viewerOne);
    state.setDraft({ displayName: "Nautilo" });
    state.revealSecret("never retry this");

    const retry = state.mutate(
      async () => firstAttempt.promise,
      async () => canonical.promise,
    );
    expect(state.getState()).toMatchObject({
      draft: { displayName: "Nautilo" },
      secret: { status: "hidden", secret: null },
      mutating: true,
    });

    firstAttempt.resolve();
    await Promise.resolve();
    expect(state.getState().mutating).toBe(true);
    canonical.resolve({ saved: "canonical value" });

    expect(await retry).toEqual({ status: "applied", data: { saved: "canonical value" } });
    expect(state.getState()).toMatchObject({
      data: { saved: "canonical value" },
      draft: { displayName: "Nautilo" },
      mutating: false,
      mutationError: null,
    });
  });

  test("a failed write preserves only the non-secret draft for retry", async () => {
    const state = createSettingsDataState<string, { displayName: string }>();
    state.setScope(viewerOne);
    state.setDraft({ displayName: "Retry me" });
    state.revealSecret("one-time-code");
    const failure = new Error("network unavailable");

    expect(
      await state.mutate(
        async () => {
          throw failure;
        },
        async () => "unreachable",
      ),
    ).toEqual({ status: "failed", error: failure });
    expect(state.getState()).toMatchObject({
      draft: { displayName: "Retry me" },
      secret: { status: "hidden", secret: null },
      mutationError: failure,
    });
  });

  test("a confirmed destructive mutation clears detail and fences an old read", async () => {
    const state = createSettingsDataState<{ name: string }, null>();
    const oldRead = deferred<{ name: string }>();
    const deletion = deferred<void>();
    state.setScope(viewerOne);
    const reading = state.load(async () => oldRead.promise);
    const deleting = state.mutateAndClear(async () => deletion.promise);

    oldRead.resolve({ name: "deleted-skill" });
    deletion.resolve();

    expect(await reading).toEqual({ status: "ignored" });
    expect(await deleting).toEqual({ status: "applied" });
    expect(state.getState()).toMatchObject({ data: null, draft: null, loading: false, mutating: false });
  });
});
