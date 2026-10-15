import { expect, test } from "bun:test";
import { callTypeLabel } from "./costs-view-model";

test("labels image assistance as image understanding", () => {
  expect(callTypeLabel("image_assistance")).toBe("Image understanding");
});
