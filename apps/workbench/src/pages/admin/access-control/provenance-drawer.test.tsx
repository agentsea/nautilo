import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { ProvenanceDrawer } from "./provenance-drawer";

const access = {
  user: { id: "ada", handle: "ada", displayName: "Ada", server: null },
  highestRole: "member",
  capabilities: [{
    slug: "use_workstation_profiles",
    description: "Use profiles",
    category: "workstation",
    granted: true,
    provenance: [{
      groupId: "members",
      groupType: "members",
      groupLabel: "members",
      groupIsSystem: true,
      groupOwnerId: null,
      roleSlug: "member",
      roleLabel: "Member",
      roleIsSystem: true,
    }],
  }],
  groups: [],
  roles: [],
  groupRoleFacts: [],
} as const;

afterEach(() => cleanup());

describe("ProvenanceDrawer", () => {
  test("closes on Escape and restores the trigger focus", () => {
    reapplyHappyDomGlobals();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    let closed = false;
    const view = render(<ProvenanceDrawer access={access} onClose={() => { closed = true; }} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(closed).toBe(true);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
