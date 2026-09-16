import type { DesignNode } from "../scene-graph";
import type { PathEdit } from "./path-commands";
import type { VectorPart } from "./vector-edit";

type FocusTarget = "delete" | "smooth" | "corner" | "split" | "add" | "join";

type PathControlState = {
  nodeId: string;
  vertexId?: string;
  segmentId?: string;
  endpointId?: string;
  selectedPartKey?: string;
  restoreFocus?: FocusTarget;
};

const stateByContainer = new WeakMap<HTMLElement, PathControlState>();

function selectedPartKey(selected: VectorPart | null): string | undefined {
  if (!selected) return undefined;
  return selected.kind === "vertex"
    ? `vertex:${selected.vertexId}`
    : `handle:${selected.segmentId}:${selected.end}`;
}

function applySelectedPart(state: PathControlState, selected: VectorPart | null, node: DesignNode): void {
  const key = selectedPartKey(selected);
  if (key === state.selectedPartKey) return;
  if (key === undefined) delete state.selectedPartKey;
  else state.selectedPartKey = key;
  if (selected?.kind === "vertex" && node.vectorNetwork?.vertices.some((point) => point.id === selected.vertexId)) state.vertexId = selected.vertexId;
  if (selected?.kind === "handle" && node.vectorNetwork?.segments.some((segment) => segment.id === selected.segmentId)) state.segmentId = selected.segmentId;
}

function labeledSelect(label: string, field: "vertex" | "segment" | "endpoint"): { row: HTMLLabelElement; select: HTMLSelectElement } {
  const row = document.createElement("label");
  row.className = "design-field design-path-controls__field";
  const text = document.createElement("span");
  text.className = "design-field__label";
  text.textContent = label;
  const select = document.createElement("select");
  select.className = "design-field__input";
  select.dataset["pathField"] = field;
  select.setAttribute("aria-label", label);
  row.append(text, select);
  return { row, select };
}

function appendOptions(select: HTMLSelectElement, options: readonly { id: string; label: string }[], value: string | undefined): void {
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.label;
    select.appendChild(element);
  }
  if (value && options.some((option) => option.id === value)) select.value = value;
  select.disabled = options.length === 0;
}

function isEndpoint(node: DesignNode, vertexId: string): boolean {
  return (node.vectorNetwork?.segments.filter((segment) => segment.startVertexId === vertexId || segment.endVertexId === vertexId).length ?? 0) <= 1;
}

