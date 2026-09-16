import { beforeAll, describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";
import { createHueLightsTool } from "../../src/tools/device/hue-lights";

describe("hue_lights tool", () => {
  test("accepts only its bounded Hue action contract", () => {
    const tool = createHueLightsTool();

    expect(tool.name).toBe("hue_lights");
    expect(tool.schema.safeParse({ action: "discover" }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "setup", bridge: "192.168.1.2", devicetype: "nautilo" }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "list_lights", room: "Kitchen" }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "list_rooms" }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "list_scenes", room: "Living room" }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "set_light", name: "Desk", on: true, brightness: 75, temperature: 270, rgb: [255, 128, 0], transitionTime: 500 }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "set_room", name: "Living room", on: false }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "activate_scene", name: "Warm glow", room: "Living room", dynamic: true }).success).toBe(true);

    expect(tool.schema.safeParse({ action: "set_light", name: "Desk" }).success).toBe(false);
    expect(tool.schema.safeParse({ action: "set_light", name: "Desk", on: true, brightness: 101 }).success).toBe(false);
    expect(tool.schema.safeParse({ action: "set_room", name: "Living room", on: true, temperature: 501 }).success).toBe(false);
    expect(tool.schema.safeParse({ action: "discover", bridge: "192.168.1.2" }).success).toBe(false);
    expect(tool.schema.safeParse({ action: "shell", command: "openhue get light" }).success).toBe(false);
  });

  test("rejects direct invocation as a relay-only stub", () => {
    expect(createHueLightsTool().invoke({ action: "discover" })).rejects.toThrow(/relay tool/i);
  });

  test("instructs Genies to rediscover stale bridges and verify recovery before claiming success", () => {
    const prompt = createHueLightsTool().description;
    expect(prompt).toContain("actively search again with discover");
    expect(prompt).toContain("Prefer a discovered stable .local bridge hostname");
    expect(prompt).toContain("then list_lights to verify before claiming success");
    expect(prompt).toContain("Never blindly replay a failed lighting change");
    expect(prompt).toContain("Before calling setup");
    expect(prompt).toContain("do not wait for the tool result");
    expect(prompt).not.toContain("only after setup has started");
    expect(prompt).toContain("as a last resort");
  });
});

describe("hue_lights catalog registration", () => {
  let catalog: ToolCatalog;

  beforeAll(() => {
    catalog = new ToolCatalog();
    registerAllTools(catalog);
  });

  test("is a low-impact relay tool gated by control_home", () => {
    const entry = catalog.get("hue_lights");

    expect(entry).toBeDefined();
    expect(entry?.executor).toBe("relay");
    expect(entry?.impact).toBe("low");
    expect(entry?.requiresApproval).toBe(false);
    expect(entry?.requiredCapabilities).toEqual(["control_home"]);
    expect(entry?.resultScanPolicy).toBe("on-suspicious");
  });
});
