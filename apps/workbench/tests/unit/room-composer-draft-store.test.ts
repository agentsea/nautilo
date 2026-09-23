import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import {
  createRoomComposerDraftStore,
  ROOM_COMPOSER_DRAFTS_SESSION_KEY,
  RoomComposerDraftProvider,
  type RoomComposerDraftStore,
  useRoomComposerDraftStore,
  useRoomComposerSendPending,
} from "../../src/contexts/room-composer-draft-context";

const resource = {
  entryId: "entry-1",
  label: "@README.md",
  ref: { kind: "workspace-artifact" as const, artifactId: "workspace/README.md" },
};

describe("room composer draft store", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.removeItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY);
  });

  test("keeps composition and reply together per room across presentation handoff", () => {
    const store = createRoomComposerDraftStore();
    store.saveComposition("room-a", { text: "finish this", focusedResources: [resource] });
    store.setPendingReply("room-a", {
      targetId: 42,
      senderName: "Taylor",
      snippet: "Can you take this?",
    });
    store.saveComposition("room-b", { text: "other room", focusedResources: [] });

    expect(store.get("room-a")).toEqual({
      text: "finish this",
      focusedResources: [resource],
      pendingReply: {
        targetId: 42,
        senderName: "Taylor",
        snippet: "Can you take this?",
      },
    });
    expect(store.get("room-b")?.text).toBe("other room");
  });

  test("clears only the successfully sent room", () => {
    const store = createRoomComposerDraftStore();
    store.saveComposition("room-a", { text: "sent", focusedResources: [] });
    store.saveComposition("room-b", { text: "keep me", focusedResources: [resource] });

    store.clear("room-a");

    expect(store.get("room-a")).toBeUndefined();
    expect(store.get("room-b")?.text).toBe("keep me");
    expect(store.get("room-b")?.focusedResources).toEqual([resource]);
  });

  test("keeps one send attempt per room across composer remounts", () => {
    const store = createRoomComposerDraftStore();
    const first = store.beginSend("room-a");
    expect(first).not.toBeNull();
    expect(store.beginSend("room-a")).toBeNull();
    const second = store.beginSend("room-b");
    expect(second).not.toBeNull();
    expect(store.getSendSnapshot("room-a")).toBe(first);
    expect(store.getSendSnapshot("room-b")).toBe(second);

    store.finishSend("room-a", Number(first) + 1);
    expect(store.beginSend("room-a")).toBeNull();
    store.finishSend("room-a", first!);
    expect(store.beginSend("room-a")).not.toBeNull();
    expect(store.getSendSnapshot("room-b")).toBe(second);
  });

  test("keeps pending presentation reactive across composer remounts", () => {
    let store: RoomComposerDraftStore | null = null;
    function Probe({ presentation }: { presentation: string }) {
      store = useRoomComposerDraftStore();
      const pending = useRoomComposerSendPending("room-a");
      return createElement("button", { disabled: pending }, presentation);
    }

    const view = render(createElement(
      RoomComposerDraftProvider,
      null,
      createElement(Probe, { presentation: "center" }),
    ));
    expect(view.getByRole("button", { name: "center" }).hasAttribute("disabled")).toBe(false);

    let attemptId: number | null = null;
    act(() => {
      attemptId = store!.beginSend("room-a");
    });
    expect(view.getByRole("button", { name: "center" }).hasAttribute("disabled")).toBe(true);

    view.rerender(createElement(
      RoomComposerDraftProvider,
      null,
      createElement(Probe, { key: "reader-rail", presentation: "reader rail" }),
    ));
    expect(view.getByRole("button", { name: "reader rail" }).hasAttribute("disabled")).toBe(true);

    act(() => {
      store!.finishSend("room-a", attemptId!);
    });
    expect(view.getByRole("button", { name: "reader rail" }).hasAttribute("disabled")).toBe(false);
  });

  test("rehydrates composition, focused resources, and reply after a renderer reload", () => {
    const beforeReload = createRoomComposerDraftStore();
    beforeReload.saveComposition("room-a", { text: "resume\nme", focusedResources: [resource] });
    beforeReload.setPendingReply("room-a", {
      targetId: 42,
      senderName: "Taylor",
      snippet: "Can you take this?",
    });

    expect(sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY)).toBeNull();
    expect(beforeReload.prepareForRendererReload()).toBe(true);
    expect(sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY)).not.toBeNull();

    const afterReload = createRoomComposerDraftStore();
    expect(afterReload.get("room-a")).toEqual({
      text: "resume\nme",
      focusedResources: [resource],
      pendingReply: {
        targetId: 42,
        senderName: "Taylor",
        snippet: "Can you take this?",
      },
    });
    expect(sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY)).toBeNull();
    // Sending locks are intentionally renderer-local, never durable.
    expect(afterReload.beginSend("room-a")).not.toBeNull();
  });

  test("keeps a Full draft in memory and declines plaintext renderer-reload persistence", () => {
    const store = createRoomComposerDraftStore();
    store.saveComposition("room-full", {
      text: "protected unsent draft",
      focusedResources: [resource],
    });

    expect(store.prepareForRendererReload({ plaintextPersistence: "forbidden" })).toBe(false);
    expect(sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY)).toBeNull();
    expect(store.get("room-full")?.text).toBe("protected unsent draft");
  });

  test("Full permits reload when there is no draft to preserve", () => {
    const store = createRoomComposerDraftStore();
    expect(store.prepareForRendererReload({ plaintextPersistence: "forbidden" })).toBe(true);
    expect(sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY)).toBeNull();
  });

  test("clearing a sent draft removes its durable copy", () => {
    const store = createRoomComposerDraftStore();
    store.saveComposition("room-a", { text: "sent", focusedResources: [resource] });
    expect(store.prepareForRendererReload()).toBe(true);
    store.clear("room-a");
    expect(store.prepareForRendererReload()).toBe(true);

    expect(sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY)).toBeNull();
  });

  test("drops a malformed persisted envelope as one unit", () => {
    sessionStorage.setItem(
      ROOM_COMPOSER_DRAFTS_SESSION_KEY,
      JSON.stringify({ version: 1, drafts: [{ roomId: "room-a", draft: { text: 42 } }] }),
    );

    expect(createRoomComposerDraftStore().get("room-a")).toBeUndefined();
    expect(sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY)).toBeNull();
  });
});
