import { expect, test } from "bun:test";
import { WORKBENCH_APPLICATION_TARGETS } from "../../lib/genie-application-targets";
import { ADMIN_SECTIONS } from "../admin/admin-sections";
import {
  COSTS_ADMIN_RETURN_PATH,
  shouldReturnFromCostsOnEscape,
} from "./costs-page";

test("Costs is an integrated billing-only Admin destination", () => {
  expect(ADMIN_SECTIONS.find((section) => section.id === "costs")).toMatchObject({
    label: "Costs",
    requiresAnyCap: ["manage_billing"],
    catalogueTarget: "admin.costs",
  });
  expect(WORKBENCH_APPLICATION_TARGETS["admin.costs"].availability)
    .toEqual({ anyCapabilities: ["manage_billing"] });
});

test("Costs breadcrumb and Escape return to its Admin section", () => {
  expect(COSTS_ADMIN_RETURN_PATH).toBe("/admin#costs");
  expect(shouldReturnFromCostsOnEscape("Escape", null)).toBeTrue();
  expect(shouldReturnFromCostsOnEscape("Enter", null)).toBeFalse();
  expect(shouldReturnFromCostsOnEscape("Escape", {
    tagName: "INPUT",
    isContentEditable: false,
  })).toBeFalse();
  expect(shouldReturnFromCostsOnEscape("Escape", {
    tagName: "DIV",
    isContentEditable: true,
  })).toBeFalse();
});
