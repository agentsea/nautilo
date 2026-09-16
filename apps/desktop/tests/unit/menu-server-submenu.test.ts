import { describe, expect, test } from "bun:test";
import { buildServerSubmenu } from "../../electron/menu-server-template";

describe("native Server submenu", () => {
  test("keeps server switching available without a Workbench renderer", () => {
    let switchCount = 0;
    const items = buildServerSubmenu(() => {
      switchCount += 1;
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("Switch Server…");
    expect(items[0]?.accelerator).toBe("CmdOrCtrl+Shift+S");
    items[0]?.click();
    expect(switchCount).toBe(1);
  });
});
