import { expect, test } from "bun:test";
import { bubbleInteraction } from "../../src/companion/companion-bubble-interaction";
import { emptyCompanionSnapshot } from "../../../desktop/electron/companion-contract";
const idle = emptyCompanionSnapshot({ roomId: "room", agentId: "genie", botActorId: "bot", name: "Genie" });
test("bubble primary action follows turn state, independently of work and speaker mute", () => {
  expect(bubbleInteraction(idle)).toMatchObject({ label: "Tap to talk", disabled: false, cue: "mic" });
  expect(bubbleInteraction({ ...idle, capture: "listening" })).toMatchObject({ disabled: false, cue: "send" });
  for (const state of [{ capture: "requesting" as const }, { capture: "transcribing" as const }, { busy: true }]) {
    expect(bubbleInteraction({ ...idle, ...state })).toMatchObject({ disabled: true, cue: "pending" });
  }
  expect(bubbleInteraction({ ...idle, workRunning: true, voiceEnabled: false } as typeof idle).disabled).toBe(false);
  expect(bubbleInteraction({ ...idle, canStopTalking: true }).label).toBe("Interrupt and talk");
  expect(bubbleInteraction({ ...idle, sendUncertain: true })).toMatchObject({ disabled: true, cue: "error" });
});
