import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ServerEvent } from "@nautilo/types";
import { useRoomJobActivity } from "./use-room-job-activity";

const browser = new Window();
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let scopeKey: string | null;
let roomId: string;
let active: boolean;
let recoveryRevision: number;
let current: ReadonlySet<string>;
const handlers = new Set<(event: ServerEvent) => void>();
const requests: { resolve(value: { jobIds: string[] }): void; reject(error: Error): void }[] = [];
const subscribe = (handler: (event: ServerEvent) => void) => {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
};
const getActiveJobs = () => new Promise<{ jobIds: string[] }>((resolve, reject) => {
  requests.push({ resolve, reject });
});
function Harness() {
  current = useRoomJobActivity({ scopeKey, roomId, active, recoveryRevision, subscribe, getActiveJobs });
  return null;
}
async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = async () => { await act(async () => root.render(createElement(Harness))); };
  await render();
  return { render, close: async () => { await act(async () => root.unmount()); } };
}
const emit = async (event: ServerEvent) => {
  await act(async () => { for (const handler of handlers) handler(event); });
};
const dispatch = (jobId: string, room = "room-a"): ServerEvent => ({
  type: "job.dispatched", jobId, laneKey: `room:${room}`, virtualJobIds: [],
});
const terminal = (jobId: string): ServerEvent => ({
  type: "job.status", jobId, laneKey: "room:room-a", status: "completed",
});
async function respond(index: number, jobIds: string[]) {
  await act(async () => requests[index].resolve({ jobIds }));
}
beforeEach(() => {
  scopeKey = "server-a:viewer-a:room-a"; roomId = "room-a";
  active = true; recoveryRevision = 0; handlers.clear(); requests.length = 0;
});

test("reconnect clears a finished reply whose terminal event was missed", async () => {
  const ui = await mount();
  try {
    await respond(0, []);
    await emit(dispatch("finished-job"));
    expect(current.size).toBe(1);
    // The persisted reply arrived, but the socket dropped its job.status.
    recoveryRevision++;
    await ui.render();
    await respond(1, []);
    expect(current.size).toBe(0);
  } finally { await ui.close(); }
});

test("foreground recovery retains real work and discovers jobs started while away", async () => {
  const ui = await mount();
  try {
    await respond(0, ["running-job"]);
    active = false; await ui.render();
    expect(requests).toHaveLength(1);
    expect([...current]).toEqual(["running-job"]);
    active = true; await ui.render();
    await respond(1, ["running-job", "new-job"]);
    expect([...current]).toEqual(["running-job", "new-job"]);
    await emit(terminal("running-job"));
    await emit(terminal("new-job"));
    expect(current.size).toBe(0);
  } finally { await ui.close(); }
});

test("live events override a delayed HTTP snapshot", async () => {
  const ui = await mount();
  try {
    await emit(dispatch("finished-job"));
    await emit(terminal("finished-job"));
    await emit(dispatch("new-job"));
    await emit(dispatch("other-room-job", "room-b"));
    await respond(0, ["finished-job"]);
    expect([...current]).toEqual(["new-job"]);
  } finally { await ui.close(); }
});

test("old Room or server responses cannot change the replacement scope", async () => {
  const ui = await mount();
  try {
    await emit(dispatch("old-job"));
    scopeKey = "server-b:viewer-b:room-b"; roomId = "room-b";
    await ui.render();
    expect(current.size).toBe(0);
    await respond(1, ["replacement-job"]);
    await respond(0, ["old-job"]);
    expect([...current]).toEqual(["replacement-job"]);
    scopeKey = "server-a:viewer-a:room-a"; roomId = "room-a";
    await ui.render();
    await respond(2, []);
    expect(current.size).toBe(0);
  } finally { await ui.close(); }
});

test("failed recovery preserves known work and a later recovery can settle it", async () => {
  const ui = await mount();
  try {
    await emit(dispatch("known-job"));
    await act(async () => requests[0].reject(new Error("offline")));
    expect([...current]).toEqual(["known-job"]);
    recoveryRevision++; await ui.render();
    await respond(1, []);
    expect(current.size).toBe(0);
  } finally { await ui.close(); }
});

test("unverified identity makes no request and cannot retain the former working state", async () => {
  const ui = await mount();
  try {
    await emit(dispatch("old-job"));
    scopeKey = null; await ui.render();
    await respond(0, ["old-job"]);
    expect(requests).toHaveLength(1);
    expect(current.size).toBe(0);
    expect(handlers.size).toBe(0);
  } finally { await ui.close(); }
});

test("a superseded recovery response cannot resurrect jobs in the same Room", async () => {
  const ui = await mount();
  try {
    recoveryRevision++; await ui.render();
    await respond(1, []);
    await respond(0, ["finished-job"]);
    expect(current.size).toBe(0);
  } finally { await ui.close(); }
});

test("every terminal status settles work, including an older unscoped terminal event", async () => {
  const ui = await mount();
  try {
    await respond(0, []);
    for (const status of ["completed", "failed", "timed_out", "cancelled"] as const) {
      await emit(dispatch("job"));
      await emit({ type: "job.status", jobId: "job", status });
      expect(current.size).toBe(0);
    }
    await emit({ type: "job.status", jobId: "unscoped", status: "running" });
    expect(current.size).toBe(0);
  } finally { await ui.close(); }
});
