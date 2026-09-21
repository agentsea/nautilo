import { describe, expect, mock, test } from "bun:test";
import {
  ownsSubmittedComposerPresentation,
  sendIfComposerPresentationCurrent,
} from "../../src/components/composer/composer-send-ownership";

describe("composer send presentation ownership", () => {
  test("does not send room A's captured draft after the presentation switches to room B", async () => {
    let activeRoomId: string | null = "room-a";
    const send = mock(async () => true);

    activeRoomId = "room-b";
    const sent = await sendIfComposerPresentationCurrent({
      isMounted: () => true,
      getActiveRoomId: () => activeRoomId,
      submittedRoomId: "room-a",
      send,
    });

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  test("sends only while the mounted presentation still owns the submitted room", async () => {
    const send = mock(async () => true);
    expect(await sendIfComposerPresentationCurrent({
      isMounted: () => true,
      getActiveRoomId: () => "room-a",
      submittedRoomId: "room-a",
      send,
    })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ownsSubmittedComposerPresentation({
      mounted: false,
      activeRoomId: "room-a",
      submittedRoomId: "room-a",
    })).toBe(false);
  });
});
