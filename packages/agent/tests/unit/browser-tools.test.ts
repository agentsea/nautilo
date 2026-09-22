import { describe, expect, test, beforeAll } from "bun:test";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { buildGuestToolPolicy } from "@nautilo/trust";
import { registerAllTools } from "../../src/tools/register-all";
import { createBrowserSnapshotTool } from "../../src/tools/browser/browser-snapshot";
import { createBrowserClickTool } from "../../src/tools/browser/browser-click";
import { createBrowserTypeTool } from "../../src/tools/browser/browser-type";
import { createBrowserPressTool } from "../../src/tools/browser/browser-press";
import { createBrowserReadTool } from "../../src/tools/browser/browser-read";
import { createBrowserReadPageTool } from "../../src/tools/browser/browser-read-page";
import { createBrowserScreenshotTool } from "../../src/tools/browser/browser-screenshot";
import { createBrowserMouseTool } from "../../src/tools/browser/browser-mouse";
import { createBrowserGetTool } from "../../src/tools/browser/browser-get";
import { createBrowserScrollTool } from "../../src/tools/browser/browser-scroll";
import { createBrowserBackTool } from "../../src/tools/browser/browser-back";
import { createBrowserOpenTool } from "../../src/tools/browser/browser-open";
import {
  createBrowserDoubleClickTool,
  createBrowserDragTool,
  createBrowserForwardTool,
  createBrowserHoverTool,
  createBrowserReloadTool,
  createBrowserScrollIntoViewTool,
  createBrowserSelectTool,
  createBrowserSetCheckedTool,
  createBrowserWaitTool,
} from "../../src/tools/browser/browser-native-actions";
import { EMBEDDED_BROWSER_TOOL_NAMES } from "../../src/tools/exposure/manifest";

