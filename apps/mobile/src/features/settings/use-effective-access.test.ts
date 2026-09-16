/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { createSettingsDataState, type SettingsDataScope } from "@/features/settings/settings-data-state";
import { effectiveAccessFailure } from "./access-presentation";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("effective access request outcomes", () => {
  test("treats a 401 as signed out", () => {
    const expired = Object.assign(new Error("Authentication required"), { status: 401 });
    expect(effectiveAccessFailure(expired, "server-a", "user-a")).toEqual({
      kind: "signed-out",
      serverId: "server-a",
      viewerId: "user-a",
    });
  });

  test("keeps a 403 as a read denial rather than exposing administration", () => {
    const denied = Object.assign(new Error("Forbidden"), { status: 403 });
    expect(effectiveAccessFailure(denied, "server-a", "user-a")).toEqual({
      kind: "forbidden",
      serverId: "server-a",
      viewerId: "user-a",
    });
  });

  test("maps a network failure to retryable failure", () => {
    expect(effectiveAccessFailure(new Error("Network request failed"), "server-a", "user-a")).toEqual({
      kind: "failed",
      serverId: "server-a",
      viewerId: "user-a",
      message: "Network request failed",
    });
  });
});

describe("shared Settings request ownership", () => {
  const scopeA: SettingsDataScope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };
  const scopeB: SettingsDataScope = { serverId: "server-b", userId: "user-b", actorId: "actor-b" };

  test("applies a retry but not its earlier completion", async () => {
    const state = createSettingsDataState<string, null>();
    state.setScope(scopeA);
    const first = state.load(async () => "old response");
    const retry = state.retryLoad(async () => "canonical retry response");

    expect(await first).toEqual({ status: "ignored" });
    expect(await retry).toEqual({ status: "applied", data: "canonical retry response" });
    expect(state.getState().data).toBe("canonical retry response");
  });

  test("drops a slow completion after a server or viewer switch", async () => {
    const state = createSettingsDataState<string, null>();
    state.setScope(scopeA);
    const oldResponse = deferred<string>();
    const slowOldRead = state.load(() => oldResponse.promise);

    state.setScope(scopeB);
    const currentRead = state.load(async () => "server-b canonical response");
    oldResponse.resolve("server-a stale response");

    expect(await slowOldRead).toEqual({ status: "ignored" });
    expect(await currentRead).toEqual({ status: "applied", data: "server-b canonical response" });
    expect(state.getState()).toMatchObject({ scope: scopeB, data: "server-b canonical response" });
  });
});
