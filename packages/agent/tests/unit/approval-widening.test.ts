import { describe, expect, test, beforeEach } from "bun:test";
import type { ToolCall } from "@langchain/core/messages/tool";

import {
  approvedNetworkAllowRulesForLane,
  approvedWritablePathsForLane,
  clearApprovedWritablePathsForTests,
  extractApprovedWritablePath,
  recordApprovedNetworkAllowRule,
  recordApprovedWritablePath,
} from "../../src/nodes/approval-widening";

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { name, args, id: `id-${name}`, type: "tool_call" };
}

describe("approval-widening path extraction (D099)", () => {
  beforeEach(() => clearApprovedWritablePathsForTests());

  test("file.write absolute/current/workspace zones resolve to the right root", () => {
    expect(
      extractApprovedWritablePath(
        tc("file", { command: "write", zone: "absolute", path: "/tmp/a.md" }),
        {},
      ),
    ).toBe("/tmp");
    expect(
      extractApprovedWritablePath(
        tc("file", { command: "write", zone: "current", path: "a.md" }),
        { currentFolder: "/Users/tester/Current" },
      ),
    ).toBe("/Users/tester/Current");
    expect(
      extractApprovedWritablePath(
        tc("file", { command: "write", zone: "workspace", path: "a.md" }),
        { workspacePath: "/Users/tester/Nautilo" },
      ),
    ).toBe("/Users/tester/Nautilo");
  });

  test("read-only file commands and run_shell do not widen sandbox paths", () => {
    expect(
      extractApprovedWritablePath(
        tc("file", { command: "read", zone: "absolute", path: "/tmp/a.md" }),
        {},
      ),
    ).toBeNull();
    expect(
      extractApprovedWritablePath(
        tc("run_shell", { command: "touch /tmp/a.md" }),
        {},
      ),
    ).toBeNull();
  });

  test("file.move widens destination path, not source path", () => {
    expect(
      extractApprovedWritablePath(
        tc("file", {
          command: "move",
          zone: "workspace",
          path: "source/a.md",
          destinationPath: "dest/a.md",
        }),
        { workspacePath: "/Users/tester/Nautilo" },
      ),
    ).toBe("/Users/tester/Nautilo/dest");
  });

  test("file.copy resolves destinationZone when it differs from source zone", () => {
    expect(
      extractApprovedWritablePath(
        tc("file", {
          command: "copy",
          zone: "workspace",
          path: "source/a.md",
          destinationZone: "current",
          destinationPath: "out/a.md",
        }),
        {
          workspacePath: "/Users/tester/Nautilo",
          currentFolder: "/Users/tester/Current",
        },
      ),
    ).toBe("/Users/tester/Current/out");

    expect(
      extractApprovedWritablePath(
        tc("file", {
          command: "copy",
          zone: "current",
          path: "source/a.md",
          destinationZone: "absolute",
          destinationPath: "/tmp/copied/a.md",
        }),
        {
          workspacePath: "/Users/tester/Nautilo",
          currentFolder: "/Users/tester/Current",
        },
      ),
    ).toBe("/tmp/copied");
  });

  test("file.copy scratch destination widens under the workspace scratch root", () => {
    expect(
      extractApprovedWritablePath(
        tc("file", {
          command: "copy",
          zone: "workspace",
          path: "source/a.md",
          destinationZone: "scratch",
          destinationPath: "exports/a.md",
        }),
        { workspacePath: "/Users/tester/Nautilo" },
      ),
    ).toBe("/Users/tester/Nautilo/scratch/exports");
  });

  test("per-lane writable path store is idempotent and sorted", () => {
    recordApprovedWritablePath("lane", "/b");
    recordApprovedWritablePath("lane", "/a");
    recordApprovedWritablePath("lane", "/b");
    expect(approvedWritablePathsForLane("lane")).toEqual(["/a", "/b"]);
  });

  test("per-lane network allow store is idempotent and sorted", () => {
    recordApprovedNetworkAllowRule("lane", {
      type: "domain",
      host: "api.openai.com",
      ports: [443],
    });
    recordApprovedNetworkAllowRule("lane", {
      type: "domain",
      host: "api.openai.com",
      ports: [443],
    });
    recordApprovedNetworkAllowRule("lane", {
      type: "wildcard",
      suffix: "github.com",
      ports: [443],
    });

    expect(approvedNetworkAllowRulesForLane("lane")).toEqual([
      { type: "domain", host: "api.openai.com", ports: [443] },
      { type: "wildcard", suffix: "github.com", ports: [443] },
    ]);
  });
});
