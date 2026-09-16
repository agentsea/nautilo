/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  activeCommandQuery,
  filterCommands,
  insertCommand,
} from "./command-discovery";
import { commandCatalogueScope, CommandCatalogueRequestGate } from "./command-catalogue-gate";

const commands = [
  { name: "review", description: "Review this change", enabled: true, source: "user", tokenEstimate: 1, updatedAt: "", official: false, forked: false },
  { name: "rewrite", description: "Review and rewrite selected prose", enabled: true, source: "official", tokenEstimate: 1, updatedAt: "", official: true, forked: false },
  { name: "hidden", description: "Should never appear", enabled: false, source: "user", tokenEstimate: 1, updatedAt: "", official: false, forked: false },
];

describe("mobile command discovery", () => {
  test("recognizes only a command token at a word boundary", () => {
    expect(activeCommandQuery("/rev")).toEqual({ query: "rev", start: 0 });
    expect(activeCommandQuery("Please /rev")).toEqual({ query: "rev", start: 7 });
    expect(activeCommandQuery("src/rev")).toBeNull();
    expect(activeCommandQuery("and/or")).toBeNull();
    expect(activeCommandQuery("/rev more")).toBeNull();
  });

  test("shows only enabled commands with desktop-compatible ranking", () => {
    expect(filterCommands(commands, "review").map((command) => command.name)).toEqual([
      "review",
      "rewrite",
    ]);
    expect(filterCommands(commands, "").map((command) => command.name)).toEqual([
      "review",
      "rewrite",
    ]);
  });

  test("selection inserts plain slash text without local execution", () => {
    expect(insertCommand("Please /rev", commands[0])).toBe("Please /review ");
  });

  test("a server switch fences a stale catalogue completion", () => {
    const gate = new CommandCatalogueRequestGate();
    const oldServerRequest = gate.begin();
    const newServerRequest = gate.begin();

    expect(gate.isCurrent(oldServerRequest)).toBeFalse();
    expect(gate.isCurrent(newServerRequest)).toBeTrue();
  });

  test("catalogue authority includes the verified Human, not only the server URL", () => {
    expect(commandCatalogueScope("https://nautilo.example", {
      status: "signed-in",
      viewerState: "verified",
      viewer: { userId: "human-a", actorId: "actor-a" },
    })).toBe("https://nautilo.example\u0000human-a\u0000actor-a");
    expect(commandCatalogueScope("https://nautilo.example", {
      status: "signed-in",
      viewerState: "cached",
      viewer: { userId: "human-a", actorId: "actor-a" },
    })).toBeNull();
  });
});
