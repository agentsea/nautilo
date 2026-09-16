import { describe, expect, test } from "bun:test";
import { derivedCitedArtifactIds } from "../../src/components/browser-column/cited-paths";
import type { ToolActivityEvent } from "../../src/adapters/runtime-contexts";

function ev(partial: Partial<ToolActivityEvent> & Pick<ToolActivityEvent, "toolCallId" | "toolName">): ToolActivityEvent {
  return {
    args: {},
    status: "ok",
    startedAt: 0,
    ...partial,
  };
}

describe("derivedCitedArtifactIds", () => {
  test("empty events yields empty set", () => {
    expect([...derivedCitedArtifactIds([])]).toEqual([]);
  });

  test("parses artifactId from result JSON", () => {
    const set = derivedCitedArtifactIds([
      ev({
        toolCallId: "1",
        toolName: "file",
        result: JSON.stringify({ artifactId: "a1", path: "x" }),
      }),
    ]);
    expect(set.has("a1")).toBe(true);
  });

  test("collects artifact_id nested key", () => {
    const set = derivedCitedArtifactIds([
      ev({
        toolCallId: "2",
        toolName: "x",
        result: JSON.stringify({ nested: { artifact_id: "a2" } }),
      }),
    ]);
    expect(set.has("a2")).toBe(true);
  });

  test("reads args.artifactId", () => {
    const set = derivedCitedArtifactIds([
      ev({
        toolCallId: "3",
        toolName: "y",
        args: { artifactId: "a3" },
      }),
    ]);
    expect(set.has("a3")).toBe(true);
  });

  test("accumulates across events", () => {
    const set = derivedCitedArtifactIds([
      ev({ toolCallId: "1", toolName: "t", args: { artifactId: "u1" } }),
      ev({ toolCallId: "2", toolName: "t", result: JSON.stringify({ artifactId: "u2" }) }),
    ]);
    expect([...set].sort()).toEqual(["u1", "u2"]);
  });

  test("malformed JSON in result does not throw", () => {
    const set = derivedCitedArtifactIds([
      ev({ toolCallId: "1", toolName: "t", result: "{not-json" }),
    ]);
    expect(set.size).toBe(0);
  });

  test("file list result does not cite every enumerated artifact", () => {
    const listResult = JSON.stringify({
      entries: [
        { artifactId: "a1", path: "artifacts/one.html" },
        { artifactId: "a2", path: "artifacts/two.html" },
        { artifactId: "a3", path: "artifacts/three.html" },
      ],
    });
    const set = derivedCitedArtifactIds([
      ev({ toolCallId: "1", toolName: "file", args: { command: "list" }, result: listResult }),
    ]);
    expect(set.size).toBe(0);
  });

  test("grep enumeration result is also skipped", () => {
    const set = derivedCitedArtifactIds([
      ev({
        toolCallId: "1",
        toolName: "file",
        args: { command: "grep" },
        result: JSON.stringify({ matches: [{ artifactId: "g1" }, { artifactId: "g2" }] }),
      }),
    ]);
    expect(set.size).toBe(0);
  });

  test("a real write still cites its own artifact", () => {
    const set = derivedCitedArtifactIds([
      ev({
        toolCallId: "1",
        toolName: "file",
        args: { command: "write", path: "artifacts/report.html" },
        result: JSON.stringify({ artifactId: "w1", path: "artifacts/report.html" }),
      }),
    ]);
    expect(set.has("w1")).toBe(true);
  });

  test("explicit artifactId in args is still cited even for a list command", () => {
    const set = derivedCitedArtifactIds([
      ev({
        toolCallId: "1",
        toolName: "file",
        args: { command: "list", artifactId: "explicit" },
        result: JSON.stringify({ entries: [{ artifactId: "bulk" }] }),
      }),
    ]);
    expect(set.has("explicit")).toBe(true);
    expect(set.has("bulk")).toBe(false);
  });
});
