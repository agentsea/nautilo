import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../");
const runtimeSource = readFileSync(
  join(repoRoot, "src/adapters/nautilo-runtime.tsx"),
  "utf8",
);

function sliceBetween(startNeedle: string, endNeedle: string): string {
  const start = runtimeSource.indexOf(startNeedle);
  const end = runtimeSource.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return runtimeSource.slice(start, end);
}

describe("D341 stop button virtual job bridge", () => {
  test("coalesced sends store virtual ids separately from real job ids", () => {
    const sendMappingBlock = sliceBetween(
      "if (rid && pending.jobId && pending.coalesced)",
      "} else if (import.meta.env.DEV)",
    );
    const coalescedBranch = sendMappingBlock.slice(
      0,
      sendMappingBlock.indexOf("} else if (rid && pending.jobId)"),
    );

    expect(coalescedBranch).toMatch(/virtualJobIdToRoomIdRef\.current\.set\(pending\.jobId, rid\)/);
    expect(coalescedBranch).not.toMatch(/jobIdToRoomIdRef\.current\.set\(pending\.jobId, rid\)/);
  });

  test("stopActiveJobs calls room-scoped stop and arms room intent", () => {
    const stopBlock = sliceBetween(
      "const stopActiveJobs = useCallback(() => {",
      "const voiceControls: VoiceControls = {",
    );

    expect(stopBlock).toMatch(/apiClient\.stopRoom\(activeRoom\)/);
    expect(stopBlock).toMatch(/pendingStopRoomIdsRef\.current\.add\(activeRoom\)/);
    expect(stopBlock).toMatch(/if \(stopKnownJobIds\(ids\)\) return/);
    const roomStopBranch = stopBlock.slice(
      stopBlock.indexOf("if (activeRoom)"),
      stopBlock.indexOf("if (stopKnownJobIds(ids)) return"),
    );
    expect(roomStopBranch).not.toMatch(/liveJobIdsRef\.current\.delete/);
    expect(roomStopBranch).not.toMatch(/setIsRunning\(false\)/);
  });

  test("job.dispatched consumes pending virtual stop and stops the real job id", () => {
    const dispatchedBlock = sliceBetween(
      'case "job.dispatched": {',
      'case "job.coalesced":',
    );

    expect(dispatchedBlock).toMatch(/for \(const virtualJobId of event\.virtualJobIds\)/);
    expect(dispatchedBlock).toMatch(/virtualJobIdToRoomIdRef\.current\.set\(virtualJobId, rid\)/);
    expect(dispatchedBlock).toMatch(/pendingStopRoomIdsRef\.current\.has\(rid\)/);
    expect(dispatchedBlock).toMatch(/pendingStopVirtualJobIdsRef\.current\.has\(id\)/);
    expect(dispatchedBlock).toMatch(/stopKnownJobIds\(\[event\.jobId\]\)/);
  });
});