describe("browser_snapshot tool", () => {
  test("builds with correct name and optional appId schema", () => {
    const tool = createBrowserSnapshotTool();
    expect(tool.name).toBe("browser_snapshot");
    expect(tool.description).toContain(
      "Never use this tool to read a file, document, or workspace artifact listed in the focused-resources prompt",
    );
    expect(tool.schema.shape.appId).toBeDefined();
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ appId: "slack" }).success).toBe(true);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserSnapshotTool();
    expect(tool.invoke({})).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_click tool", () => {
  test("builds with correct name and ref schema", () => {
    const tool = createBrowserClickTool();
    expect(tool.name).toBe("browser_click");
    expect(tool.schema.shape.ref).toBeDefined();
    expect(tool.schema.safeParse({ ref: "@e3" }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserClickTool();
    expect(tool.invoke({ ref: "@e3" })).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_type tool", () => {
  test("builds with ref, text, and optional clear schema", () => {
    const tool = createBrowserTypeTool();
    expect(tool.name).toBe("browser_type");
    expect(tool.schema.shape.ref).toBeDefined();
    expect(tool.schema.shape.text).toBeDefined();
    expect(tool.schema.shape.clear).toBeDefined();
    expect(tool.schema.safeParse({ ref: "@e5", text: "hello" }).success).toBe(true);
    expect(tool.schema.safeParse({ ref: "@e5", text: "hello", clear: true }).success).toBe(
      true,
    );
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserTypeTool();
    expect(tool.invoke({ ref: "@e5", text: "hello" })).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_press tool", () => {
  test("builds with key schema", () => {
    const tool = createBrowserPressTool();
    expect(tool.name).toBe("browser_press");
    expect(tool.schema.shape.key).toBeDefined();
    expect(tool.schema.shape.ref).toBeDefined();
    expect(tool.schema.safeParse({ key: "Enter" }).success).toBe(true);
    expect(tool.schema.safeParse({ key: "Enter", ref: "@e5" }).success).toBe(true);
    expect(tool.schema.safeParse({ key: "Enter", ref: "#search" }).success).toBe(false);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserPressTool();
    expect(tool.invoke({ key: "Tab" })).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_back tool", () => {
  test("builds with an empty schema", () => {
    const tool = createBrowserBackTool();
    expect(tool.name).toBe("browser_back");
    expect(tool.schema.safeParse({}).success).toBe(true);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserBackTool();
    expect(tool.invoke({})).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_open tool", () => {
  test("accepts HTTP(S) URLs and rejects non-web URLs", () => {
    const tool = createBrowserOpenTool();
    expect(tool.name).toBe("browser_open");
    expect(tool.schema.safeParse({ url: "https://example.com/path" }).success).toBe(true);
    expect(tool.schema.safeParse({ url: "http://localhost:7001" }).success).toBe(true);
    expect(tool.schema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(tool.schema.safeParse({ url: "/relative" }).success).toBe(false);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserOpenTool();
    expect(tool.invoke({ url: "https://example.com" })).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_read tool", () => {
  test("builds with ref schema", () => {
    const tool = createBrowserReadTool();
    expect(tool.name).toBe("browser_read");
    expect(tool.schema.shape.ref).toBeDefined();
    expect(tool.schema.safeParse({ ref: "@e7" }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserReadTool();
    expect(tool.invoke({ ref: "@e7" })).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_read_page tool", () => {
  test("builds with bounded maxChars and opaque continuation schema", () => {
    const tool = createBrowserReadPageTool();
    expect(tool.name).toBe("browser_read_page");
    expect(Object.keys(tool.schema.shape)).toEqual(["maxChars", "continuation", "snapshot"]);
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ maxChars: 1 }).success).toBe(true);
    expect(tool.schema.safeParse({ maxChars: 256_000 }).success).toBe(true);
    expect(tool.schema.safeParse({ maxChars: 0 }).success).toBe(false);
    expect(tool.schema.safeParse({ maxChars: 256_001 }).success).toBe(false);
    expect(tool.schema.safeParse({ maxChars: 12.5 }).success).toBe(false);
    const continuation = { version: 1, reference: "a".repeat(43), offsetCharacters: 24_000, mode: "page" as const };
    expect(tool.schema.safeParse({ continuation }).success).toBe(true);
    expect(tool.schema.safeParse({ continuation: { ...continuation, mode: "remainder" } }).success).toBe(true);
    expect(tool.schema.safeParse({ maxChars: 5, continuation: { ...continuation, mode: "remainder" } }).success).toBe(false);
    const find = { version: 1, operation: "find" as const, reference: "b".repeat(43), query: "cyclic imports" };
    const range = { version: 1, operation: "range" as const, reference: "b".repeat(43), offsetCharacters: 21, beforeCharacters: 5, afterCharacters: 10 };
    expect(tool.schema.safeParse({ snapshot: find }).success).toBe(true);
    expect(tool.schema.safeParse({ snapshot: range }).success).toBe(true);
    expect(tool.schema.safeParse({ continuation, snapshot: find }).success).toBe(false);
    expect(tool.schema.safeParse({ maxChars: 5, snapshot: find }).success).toBe(false);
  });

  test("does not expose non-public page-reader controls", () => {
    const tool = createBrowserReadPageTool();
    for (const input of [
      { maxChars: 100, targetRole: "research" },
      { maxChars: 100, selector: "body" },
      { maxChars: 100, session: "session-id" },
      { maxChars: 100, javascript: "document.body.innerText" },
      { maxChars: 100, research: true },
    ]) {
      expect(tool.schema.safeParse(input).success).toBe(false);
    }
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserReadPageTool();
    expect(tool.invoke({})).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_screenshot tool", () => {
  test("builds with optional appId schema", () => {
    const tool = createBrowserScreenshotTool();
    expect(tool.name).toBe("browser_screenshot");
    expect(tool.schema.shape.appId).toBeDefined();
    expect(tool.schema.safeParse({}).success).toBe(true);
  });

  test("exposes visual delegation only in an eligible turn", () => {
    expect(createBrowserScreenshotTool().schema.shape.decisionPlan).toBeUndefined();
    const prior = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "visual-decision-test";
    try {
      const tool = createBrowserScreenshotTool({ turnId: "turn-1", fullEncryptionOnly: false });
      expect(tool.schema.shape.decisionPlan).toBeDefined();
      expect(tool.description).toContain("local visual extractor");
    } finally {
      if (prior === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = prior;
    }
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserScreenshotTool();
    expect(tool.invoke({})).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_mouse tool", () => {
  test("builds with x/y schema and optional space", () => {
    const tool = createBrowserMouseTool();
    expect(tool.name).toBe("browser_mouse");
    expect(tool.schema.shape.x).toBeDefined();
    expect(tool.schema.shape.y).toBeDefined();
    expect(tool.schema.shape.space).toBeDefined();
    expect(tool.schema.safeParse({ x: 100, y: 200 }).success).toBe(true);
    expect(tool.schema.safeParse({ x: 100, y: 200, space: "image" }).success).toBe(true);
    expect(tool.schema.safeParse({ x: 100, y: 200, space: "css" }).success).toBe(true);
    expect(tool.schema.safeParse({ x: 100 }).success).toBe(false);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserMouseTool();
    expect(tool.invoke({ x: 10, y: 20 })).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_get tool", () => {
  test("builds with what/ref/name schema", () => {
    const tool = createBrowserGetTool();
    expect(tool.name).toBe("browser_get");
    expect(tool.schema.shape.what).toBeDefined();
    expect(tool.schema.shape.ref).toBeDefined();
    expect(tool.schema.shape.name).toBeDefined();
    expect(tool.schema.safeParse({ what: "box", ref: "@e2" }).success).toBe(true);
    expect(tool.schema.safeParse({ what: "title" }).success).toBe(true);
    expect(tool.schema.safeParse({ what: "attr", ref: "@e1", name: "href" }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserGetTool();
    expect(tool.invoke({ what: "url" })).rejects.toThrow(/relay tool/i);
  });
});

describe("browser_scroll tool", () => {
  test("builds with direction and optional amount schema", () => {
    const tool = createBrowserScrollTool();
    expect(tool.name).toBe("browser_scroll");
    expect(tool.schema.shape.direction).toBeDefined();
    expect(tool.schema.shape.amount).toBeDefined();
    expect(tool.schema.safeParse({ direction: "down" }).success).toBe(true);
    expect(tool.schema.safeParse({ direction: "up", amount: 300 }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  test("func rejects as relay stub", () => {
    const tool = createBrowserScrollTool();
    expect(tool.invoke({ direction: "down" })).rejects.toThrow(/relay tool/i);
  });
});

describe("native browser action tools", () => {
  test("navigation tools use empty schemas", () => {
    for (const tool of [createBrowserForwardTool(), createBrowserReloadTool()]) {
      expect(tool.schema.safeParse({}).success).toBe(true);
      expect(tool.invoke({})).rejects.toThrow(/relay tool/i);
    }
  });

  test("ref-based pointer and scroll tools validate refs", () => {
    for (const tool of [
      createBrowserHoverTool(),
      createBrowserDoubleClickTool(),
      createBrowserScrollIntoViewTool(),
    ]) {
      expect(tool.schema.safeParse({ ref: "@e3" }).success).toBe(true);
      expect(tool.schema.safeParse({}).success).toBe(false);
    }
    expect(createBrowserDragTool().schema.safeParse({ from: "@e1", to: "@e2" }).success).toBe(
      true,
    );
  });

  test("form controls and wait enforce their native argument shapes", () => {
    const select = createBrowserSelectTool();
    expect(select.schema.safeParse({ ref: "@e1", values: ["one", "two"] }).success).toBe(true);
    expect(select.schema.safeParse({ ref: "@e1", values: [] }).success).toBe(false);

    const checked = createBrowserSetCheckedTool();
    expect(checked.schema.safeParse({ ref: "@e2", checked: true }).success).toBe(true);
    expect(checked.schema.safeParse({ ref: "@e2" }).success).toBe(false);

    const wait = createBrowserWaitTool();
    expect(wait.schema.safeParse({ ref: "@e3" }).success).toBe(true);
    expect(wait.schema.safeParse({ milliseconds: 250 }).success).toBe(true);
    expect(wait.schema.safeParse({}).success).toBe(false);
    expect(wait.schema.safeParse({ ref: "@e3", milliseconds: 250 }).success).toBe(false);
    expect(wait.schema.safeParse({ milliseconds: 30_001 }).success).toBe(false);
  });
});

describe("browser tools catalog registration", () => {
  let catalog: ToolCatalog;

  beforeAll(() => {
    catalog = new ToolCatalog();
    registerAllTools(catalog);
  });

  test("the complete family is core, guest-eligible, relay-owned, and still RBAC-gated", () => {
    // Guest policy reads the process catalog, not the locally constructed instance.
    const previous = getToolCatalog();
    initToolCatalog(catalog);
    try {
      const guestPolicy = buildGuestToolPolicy();
      for (const name of EMBEDDED_BROWSER_TOOL_NAMES) {
        const entry = catalog.get(name);
        expect(entry).toBeDefined();
        expect(entry!.exposure).toBe("core");
        expect(entry!.executor).toBe("relay");
        expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
        expect(entry!.requiresApproval).toBe(false);
        expect(guestPolicy[name]).toBe(entry!.impact === "read-only" ? "read_only" : "allow");
      }
    } finally {
      if (previous) initToolCatalog(previous);
      else clearToolCatalog();
    }
  });

  test("browser tools with page-derived text carry scanInvisibleUnicode:strip through catalog metadata", () => {
    // Regression: the metadata projection (toMetadata) must preserve this flag,
    // or nodes/tools.ts can't strip zero-width chars and live web reads get
    // blocked when document content includes U+200B.
    for (const name of [
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_read",
      "browser_read_page",
      "browser_screenshot",
      "browser_get",
      "browser_scroll",
      "browser_back",
      "browser_open",
      "browser_forward",
      "browser_reload",
      "browser_hover",
      "browser_double_click",
      "browser_drag",
      "browser_select",
      "browser_set_checked",
      "browser_scroll_into_view",
      "browser_wait",
    ]) {
      expect(catalog.get(name)?.scanInvisibleUnicode).toBe("strip");
    }
  });

  test("browser_screenshot requires image model capability", () => {
    const entry = catalog.get("browser_screenshot");
    expect(entry).toBeDefined();
    expect(entry!.requiredModelCapabilities).toEqual(["image"]);
    expect(entry!.scanInvisibleUnicode).toBe("strip");
  });

  test("browser_snapshot registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_snapshot");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
  });

  test("browser_click registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_click");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
    expect(entry!.resultScanPolicy).toBe("on-suspicious");
  });

  test("browser_type registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_type");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
  });

  test("browser_press registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_press");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
  });

  test("browser_read registered as read-only relay tool without approval", () => {
    const entry = catalog.get("browser_read");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("read-only");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
  });

  test("browser_read_page registered as read-only relay tool without approval", () => {
    const entry = catalog.get("browser_read_page");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("read-only");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
    expect(entry!.resultScanPolicy).toBe("on-suspicious");
    expect(entry!.scanInvisibleUnicode).toBe("strip");
  });

  test("browser_screenshot registered as read-only relay tool without approval", () => {
    const entry = catalog.get("browser_screenshot");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("read-only");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
  });

  test("browser_mouse registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_mouse");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
  });

  test("browser_get registered as read-only relay tool without approval", () => {
    const entry = catalog.get("browser_get");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("read-only");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
  });

  test("browser_scroll registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_scroll");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
    expect(entry!.resultScanPolicy).toBe("on-suspicious");
    expect(entry!.scanInvisibleUnicode).toBe("strip");
  });

  test("browser_back registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_back");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
    expect(entry!.resultScanPolicy).toBe("on-suspicious");
    expect(entry!.scanInvisibleUnicode).toBe("strip");
  });

  test("browser_open registered as low-impact relay tool without approval", () => {
    const entry = catalog.get("browser_open");
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe("relay");
    expect(entry!.impact).toBe("low");
    expect(entry!.requiresApproval).toBe(false);
    expect(entry!.requiredCapabilities).toEqual(["control_browser"]);
    expect(entry!.resultScanPolicy).toBe("on-suspicious");
    expect(entry!.scanInvisibleUnicode).toBe("strip");
  });
});
