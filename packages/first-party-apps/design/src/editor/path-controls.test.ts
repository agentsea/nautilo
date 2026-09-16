import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createNode } from "../scene-graph";
import { penPathToNetwork } from "./pen";
import { editPathNetwork, type PathEdit } from "./path-commands";
import { renderPathControls } from "./path-controls";

function withDocument(run: (window: Window, container: HTMLElement) => void): void {
  const window = new Window();
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
  try {
    run(window, window.document.body as unknown as HTMLElement);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
  }
}

function vectorNode(id = "path") {
  const network = penPathToNetwork({
    anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }],
    closed: true,
  });
  return createNode({ id, type: "vector", parentId: null, x: 0, y: 0, width: 100, height: 100, vectorNetwork: network });
}

test("path controls retain an explicitly chosen point through a command refresh", () => withDocument((window, container) => {
  const node = vectorNode();
  const first = node.vectorNetwork!.vertices[0]!.id;
  const chosen = node.vectorNetwork!.vertices[1]!.id;
  const edits: PathEdit[] = [];
  const render = (): void => {
    container.replaceChildren();
    renderPathControls(container, node, { kind: "vertex", vertexId: first }, (edit) => {
      edits.push(edit);
      render();
    });
  };
  render();
  const point = container.querySelector<HTMLSelectElement>("[data-path-field=vertex]")!;
  point.value = chosen;
  point.dispatchEvent(new window.Event("change") as unknown as Event);
  (container.querySelector<HTMLButtonElement>("[data-path-action=smooth]")!).click();

  expect(edits).toEqual([{ kind: "smooth", vertexId: chosen }]);
  expect(container.querySelector<HTMLSelectElement>("[data-path-field=vertex]")!.value).toBe(chosen);
  expect((window.document.activeElement as unknown as Element | null)?.getAttribute("data-path-action")).toBe("smooth");
}));

test("path controls expose labeled actions and disable operations that are known invalid", () => withDocument((_window, container) => {
  const network = penPathToNetwork({ anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false });
  const node = createNode({ id: "line", type: "vector", parentId: null, x: 0, y: 0, width: 100, height: 1, vectorNetwork: network });
  renderPathControls(container, node, null, () => {});

  expect(container.querySelector("label")?.textContent).toContain("Point");
  expect(container.querySelector<HTMLSelectElement>("[data-path-field=segment]")?.getAttribute("aria-label")).toBe("Segment");
  expect(container.querySelector<HTMLButtonElement>("[data-path-action=delete]")?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>("[data-path-action=smooth]")?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>("[data-path-action=split]")?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>("[data-path-action=add]")?.disabled).toBe(false);
  expect(container.querySelector<HTMLButtonElement>("[data-path-action=join]")?.disabled).toBe(true);
}));

test("path controls reset retained dropdowns when selection switches to a different vector with reused point ids", () => withDocument((window, container) => {
  const first = vectorNode("first-vector");
  const second = vectorNode("second-vector");
  const firstChoice = first.vectorNetwork!.vertices[1]!.id;
  const secondDefault = second.vectorNetwork!.vertices[0]!.id;
  expect(firstChoice).not.toBe(secondDefault);
  expect(firstChoice).toBe(second.vectorNetwork!.vertices[1]!.id);

  renderPathControls(container, first, null, () => {});
  const point = container.querySelector<HTMLSelectElement>("[data-path-field=vertex]")!;
  point.value = firstChoice;
  point.dispatchEvent(new window.Event("change") as unknown as Event);
  container.replaceChildren();
  renderPathControls(container, second, null, () => {});

  expect(container.querySelector<HTMLSelectElement>("[data-path-field=vertex]")!.value).toBe(secondDefault);
}));

test("path controls move focus to Point when a successful join disables Join endpoints", () => withDocument((_window, container) => {
  const network = penPathToNetwork({
    anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }],
    closed: false,
  });
  let node = createNode({ id: "open-path", type: "vector", parentId: null, x: 0, y: 0, width: 100, height: 100, vectorNetwork: network });
  const render = (): void => {
    container.replaceChildren();
    renderPathControls(container, node, null, (edit) => {
      node = { ...node, vectorNetwork: editPathNetwork(node.vectorNetwork!, edit) };
      render();
    });
  };
  render();
  (container.querySelector<HTMLButtonElement>("[data-path-action=join]")!).click();

  expect(node.vectorNetwork!.regions).toHaveLength(1);
  expect(container.querySelector<HTMLButtonElement>("[data-path-action=join]")!.disabled).toBe(true);
  expect((document.activeElement as HTMLSelectElement | null)?.dataset["pathField"]).toBe("vertex");
}));

test("path controls move focus to Point when a successful break disables Break path", () => withDocument((_window, container) => {
  let node = vectorNode("closed-path");
  const selected = { kind: "vertex" as const, vertexId: node.vectorNetwork!.vertices[0]!.id };
  const render = (): void => {
    container.replaceChildren();
    renderPathControls(container, node, selected, (edit) => {
      node = { ...node, vectorNetwork: editPathNetwork(node.vectorNetwork!, edit) };
      render();
    });
  };
  render();
  (container.querySelector<HTMLButtonElement>("[data-path-action=split]")!).click();

  expect(node.vectorNetwork!.regions).toHaveLength(0);
  expect(container.querySelector<HTMLButtonElement>("[data-path-action=split]")!.disabled).toBe(true);
  expect((document.activeElement as HTMLSelectElement | null)?.dataset["pathField"]).toBe("vertex");
}));
