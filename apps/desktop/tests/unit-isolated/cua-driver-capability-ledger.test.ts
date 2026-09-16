import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PINNED_CUA_MACOS_TOOL_COUNT,
  generateCapabilityLedger,
  parseLiveListTools,
  validateCapabilityLedger,
  type CuaCapabilityLedger,
} from "../../scripts/generate-cua-capability-ledger.ts";

const CAPTURED_LIVE_LIST_TOOLS = readFileSync(
  new URL("../../cua-driver/pinned-list-tools.txt", import.meta.url),
  "utf8",
);

function loadLedger(): CuaCapabilityLedger {
  return JSON.parse(
    readFileSync(new URL("../../cua-driver/capability-ledger.json", import.meta.url), "utf8"),
  ) as CuaCapabilityLedger;
}

describe("D516 pinned live Cua macOS capability ledger", () => {
  test("contains exactly all 56 captured live tools with reviewed alternatives", () => {
    const live = parseLiveListTools(CAPTURED_LIVE_LIST_TOOLS);
    const ledger = validateCapabilityLedger(loadLedger(), live);
    expect(live).toHaveLength(PINNED_CUA_MACOS_TOOL_COUNT);
    expect(ledger.tools).toHaveLength(56);
    for (const required of [
      "get_desktop_state",
      "get_window_state",
      "browser_set_input_files",
      "replay_trajectory",
      "install_ffmpeg",
      "verify_state",
    ]) {
      expect(ledger.tools.some((tool) => tool.name === required)).toBe(true);
    }
    expect(ledger.tools.every((tool) => tool.rationale.trim() && tool.alternative.trim())).toBe(true);
  });

  test("parses machine list-tools JSON without using the portable contract manifest", () => {
    expect(parseLiveListTools(JSON.stringify({ tools: [{ name: "zoom" }, { name: "click" }] })))
      .toEqual(["click", "zoom"]);
  });

  test("rejects duplicate live tools and any added or removed live capability", () => {
    expect(() => parseLiveListTools("click\nclick\n")).toThrow(/duplicate tool click/);
    const live = parseLiveListTools(CAPTURED_LIVE_LIST_TOOLS);
    expect(() => validateCapabilityLedger(loadLedger(), [...live.slice(1), "new_upstream_tool"]))
      .toThrow(/Cua capability drift.*new_upstream_tool.*bring_to_front/);
  });

  test("rejects silent ledger omissions and unreviewed dispositions", () => {
    const missing = structuredClone(loadLedger());
    missing.tools = missing.tools.slice(1);
    missing.toolCount = missing.tools.length;
    expect(() => validateCapabilityLedger(missing)).toThrow(/exactly 56 tools/);

    const unreviewed = structuredClone(loadLedger()) as unknown as { tools: Array<Record<string, unknown>> };
    unreviewed.tools[0]!.disposition = "unreviewed";
    expect(() => validateCapabilityLedger(unreviewed)).toThrow(/unreviewed disposition/);
  });

  test("generator refuses to manufacture a disposition for a newly discovered tool", () => {
    const ledger = loadLedger();
    expect(() => generateCapabilityLedger(
      [...ledger.tools.map((tool) => tool.name), "new_upstream_tool"],
      ledger.tools,
      ledger.driver,
    )).toThrow(/new_upstream_tool has no reviewed disposition/);
  });
});
