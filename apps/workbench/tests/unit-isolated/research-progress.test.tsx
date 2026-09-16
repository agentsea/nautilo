import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { ResearchProgress } from "../../src/components/tool-card/research-progress";

test("review percentage follows the current plan and never rounds unfinished work to complete", () => {
  reapplyHappyDomGlobals();
  const view = render(<ResearchProgress progress={{ unitsCompleted: 4, unitsTotal: 15 }} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("27");
  expect(view.container.textContent).toContain("27% of review plan · 4/15 review units complete");
  view.rerender(<ResearchProgress progress={{ unitsCompleted: 4, unitsTotal: 20 }} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
  view.rerender(<ResearchProgress progress={{ unitsCompleted: 999, unitsTotal: 1000 }} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("99");
  view.rerender(<ResearchProgress progress={{ unitsCompleted: 1000, unitsTotal: 1000 }} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  expect(view.container.textContent).toContain("Report review and export are separate");
  view.unmount();
});

test("an absent plan has no fabricated percentage and a known unstarted plan shows zero", () => {
  reapplyHappyDomGlobals();
  const view = render(<ResearchProgress progress={{ unitsCompleted: 0, unitsTotal: 0 }} />);
  expect(view.container.textContent).toBe("Planning review");
  expect(view.queryByRole("progressbar")).toBeNull();
  view.rerender(<ResearchProgress progress={{ unitsCompleted: 0, unitsTotal: 15 }} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  view.unmount();
});
