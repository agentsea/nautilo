import { beforeEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { ProviderKeyCoverageTable } from "./provider-key-coverage-table";

const rows = [{ functionality: "Chat", providers: [["surplus", "Surplus"]] }] as const;

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
});

test("keeps the coverage table and provider label stable while status is unknown", () => {
  const view = render(<ProviderKeyCoverageTable rows={rows} configuredProviderIds={new Set()} unknownStatusLabel="Checking coverage…" />);
  expect(view.getByRole("table")).toBeTruthy();
  expect(view.getByText("Surplus").getAttribute("aria-label")).toBe("Surplus: Checking coverage…");
  expect(view.getByRole("img", { name: "Chat: Checking coverage…" })).toBeTruthy();
  expect(view.queryByRole("img", { name: "Chat: no supporting API key configured" })).toBeNull();
  view.rerender(<ProviderKeyCoverageTable rows={rows} configuredProviderIds={new Set(["surplus"])} />);
  expect(view.getByText("Surplus").getAttribute("aria-label")).toBe("Surplus: API key configured");
  expect(view.getByRole("img", { name: "Chat: supporting API key configured" })).toBeTruthy();
});

test("unknown status takes precedence over stale configured evidence", () => {
  const view = render(<ProviderKeyCoverageTable rows={rows} configuredProviderIds={new Set(["surplus"])} unknownStatusLabel="Coverage unavailable" />);
  expect(view.getByText("Surplus").getAttribute("aria-label")).toBe("Surplus: Coverage unavailable");
  expect(view.queryByRole("img", { name: "Chat: supporting API key configured" })).toBeNull();
});
