import { describe, expect, mock, test } from "bun:test";

import { openMobileSubthread } from "./mobile-thread-api";

describe("openMobileSubthread", () => {
  test("opens an existing canonical child without creating another", async () => {
    const listSubthreads = mock(async () => ({
      subthreads: [{
        id: "child-existing",
        parentRoomId: "parent",
        anchorMessageId: 42,
        label: "Thread",
        replyCount: 1,
        lastReplyAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      }],
    }));
    const createSubthread = mock(async () => ({ subthreadRoomId: "child-new" }));

    const result = await openMobileSubthread(
      { listSubthreads, createSubthread },
      "parent",
      42,
    );
    expect(result).toBe("child-existing");
    expect(createSubthread).not.toHaveBeenCalled();
  });

  test("creates the canonical child when the anchor has none", async () => {
    const listSubthreads = mock(async () => ({ subthreads: [] }));
    const createSubthread = mock(async () => ({ subthreadRoomId: "child-new" }));

    const result = await openMobileSubthread(
      { listSubthreads, createSubthread },
      "parent",
      42,
    );
    expect(result).toBe("child-new");
    expect(createSubthread).toHaveBeenCalledWith("parent", 42);
  });
});
