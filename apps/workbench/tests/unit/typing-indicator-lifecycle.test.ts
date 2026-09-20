import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../");
const runtimeSource = readFileSync(
  join(repoRoot, "src/adapters/nautilo-runtime.tsx"),
  "utf8",
);
const presenceStripSource = readFileSync(
  join(repoRoot, "src/modes/rooms/typing/PresenceTypingStrip.tsx"),
  "utf8",
);

function sliceCaseBlock(caseLabel: string, nextCaseLabel: string): string {
  const start = runtimeSource.indexOf(`case ${caseLabel}:`);
  const end = runtimeSource.indexOf(`case ${nextCaseLabel}:`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return runtimeSource.slice(start, end);
}

describe("Typing indicator lifecycle (nautilo-runtime source audit)", () => {
  test("PresenceTypingStrip reads Nautilo WS-owned isRunning, not assistant-ui run state", () => {
    expect(presenceStripSource).toMatch(/useVoiceControls/);
    expect(presenceStripSource).not.toMatch(/useThread/);
  });

  test("does not clear isRunning on message.tokens done", () => {
    const tokensCase = sliceCaseBlock('"message.tokens"', '"message.new"');
    expect(tokensCase).not.toMatch(/setIsRunning\(false\)/);
    expect(tokensCase).toMatch(/clearAgentStreamingVisibleOutput\(\)/);
    expect(tokensCase).toMatch(/isRunning tracks live job lifetime/);
  });

  test("visible token chunks hide the strip only for a quiet window", () => {
    expect(runtimeSource).toMatch(/const VISIBLE_OUTPUT_QUIET_MS = 900/);
    expect(runtimeSource).toMatch(/markAgentStreamingVisibleOutputActive/);
    expect(runtimeSource).toMatch(/setTimeout\(\(\) => \{[\s\S]*?setAgentStreamingVisibleOutput\(false\)/);
    const tokensCase = sliceCaseBlock('"message.tokens"', '"message.new"');
    expect(tokensCase).toMatch(/markAgentStreamingVisibleOutputActive\(\)/);
  });

  test("message.tokens done has a lane+author fallback for turnId drift", () => {
    const tokensCase = sliceCaseBlock('"message.tokens"', '"message.new"');
    expect(tokensCase).toMatch(/laneAuthorStreamLookupKey\(event\)/);
    expect(tokensCase).toMatch(/streamKeyByLaneAuthorRef\.current\.get/);
  });

  test("tool.start resyncs visible streaming state before the tool-prep gap continues", () => {
    const toolStartCase = sliceCaseBlock('"tool.start"', '"tool.end"');
    expect(toolStartCase).toMatch(/clearAgentStreamingVisibleOutput\(\)/);
    expect(toolStartCase).not.toMatch(/setIsRunning\(false\)/);
  });

  test("does not clear isRunning on assistant message.new reconciliation", () => {
    const messageNewCase = sliceCaseBlock('"message.new"', '"tool.start"');
    const aiAssistantBlock = messageNewCase.slice(
      0,
      messageNewCase.indexOf('event.role === "user"'),
    );
    expect(aiAssistantBlock).not.toMatch(/setIsRunning\(false\)/);
    expect(aiAssistantBlock).toMatch(/reconcile id only/);
  });

  test("still clears isRunning on terminal job.status completed", () => {
    expect(runtimeSource).toMatch(
      /event\.status === "completed"[\s\S]*?setIsRunning\(hasLiveJobForActiveRoom\(\)\)/,
    );
  });

  test("still clears isRunning on terminal job.status timed_out", () => {
    expect(runtimeSource).toMatch(
      /event\.status === "completed" \|\| event\.status === "timed_out"[\s\S]*?setIsRunning\(hasLiveJobForActiveRoom\(\)\)/,
    );
  });

  test("still clears isRunning on stopActiveJobs", () => {
    expect(runtimeSource).toMatch(
      /stopActiveJobs[\s\S]*?setIsRunning\(false\)/,
    );
  });
});
