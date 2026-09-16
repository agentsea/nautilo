import { describe, expect, mock, test } from "bun:test";
import {
  createRoomFindActivationController,
  type RoomFindActivationRequest,
  type RoomFindActivationState,
} from "../../src/components/rooms/room-transcript-find-activation";

const request: RoomFindActivationRequest = { roomId: "room-a", generation: 4, messageId: "42" };

describe("D430 Room find activation", () => {
  test("connects each ready selection to the canonical jump exactly once for loaded and hydrated outcomes", async () => {
    const jump = mock(async () => ({ status: "completed" as const, loaded: true }));
    const states: RoomFindActivationState[] = [];
    const controller = createRoomFindActivationController({ jumpToMessage: jump, isCurrent: () => true, onState: (state) => states.push(state) });
    await controller.activate(request);
    await controller.activate(request);
    await controller.activate({ ...request, messageId: "43" });

    expect(jump).toHaveBeenCalledTimes(2);
    expect(jump).toHaveBeenNthCalledWith(1, 42, { focusTarget: false });
    expect(jump).toHaveBeenNthCalledWith(2, 43, { focusTarget: false });
    expect(states).toEqual([
      { state: "hydrating", messageId: 42 }, { state: "idle" },
      { state: "hydrating", messageId: 43 }, { state: "idle" },
    ]);
  });

  test("does not duplicate a pending canonical hydration and exposes failed retry", async () => {
    let resolve!: (value: { status: "failed" }) => void;
    let calls = 0;
    const jump = mock(() => {
      calls += 1;
      return calls === 1
        ? new Promise<{ status: "failed" }>((done) => { resolve = done; })
        : Promise.resolve({ status: "completed" as const, loaded: false });
    });
    const states: RoomFindActivationState[] = [];
    const controller = createRoomFindActivationController({ jumpToMessage: jump, isCurrent: () => true, onState: (state) => states.push(state) });
    const first = controller.activate(request);
    const duplicate = controller.activate(request);
    expect(jump).toHaveBeenCalledTimes(1);
    resolve({ status: "failed" });
    await Promise.all([first, duplicate]);
    expect(states.at(-1)).toEqual({ state: "failed", messageId: 42 });

    await controller.retry(request);
    expect(jump).toHaveBeenCalledTimes(2);
  });

  test("drops stale query or Room completions without replacing current UI state", async () => {
    let current = true;
    let resolve!: (value: { status: "completed"; loaded: false }) => void;
    const jump = mock(() => new Promise<{ status: "completed"; loaded: false }>((done) => { resolve = done; }));
    const states: RoomFindActivationState[] = [];
    const controller = createRoomFindActivationController({ jumpToMessage: jump, isCurrent: () => current, onState: (state) => states.push(state) });
    const pending = controller.activate(request);
    current = false;
    resolve({ status: "completed", loaded: false });
    await pending;

    expect(states).toEqual([{ state: "hydrating", messageId: 42 }]);
  });
});
