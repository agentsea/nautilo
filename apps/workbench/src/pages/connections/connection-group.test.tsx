import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { WORKBENCH_APPLICATION_TARGETS } from "../../lib/genie-application-targets";
import { ConnectionGroup } from "./connection-group";
import { CONNECTIONS_CATALOGUE_TARGETS, CONNECTIONS_SECTIONS, connectionSectionForHash, isConnectionCardVisible } from "./connections-sections";

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  localStorage.clear();
});

describe("ConnectionGroup", () => {
  test("keeps category headings and their cards visible as a stable destination", () => {
    const view = render(
      <ConnectionGroup
        id="test-connections"
        title="Agent harnesses"
        description="Local agent runtimes."
        summary="2 harnesses"
        actions={<button type="button">Collapse</button>}
      >
        <div>Hermes via ACP</div>
      </ConnectionGroup>,
    );

    expect(view.getByRole("heading", { name: "Agent harnesses" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Collapse" })).toBeTruthy();
    expect(view.getByText("Hermes via ACP")).toBeTruthy();
    expect(view.container.querySelector("#test-connections")?.getAttribute("tabindex")).toBe("-1");
  });

  test("uses the canonical registry for locked order and legacy card hashes", () => {
    expect(CONNECTIONS_SECTIONS.map((section) => section.id)).toEqual([
      "agent-harnesses",
      "apps-and-accounts",
      "websites",
      "this-mac",
      "mcp-servers",
    ]);
    expect(connectionSectionForHash("#websites")).toBe("websites");
    expect(connectionSectionForHash("#computer-use")).toBe("this-mac");
    expect(connectionSectionForHash("#system-permissions")).toBeNull();
    const computerUseSection = CONNECTIONS_SECTIONS.find((section) => section.id === "this-mac");
    expect(computerUseSection).toMatchObject({
      label: "Computer Use",
      description: "Computer Use authority and local developer tools for this Mac.",
    });
    expect(computerUseSection?.cards[0]?.id).toBe("computer-use");
    expect(connectionSectionForHash("#google")).toBe("apps-and-accounts");
    expect(connectionSectionForHash("#claude")).toBe("agent-harnesses");
    expect(CONNECTIONS_SECTIONS.find((section) => section.id === "agent-harnesses")?.cards.map((card) => card.id)).toEqual([
      "codex",
      "claude",
      "hermes-acp",
    ]);
    expect(connectionSectionForHash("#local-mcp")).toBe("mcp-servers");
    expect(connectionSectionForHash("#opencode-acp")).toBeNull();
    expect(connectionSectionForHash("#not-a-connection")).toBeNull();
    expect(CONNECTIONS_SECTIONS.flatMap((section) => section.cards).some((card) => card.id === ("opencode-acp" as never))).toBeFalse();
    expect(isConnectionCardVisible("computer-use", false)).toBeFalse();
    expect(isConnectionCardVisible("computer-use", true)).toBeTrue();
    for (const [target, cardId] of Object.entries(CONNECTIONS_CATALOGUE_TARGETS)) {
      expect(WORKBENCH_APPLICATION_TARGETS[target as keyof typeof WORKBENCH_APPLICATION_TARGETS].presentation.focusAnchorId).toBe(cardId);
    }
  });
});
