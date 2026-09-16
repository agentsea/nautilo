import { expect, test } from "bun:test";
import { createLaunchCustomizationTool } from "../../src/tools/config/launch-customization";

test("launch_customization persists a Human-clicked recovery without a sentinel", async () => {
  const tool = createLaunchCustomizationTool();
  const result = await tool.invoke({ confirmed: true });
  expect(JSON.parse(result)).toMatchObject({ recovery: { target: "genie.customization", domainTool: "launch_customization" } });
  expect(result).not.toContain("NAUTILO_ACTION:");
});

test("launch_customization refuses unconfirmed requests without recovery", async () => {
  const result = await createLaunchCustomizationTool().invoke({ confirmed: false });
  expect(result).toContain("not sent");
  expect(result).not.toContain("\"recovery\"");
});
