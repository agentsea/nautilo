import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./task-detail-transcript.tsx", import.meta.url)).text();

test("Task transcript uses an inert virtualized native surface", () => {
  expect(source).toContain("<FlatList");
  expect(source).toContain("<MessageBubble");
  expect(source).toContain("<ToolCard");
  expect(source).toContain("taskTranscript");
  expect(source).toContain("selectableContent");
  expect(source).not.toMatch(/RoomChatPane|controller|@assistant-ui|actionSurface=/);
});

test("Task transcript is latest-run-only and honest about unavailable bytes", () => {
  expect(source).toContain("mobileTaskTranscript(detail)");
  expect(source).toContain("MOBILE_PROTECTED_TASK_DETAIL");
  expect(source).toContain("No transcript is available for this run.");
  expect(source).toContain("No runs yet.");
  expect(source).not.toMatch(/complete history|all runs|summary|source count/i);
});