/** Native keyboard controls complement direct anchor dragging. No renderer ids are shown. */
export function renderPathControls(container: HTMLElement, node: DesignNode, selected: VectorPart | null, onEdit: (edit: PathEdit) => void): void {
  const network = node.vectorNetwork;
  if (!network || node.connector) return;
  let state = stateByContainer.get(container);
  if (!state || state.nodeId !== node.id) {
    state = { nodeId: node.id };
  }
  stateByContainer.set(container, state);
  applySelectedPart(state, selected, node);

  const group = document.createElement("fieldset");
  group.className = "design-field-group design-path-controls";
  const legend = document.createElement("legend");
  legend.className = "design-path-controls__legend";
  legend.textContent = "Path points";
  group.appendChild(legend);

  const point = labeledSelect("Point", "vertex");
  appendOptions(point.select, network.vertices.map((vertex, index) => ({ id: vertex.id, label: `Point ${index + 1}` })), state.vertexId);
  group.appendChild(point.row);
  const pointActions = document.createElement("div");
  pointActions.className = "design-path-controls__actions";
  pointActions.setAttribute("aria-label", "Point actions");
  group.appendChild(pointActions);
  const actionButton = (target: FocusTarget, label: string, action: () => PathEdit): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "design-boolean-btn";
    button.dataset["pathAction"] = target;
    button.textContent = label;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      state.restoreFocus = target;
      onEdit(action());
    });
    pointActions.appendChild(button);
    return button;
  };
  const deleteButton = actionButton("delete", "Delete point", () => ({ kind: "delete", vertexId: point.select.value }));
  const smoothButton = actionButton("smooth", "Smooth", () => ({ kind: "smooth", vertexId: point.select.value }));
  const cornerButton = actionButton("corner", "Corner", () => ({ kind: "corner", vertexId: point.select.value }));
  const splitButton = actionButton("split", "Break path", () => ({ kind: "split", vertexId: point.select.value }));

  const segment = labeledSelect("Segment", "segment");
  appendOptions(segment.select, network.segments.map((edge, index) => ({ id: edge.id, label: `Segment ${index + 1}` })), state.segmentId);
  group.appendChild(segment.row);
  const segmentActions = document.createElement("div");
  segmentActions.className = "design-path-controls__actions";
  segmentActions.setAttribute("aria-label", "Segment actions");
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "design-boolean-btn";
  addButton.dataset["pathAction"] = "add";
  addButton.textContent = "Add midpoint";
  addButton.addEventListener("click", () => {
    if (addButton.disabled) return;
    state.restoreFocus = "add";
    onEdit({ kind: "add", segmentId: segment.select.value });
  });
  segmentActions.appendChild(addButton);
  group.appendChild(segmentActions);

  const endpointIds = network.vertices.filter((vertex) => isEndpoint(node, vertex.id)).map((vertex) => vertex.id);
  const endpoint = labeledSelect("Join to", "endpoint");
  appendOptions(endpoint.select, network.vertices
    .map((vertex, index) => ({ id: vertex.id, label: `Point ${index + 1}` }))
    .filter((option) => endpointIds.includes(option.id)), state.endpointId);
  if (!state.endpointId && endpoint.select.options.length > 1) {
    endpoint.select.selectedIndex = 1;
    state.endpointId = endpoint.select.value;
  }
  group.appendChild(endpoint.row);
  const joinActions = document.createElement("div");
  joinActions.className = "design-path-controls__actions";
  joinActions.setAttribute("aria-label", "Join actions");
  const joinButton = document.createElement("button");
  joinButton.type = "button";
  joinButton.className = "design-boolean-btn";
  joinButton.dataset["pathAction"] = "join";
  joinButton.textContent = "Join endpoints";
  joinButton.addEventListener("click", () => {
    if (joinButton.disabled) return;
    state.restoreFocus = "join";
    onEdit({ kind: "join", firstVertexId: point.select.value, secondVertexId: endpoint.select.value });
  });
  joinActions.appendChild(joinButton);
  group.appendChild(joinActions);

  const updateAvailability = (): void => {
    const vertexId = point.select.value;
    const incident = network.segments.filter((edge) => edge.startVertexId === vertexId || edge.endVertexId === vertexId);
    deleteButton.disabled = !vertexId || network.vertices.length <= 2 || incident.length > 2;
    smoothButton.disabled = incident.length !== 2;
    cornerButton.disabled = incident.length === 0;
    splitButton.disabled = incident.length !== 2;
    addButton.disabled = !segment.select.value;
    const endpointsAreDistinct = Boolean(vertexId && endpoint.select.value && vertexId !== endpoint.select.value);
    const alreadyJoined = network.segments.some((edge) =>
      (edge.startVertexId === vertexId && edge.endVertexId === endpoint.select.value)
      || (edge.endVertexId === vertexId && edge.startVertexId === endpoint.select.value));
    joinButton.disabled = !isEndpoint(node, vertexId) || !endpointsAreDistinct || alreadyJoined;
  };
  point.select.addEventListener("change", () => {
    state.vertexId = point.select.value;
    if (endpoint.select.value === point.select.value) {
      const alternative = endpointIds.find((id) => id !== point.select.value);
      if (alternative) {
        endpoint.select.value = alternative;
        state.endpointId = alternative;
      }
    }
    updateAvailability();
  });
  segment.select.addEventListener("change", () => { state.segmentId = segment.select.value; updateAvailability(); });
  endpoint.select.addEventListener("change", () => { state.endpointId = endpoint.select.value; updateAvailability(); });
  updateAvailability();
  container.appendChild(group);
  if (state.restoreFocus) {
    const target = group.querySelector<HTMLButtonElement>(`[data-path-action="${state.restoreFocus}"]`);
    delete state.restoreFocus;
    if (target && !target.disabled) target.focus();
    else point.select.focus();
  }
}
