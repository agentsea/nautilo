import {
  IDENTITY_GROUP_TRANSFORM,
  applyGroupTransformMatrix,
  composeGroupMatrix,
  computeConnectorFrame,
  groupToTransform,
  type Element,
  type Frame,
  type GroupTransform,
  type SlidesDocument,
} from "../engine/node.js";

export class SlideConnectorReconciliationError extends Error {
  readonly code = "singular_connector_parent";
  readonly phase = "reconcile_derived_geometry";
  readonly stateChanged = false;
  readonly retrySafe = false;
}

function sameFrame(left: Frame, right: Frame): boolean {
  return left.x === right.x && left.y === right.y && left.w === right.w
    && left.h === right.h && left.rotation === right.rotation;
}

/** Express the slide-wide element lookup in one connector parent's space. */
function inverse(transform: GroupTransform): GroupTransform {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (determinant === 0 || !Number.isFinite(determinant)) {
    throw new SlideConnectorReconciliationError("cannot reconcile changed connector geometry inside a singular group transform");
  }
  return {
    a: transform.d / determinant,
    b: -transform.b / determinant,
    c: -transform.c / determinant,
    d: transform.a / determinant,
    tx: -(transform.d * transform.tx - transform.c * transform.ty) / determinant,
    ty: (transform.b * transform.tx - transform.a * transform.ty) / determinant,
    rotation: -transform.rotation,
  };
}

/** Build every target directly in the connector parent's coordinates. */
function lookupInParentSpace(
  elements: readonly Element[],
  connectorParentToWorld: GroupTransform,
): ReadonlyMap<string, Element> {
  const result = new Map<string, Element>();
  const worldToConnectorParent = inverse(connectorParentToWorld);
  const visit = (items: readonly Element[], elementParentToWorld: GroupTransform): void => {
    const relative = composeGroupMatrix(worldToConnectorParent, elementParentToWorld);
    for (const element of items) {
      result.set(element.id, {
        ...element,
        frame: applyGroupTransformMatrix(element.frame, relative),
      } as Element);
      if (element.type === "group") {
        visit(element.data.children, composeGroupMatrix(elementParentToWorld, groupToTransform(element)));
      }
    }
  };
  visit(elements, IDENTITY_GROUP_TRANSFORM);
  return result;
}

type ConnectorLocation = {
  connector: Extract<Element, { type: "connector" }>;
  path: string;
  parentToWorld: GroupTransform;
};

type ElementLocation = {
  element: Element;
  parentToWorld: GroupTransform;
};

function elementLocations(elements: readonly Element[]): Map<string, ElementLocation> {
  const result = new Map<string, ElementLocation>();
  const visit = (items: readonly Element[], parentToWorld: GroupTransform): void => {
    for (const element of items) {
      result.set(element.id, { element, parentToWorld });
      if (element.type === "group") {
        visit(element.data.children, composeGroupMatrix(parentToWorld, groupToTransform(element)));
      }
    }
  };
  visit(elements, IDENTITY_GROUP_TRANSFORM);
  return result;
}

/** Only fields consulted by the current native connector path computation. */
function geometrySignature(
  location: ConnectorLocation,
  locations: ReadonlyMap<string, ElementLocation>,
): string {
  const { connector, parentToWorld } = location;
  const targets = [connector.start, connector.end].map((endpoint) => {
    if (endpoint.kind !== "attached") return null;
    const target = locations.get(endpoint.elementId);
    if (!target) return { missing: endpoint.elementId };
    return {
      type: target.element.type,
      frame: target.element.frame,
      shapeKind: target.element.type === "shape" ? target.element.data.kind : null,
      parentToWorld: target.parentToWorld,
    };
  });
  return JSON.stringify({
    parentToWorld,
    routing: connector.routing,
    start: connector.start,
    end: connector.end,
    elbowBend: connector.elbowBend,
    curveBend: connector.curveBend,
    strokeWidth: connector.stroke?.width,
    targets,
  });
}

function connectorLocations(
  elements: SlidesDocument["slides"][number]["elements"],
  prefix: string,
  parentToWorld: GroupTransform = IDENTITY_GROUP_TRANSFORM,
): ConnectorLocation[] {
  const result: ConnectorLocation[] = [];
  elements.forEach((element, index) => {
    const path = `${prefix}/${index}`;
    if (element.type === "group") {
      result.push(...connectorLocations(
        element.data.children,
        `${path}/data/children`,
        composeGroupMatrix(parentToWorld, groupToTransform(element)),
      ));
    } else if (element.type === "connector") {
      result.push({ connector: element, path, parentToWorld });
    }
  });
  return result;
}

/**
 * Refresh connector frame caches after an authored transaction. Frames are
 * derived in each connector's immediate parent coordinate space. Existing
 * stale caches remain byte-for-byte unchanged when their rendered geometry did
 * not change during this transaction.
 */
export function reconcileAuthoredConnectors(
  source: SlidesDocument,
  document: SlidesDocument,
): string[] {
  const changed: string[] = [];
  for (const [slideIndex, slide] of document.slides.entries()) {
    const previous = source.slides.find((candidate) => candidate.id === slide.id);
    const priorLocations = previous ? elementLocations(previous.elements) : new Map<string, ElementLocation>();
    const currentLocations = elementLocations(slide.elements);
    const priorConnectors = previous ? connectorLocations(previous.elements, "") : [];
    const priorById = new Map(priorConnectors.map((location) => [location.connector.id, location]));
    for (const location of connectorLocations(slide.elements, `/slides/${slideIndex}/elements`)) {
      const { connector, path, parentToWorld } = location;
      const prior = priorById.get(connector.id);
      if (prior && sameFrame(prior.connector.frame, connector.frame)
        && geometrySignature(prior, priorLocations) === geometrySignature(location, currentLocations)) continue;
      const desired = computeConnectorFrame(connector, lookupInParentSpace(slide.elements, parentToWorld));
      if (!sameFrame(desired, connector.frame)) {
        connector.frame = desired;
        changed.push(`${path}/frame`);
      }
    }
  }
  return changed;
}
