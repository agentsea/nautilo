import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ServingTransportAttribution } from "./serving-transport-attribution";

beforeEach(reapplyHappyDomGlobals);
afterEach(cleanup);

describe("ServingTransportAttribution", () => {
  test("shows the settled Surplus transport compactly", () => {
    const view = render(<ServingTransportAttribution transport="surplus" />);
    expect(view.getByText("via Surplus")).toBeTruthy();
  });

  test("renders nothing for a direct answer", () => {
    const view = render(<ServingTransportAttribution />);
    expect(view.container.textContent).toBe("");
  });
});
