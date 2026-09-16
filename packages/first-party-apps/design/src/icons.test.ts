import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createDesignIcon } from "./icons";

describe("Design bundled icons", () => {
  test("are decorative and never become an unnamed focus target", () => {
    const document = new Window().document as unknown as Document;
    const icon = createDesignIcon(document, "frame");
    expect(icon.tagName).toBe("svg");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("focusable")).toBe("false");
    expect(icon.getAttribute("stroke")).toBe("currentColor");
  });

  test("an icon plus visible text remains a readable, labelled control", () => {
    const document = new Window().document as unknown as Document;
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Add page");
    button.appendChild(createDesignIcon(document, "plus"));
    button.append("Page");
    expect(button.getAttribute("aria-label")).toBe("Add page");
    expect(button.textContent).toBe("Page");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("includes bundled icon coverage for the top creation bar", () => {
    const document = new Window().document as unknown as Document;
    for (const name of ["select", "shapes", "pen", "connector", "undo", "layers", "more"] as const) {
      expect(createDesignIcon(document, name).querySelectorAll("path").length).toBeGreaterThan(0);
    }
  });

  test("gives every named common shape a distinct bundled icon", () => {
    const document = new Window().document as unknown as Document;
    const names = ["rectangle", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "star", "arrow"] as const;
    const shapes = names.map((name) => createDesignIcon(document, name).innerHTML);
    expect(new Set(shapes).size).toBe(names.length);
  });
});
