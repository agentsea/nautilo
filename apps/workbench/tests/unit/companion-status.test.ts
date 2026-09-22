import { expect, test } from "bun:test";
import { companionStatus } from "../../src/companion/companion-status";
import { emptyCompanionSnapshot } from "../../../desktop/electron/companion-contract";

const snapshot = emptyCompanionSnapshot({ roomId: "example-room", agentId: "example-agent", botActorId: "example-bot", name: "Genie" });

test("an unacknowledged send is never labelled as running or delivered work", () => {
  expect(companionStatus({ ...snapshot, busy: true })).toBe("Sending…");
  expect(companionStatus({ ...snapshot, busy: true, workRunning: true })).toBe("Sending…");
  expect(companionStatus({ ...snapshot, busy: false, workRunning: true })).toBe("Working · microphone off");
});

test("speech does not mask pending sends, running work or cancellation", () => {
  expect(companionStatus({ ...snapshot, speaking: true, busy: true })).toBe("Sending · speaking");
  expect(companionStatus({ ...snapshot, speaking: true, workRunning: true })).toBe("Speaking · action running");
  expect(companionStatus({ ...snapshot, speaking: true, workRunning: true, stopState: "stopping" })).toBe("Stopping action · speaking");
});

test("transcription does not claim that the message has been sent", () => {
  expect(companionStatus({ ...snapshot, capture: "transcribing" })).toBe("Transcribing…");
});
